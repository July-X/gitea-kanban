// Package sign 提供 ed25519 key gen + sign + manifest 生成逻辑。
//
// 拆分原因（review_report follow-up）：原 cmd/sign/main.go 把 sub-command 路由
// 和核心加密/签名逻辑混在 main 包，TestGenkeySignRoundtrip 因 sub-command 路由
// 难以 unit test 而 SKIP。重构后：
//   - EncryptPrivateKey / DecryptPrivateKey 内部函数（package 级，可测试）
//   - SignFile / BuildManifest 高层函数（package 级，可测试）
//   - cmd/sign/main.go 只负责 flag 解析 + 调用本包函数（薄壳）
package sign

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"golang.org/x/crypto/argon2"
)

const (
	// argon2id 参数（推荐值）
	argonTime    = 2
	argonMemory  = 64 * 1024 // 64 MiB
	argonThreads = 1
	argonKeyLen  = 32 // AES-256
	aesNonceSize = 12
	saltSize     = 16
)

// EncryptPrivateKey 把 ed25519 私钥用密码加密（argon2id + aes-256-gcm）。
//
// 输出格式：salt(16) || nonce(12) || ciphertext 的 base64。
func EncryptPrivateKey(priv ed25519.PrivateKey, password string) (string, error) {
	salt := make([]byte, saltSize)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key := argon2.IDKey([]byte(password), salt, argonTime, argonMemory, argonThreads, argonKeyLen)

	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, aesNonceSize)
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}

	ciphertext := gcm.Seal(nil, nonce, priv, nil)
	out := append(salt, nonce...)
	out = append(out, ciphertext...)
	return base64.StdEncoding.EncodeToString(out), nil
}

// DecryptPrivateKey 解密 EncryptPrivateKey 输出。
//
// 错误密码返 ErrWrongPassword（不 panic）。
func DecryptPrivateKey(blob string, password string) (ed25519.PrivateKey, error) {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(blob))
	if err != nil {
		return nil, err
	}
	if len(raw) < saltSize+aesNonceSize+ed25519.PrivateKeySize {
		return nil, errors.New("private key blob too short")
	}
	salt := raw[:saltSize]
	nonce := raw[saltSize : saltSize+aesNonceSize]
	ciphertext := raw[saltSize+aesNonceSize:]

	key := argon2.IDKey([]byte(password), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	plain, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrWrongPassword, err)
	}
	if len(plain) != ed25519.PrivateKeySize {
		return nil, fmt.Errorf("plain size mismatch: %d", len(plain))
	}
	return ed25519.PrivateKey(plain), nil
}

// SignFile 读 assetPath 二进制，用 priv 算 ed25519 detached signature。
//
// 返回 64 字节签名。
func SignFile(priv ed25519.PrivateKey, assetPath string) ([]byte, error) {
	body, err := readFile(assetPath)
	if err != nil {
		return nil, err
	}
	return ed25519.Sign(priv, body), nil
}

// WriteSignature 把签名写到 assetPath + ".sig"。
func WriteSignature(assetPath string, sig []byte) error {
	return writeFileAtomic(assetPath+".sig", sig, 0o644)
}

// ManifestEntry 是 latest.json 的结构。
type ManifestEntry struct {
	Version string                   `json:"version"`
	Notes   string                   `json:"notes,omitempty"`
	Assets  map[string]ManifestAsset `json:"assets"`
}

// ManifestAsset 是单个平台的 asset 元信息。
type ManifestAsset struct {
	URL    string `json:"url"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

// BuildManifest 从 assets 列表聚合 latest.json。
//
// repoSlug 默认 "July-X/gitea-kanban"（cmd/sign default 走这个）。
func BuildManifest(version, notes, repoSlug string, assets []string) (*ManifestEntry, error) {
	m := &ManifestEntry{
		Version: version,
		Notes:   notes,
		Assets:  map[string]ManifestAsset{},
	}
	for _, assetPath := range assets {
		body, err := readFile(assetPath)
		if err != nil {
			return nil, err
		}
		sum := sha256.Sum256(body)
		platformKey, ok := ExtractPlatformFromAssetName(basename(assetPath))
		if !ok {
			continue
		}
		url := fmt.Sprintf("https://github.com/%s/releases/download/%s/%s",
			repoSlug, version, basename(assetPath))
		m.Assets[platformKey] = ManifestAsset{
			URL:    url,
			Size:   int64(len(body)),
			SHA256: hex.EncodeToString(sum[:]),
		}
	}
	return m, nil
}

// MarshalManifest 序列化 manifest 为 JSON bytes。
func MarshalManifest(m *ManifestEntry) ([]byte, error) {
	return json.MarshalIndent(m, "", "  ")
}

// ExtractPlatformFromAssetName 从 "gitea-kanban-v0.8.0-windows-amd64.exe" 提取 "windows-amd64"。
func ExtractPlatformFromAssetName(name string) (string, bool) {
	const prefix = "gitea-kanban-"
	if !strings.HasPrefix(name, prefix) {
		return "", false
	}
	rest := strings.TrimPrefix(name, prefix)
	if idx := strings.LastIndex(rest, "."); idx > 0 {
		rest = rest[:idx]
	}
	if !strings.HasPrefix(rest, "v") {
		return "", false
	}
	if idx := strings.Index(rest, "-"); idx >= 0 {
		return rest[idx+1:], true
	}
	return "", false
}

// --- 错误 ---

// ErrWrongPassword 解密失败（密码不对）。
var ErrWrongPassword = errors.New("sign: wrong password")

// --- io helpers ---

func readFile(path string) ([]byte, error) {
	f, err := openFile(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(f)
}

func writeFileAtomic(path string, data []byte, perm uint32) error {
	tmp := path + ".tmp"
	if err := writeFileFull(tmp, data, perm); err != nil {
		return err
	}
	return renameFile(tmp, path)
}

// --- io helpers (注入点，default 用 os 实现，测试时可 mock) ---

var (
	openFile      = osOpen
	writeFileFull = osWriteFile
	renameFile    = osRename
)

func osOpen(path string) (io.ReadCloser, error) { return osOpenImpl(path) }
func osWriteFile(path string, data []byte, perm uint32) error {
	return osWriteFileImpl(path, data, perm)
}
func osRename(oldPath, newPath string) error { return osRenameImpl(oldPath, newPath) }

func basename(path string) string {
	for i := len(path) - 1; i >= 0; i-- {
		if path[i] == '/' || path[i] == '\\' {
			return path[i+1:]
		}
	}
	return path
}
