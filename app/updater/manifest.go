// Package updater 实现应用自动更新能力（v0.8.0 引入）。
//
// 设计目标：
//   - manifest 拉取：GitHub release API 作唯一源（single source of truth）
//   - 签名校验：ed25519 detached signature（Go 标准库 crypto/ed25519，零新依赖）
//   - 断点续传下载：HTTP Range header + 3 次 retry + IPv4/IPv6 fallback
//   - 分平台安装：Windows in-place + restart-helper.cmd；macOS 未签名走 OpenDownloadPage，签名后 in-place
//   - 零术语：UI 文案走「更新 / 下载 / 安装」，内部 manifest/signature/canary 等概念不外泄
//
// 架构参考 ~/2026/code/DeepSeek-Reasonix/desktop/updater.go（manifest.go + verify.go + apply），
// 简化部署：去掉 R2/crash gateway fallback，仅用 GitHub release 作源；签名方案改 ed25519（更简洁）。
package updater

import (
	"encoding/base64"
	"fmt"
	"runtime"
	"strings"
)

// Manifest 是从 GitHub release API 解析出来的"最新版本"信息。
//
// 字段命名刻意对齐 GitHub API 原生 camelCase，方便 json.Unmarshal 直接映射。
type Manifest struct {
	Version string           `json:"tag_name"` // 例如 "v0.8.0"；也可 "0.8.0"
	Notes   string           `json:"body"`     // release notes（markdown）
	PubDate string           `json:"published_at"`
	Assets  map[string]Asset `json:"-"` // Assets 由独立解析路径填充（GitHub API 没这个聚合结构）
}

// Asset 是单个平台的安装包下载信息。
type Asset struct {
	URL    string `json:"browser_download_url"`
	Size   int64  `json:"size"`
	SHA256 string `json:"-"` // 由 separate .sha256 文件加载；manifest 里没有
	Sig    []byte `json:"-"` // 由 separate .sig 文件加载
	SigURL string `json:"-"` // 计算得出（URL + ".sig"）
}

// PlatformKey 返回平台标识符，例如 "windows-amd64" / "darwin-arm64" / "darwin-universal"。
//
// v0.8.0 仅考虑 Windows + macOS 双平台（明文排除 Linux）。
func PlatformKey(goos, goarch string) string {
	return goos + "-" + goarch
}

// CurrentPlatform 返回当前 runtime 对应的平台 key。
func CurrentPlatform() string {
	return PlatformKey(runtime.GOOS, runtime.GOARCH)
}

// NormalizeVersion 把 "0.8.0" 补成 "v0.8.0"，把 "  v0.8.0  " trim 空白。
// dev build 返空字符串（"dev" / "" / "DEBUG" 都视为 dev）。
func NormalizeVersion(v string) string {
	v = strings.TrimSpace(v)
	if v == "" || strings.EqualFold(v, "dev") || strings.EqualFold(v, "debug") {
		return ""
	}
	if !strings.HasPrefix(v, "v") {
		v = "v" + v
	}
	return v
}

// CompareVersion 比较两个 semver 字符串。
// 返 -1 表示 a < b，0 表示 a == b，1 表示 a > b。
// 任何一方为 dev/空字符串 → 返 0（不可比较）。
func CompareVersion(a, b string) int {
	a = NormalizeVersion(a)
	b = NormalizeVersion(b)
	if a == "" || b == "" {
		return 0
	}
	as := strings.TrimPrefix(a, "v")
	bs := strings.TrimPrefix(b, "v")

	aBase, aSuffix := splitVersionSuffix(as)
	bBase, bSuffix := splitVersionSuffix(bs)

	if cmp := compareBaseVersion(aBase, bBase); cmp != 0 {
		return cmp
	}
	return compareSuffix(aSuffix, bSuffix)
}

func splitVersionSuffix(v string) (base, suffix string) {
	if i := strings.Index(v, "-"); i >= 0 {
		return v[:i], v[i+1:]
	}
	return v, ""
}

func compareBaseVersion(a, b string) int {
	ap := strings.Split(a, ".")
	bp := strings.Split(b, ".")
	n := len(ap)
	if len(bp) > n {
		n = len(bp)
	}
	for i := 0; i < n; i++ {
		var ai, bi int
		if i < len(ap) {
			ai = parseIntOrZero(ap[i])
		}
		if i < len(bp) {
			bi = parseIntOrZero(bp[i])
		}
		if ai < bi {
			return -1
		}
		if ai > bi {
			return 1
		}
	}
	return 0
}

func parseIntOrZero(s string) int {
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0
		}
		n = n*10 + int(c-'0')
	}
	return n
}

func compareSuffix(a, b string) int {
	if a == "" && b == "" {
		return 0
	}
	if a == "" {
		return 1 // release > pre-release
	}
	if b == "" {
		return -1
	}
	return strings.Compare(a, b)
}

// EncodePublicKey 把 ed25519 公钥编码成 base64（用于 verify.go 常量嵌入）。
func EncodePublicKey(pub []byte) string {
	return base64.StdEncoding.EncodeToString(pub)
}

// DecodePublicKey 反向。
func DecodePublicKey(s string) ([]byte, error) {
	return base64.StdEncoding.DecodeString(s)
}

// AssetFilename 由 manifest + platform 推断期望的安装包文件名。
//
// 期望命名约定：
//   - gitea-kanban-v0.8.0-windows-amd64.exe
//   - gitea-kanban-v0.8.0-darwin-arm64.zip（macOS universal 用 zip 装 .app）
//   - gitea-kanban-v0.8.0-darwin-universal.zip
func AssetFilename(version, platformKey string) string {
	base := "gitea-kanban-" + version + "-" + platformKey
	if strings.HasPrefix(platformKey, "windows-") {
		return base + ".exe"
	}
	return base + ".zip"
}

// SignatureFilename 由安装包文件名 + ".sig" 得到签名文件名。
func SignatureFilename(assetName string) string {
	return assetName + ".sig"
}

// ErrNoAssetForPlatform 当前 manifest 没有匹配当前平台的 asset。
type ErrNoAssetForPlatform struct {
	Platform string
}

func (e *ErrNoAssetForPlatform) Error() string {
	return fmt.Sprintf("no asset for platform %s in manifest", e.Platform)
}

// IsNoAssetForPlatform 检查 err 是否为 ErrNoAssetForPlatform。
func IsNoAssetForPlatform(err error) bool {
	_, ok := err.(*ErrNoAssetForPlatform)
	return ok
}
