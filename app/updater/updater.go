package updater

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// 默认 3 次 retry
const defaultMaxRetries = 3

// defaultHTTPTimeout HTTP 请求单次超时
const defaultHTTPTimeout = 30 * time.Second

// UpdaterConfig 启动 updater 所需的所有外部依赖。
type UpdaterConfig struct {
	// RunningVersion 当前运行版本（编译期注入 main.version）
	RunningVersion string
	// Channel 发布通道（"stable" 单一通道，v0.8.0 不做 canary）
	Channel string
	// CacheDir 缓存目录（一般是 ${dataDir}/updates/）
	CacheDir string
	// HTTPClient 注入的 http.Client（v0.8.0 不复用 token，所以默认 client 即可）
	HTTPClient *http.Client
	// Logger slog-like logger（v0.8.0 暂用 println 兜底，Phase 7 接入 slog）
	Logger func(level, format string, args ...any)
	// OpenBrowser 打开浏览器到指定 URL（macOS 未签名 build 走这条路径）
	OpenBrowser func(url string) error
	// Progress 下载/校验进度回调（phase: downloading/verifying/downloaded/error；
	//                            received/total 字节数；err 非空表示错误）
	//
	// 接收方：app_updater_app.go 把这个回调桥接到 wruntime.EventsEmit(ctx, "updater:progress", ...)
	//        前端 UpdateBanner.vue 订阅 Wails 'updater:progress' 事件更新进度条。
	Progress func(phase string, received, total int64, errMsg string)
}

// Updater 是 v0.8.0 自动更新的核心 orchestrator。
//
// 单一实例（App 持有），非线程安全——所有 Wails binding 调用都通过 Wails 主 loop 串行化。
type Updater struct {
	cfg UpdaterConfig
	hc  *http.Client
}

// New 创建 Updater 实例。RunningVersion 为空时（如 dev build）所有 Check 返 Available=false。
func New(cfg UpdaterConfig) *Updater {
	if cfg.Channel == "" {
		cfg.Channel = "stable"
	}
	if cfg.HTTPClient == nil {
		cfg.HTTPClient = &http.Client{Timeout: defaultHTTPTimeout}
	}
	if cfg.Logger == nil {
		cfg.Logger = func(level, format string, args ...any) {}
	}
	if cfg.OpenBrowser == nil {
		cfg.OpenBrowser = defaultOpenBrowser
	}
	return &Updater{cfg: cfg, hc: cfg.HTTPClient}
}

// UpdateInfo 是返回给前端的"是否有新版本"信息。
type UpdateInfo struct {
	Available     bool   `json:"available"`
	Current       string `json:"current"`
	Latest        string `json:"latest"`
	Notes         string `json:"notes,omitempty"`
	Channel       string `json:"channel"`
	CanSelfUpdate bool   `json:"canSelfUpdate"`
	ManualOnly    bool   `json:"manualOnly,omitempty"`
	ManualReason  string `json:"manualReason,omitempty"`
	DownloadURL   string `json:"downloadUrl,omitempty"`
	AssetSize     int64  `json:"assetSize,omitempty"`
	// Downloaded 表示本地缓存里已有这个版本的安装包（重启后可直接 install）
	Downloaded bool `json:"downloaded"`
	// Err 内部错误（前端拿来显示人话）
	Err string `json:"err,omitempty"`
}

// UpdateDownloadResult 下载完成结果（前端用来显示文件大小、SHA256、缓存路径）。
type UpdateDownloadResult struct {
	Version  string `json:"version"`
	Channel  string `json:"channel"`
	Platform string `json:"platform"`
	Path     string `json:"path"`
	Size     int64  `json:"size"`
	SHA256   string `json:"sha256"`
}

// downloadedRecord 是缓存元信息（写到 ${CacheDir}/downloaded.json）。
type downloadedRecord struct {
	Version      string `json:"version"`
	Channel      string `json:"channel"`
	Platform     string `json:"platform"`
	Path         string `json:"path"`
	Size         int64  `json:"size"`
	SHA256       string `json:"sha256"`
	DownloadedAt string `json:"downloadedAt"`
}

// Check 拉取 latest manifest，跟 running version 比较，返 UpdateInfo（不下载）。
func (u *Updater) Check(ctx context.Context) (*UpdateInfo, error) {
	info := &UpdateInfo{
		Current: u.cfg.RunningVersion,
		Channel: u.cfg.Channel,
	}

	// dev build 不提示
	if NormalizeVersion(u.cfg.RunningVersion) == "" {
		info.Err = "dev build 不提示更新"
		return info, nil
	}

	m, err := u.fetchLatestManifest(ctx)
	if err != nil {
		info.Err = err.Error()
		u.cfg.Logger("warn", "update: manifest fetch failed: %v", err)
		return info, nil // 不报错给前端，静默降级
	}

	info.Latest = m.Version
	info.Notes = m.Notes

	cmp := CompareVersion(u.cfg.RunningVersion, m.Version)
	if cmp >= 0 {
		info.Available = false
		return info, nil
	}

	// 有新版本 — 找当前平台的 asset
	plat := CurrentPlatform()
	asset, ok := m.Assets[plat]
	if !ok {
		info.Available = true // 仍标记 available，让用户手动去 release 页
		info.ManualOnly = true
		info.ManualReason = fmt.Sprintf("当前平台 %s 没有预编译安装包", plat)
		return info, nil
	}

	info.Available = true
	info.DownloadURL = asset.URL
	info.AssetSize = asset.Size
	info.CanSelfUpdate = u.canSelfUpdate()
	if !info.CanSelfUpdate {
		info.ManualOnly = true
		info.ManualReason = u.manualUpdateReason()
	}

	// 检查缓存
	if rec, err := u.readDownloadedRecord(m.Version, u.cfg.Channel, plat); err == nil {
		if _, statErr := os.Stat(rec.Path); statErr == nil {
			info.Downloaded = true
		}
	}

	return info, nil
}

// Download 流式下载最新 manifest 对应当前平台的 asset 到 ${CacheDir}/，下载 .sig 校验通过后写到 downloaded.json。
//
// 调用方需确保 Check 已经返回 Available=true。
func (u *Updater) Download(ctx context.Context) (*UpdateDownloadResult, error) {
	info, err := u.Check(ctx)
	if err != nil {
		return nil, err
	}
	if !info.Available {
		return nil, fmt.Errorf("%w: no update available", ErrManifestFetch)
	}
	if info.ManualOnly {
		return nil, fmt.Errorf("%w: %s", ErrManualUpdateOnly, info.ManualReason)
	}

	m, err := u.fetchLatestManifest(ctx)
	if err != nil {
		u.emitProgress("error", 0, 0, err.Error())
		return nil, err
	}

	plat := CurrentPlatform()
	asset, ok := m.Assets[plat]
	if !ok {
		err := &ErrNoAssetForPlatform{Platform: plat}
		u.emitProgress("error", 0, 0, err.Error())
		return nil, err
	}

	if err := os.MkdirAll(u.cfg.CacheDir, 0o755); err != nil {
		err := fmt.Errorf("%w: %v", ErrPermissionDenied, err)
		u.emitProgress("error", 0, 0, err.Error())
		return nil, err
	}

	assetName := AssetFilename(m.Version, plat)
	destPath := filepath.Join(u.cfg.CacheDir, assetName)

	// emit downloading start
	u.emitProgress("downloading", 0, asset.Size, "")

	body, err := u.downloadWithRetry(ctx, asset.URL, 0, asset.Size)
	if err != nil {
		err := fmt.Errorf("%w: %v", ErrDownloadFailed, err)
		u.emitProgress("error", 0, asset.Size, err.Error())
		return nil, err
	}

	// emit downloading complete
	u.emitProgress("downloading", int64(len(body)), asset.Size, "")

	// 二次 SHA256 校验（manifest 里没有就跳过——plan 文档允许 SHA256 字段可选）
	if asset.SHA256 != "" {
		if err := VerifySHA256(body, asset.SHA256); err != nil {
			u.emitProgress("error", int64(len(body)), asset.Size, err.Error())
			return nil, err
		}
	}

	// 算 SHA256 落盘后做记录
	sum := sha256.Sum256(body)
	sumHex := hex.EncodeToString(sum[:])

	// emit verifying
	u.emitProgress("verifying", int64(len(body)), asset.Size, "")

	// 拉签名 + ed25519 校验
	sigURL := asset.URL + ".sig"
	sig, err := u.downloadWithRetry(ctx, sigURL, 0, ed25519SignatureSize)
	if err != nil {
		err := fmt.Errorf("%w: signature fetch: %v", ErrDownloadFailed, err)
		u.emitProgress("error", int64(len(body)), asset.Size, err.Error())
		return nil, err
	}
	if err := Verify(body, sig); err != nil {
		u.emitProgress("error", int64(len(body)), asset.Size, err.Error())
		return nil, err
	}

	// 原子写
	if err := writeFileAtomic(destPath, body, 0o755); err != nil {
		err := fmt.Errorf("%w: %v", ErrPermissionDenied, err)
		u.emitProgress("error", int64(len(body)), asset.Size, err.Error())
		return nil, err
	}

	rec := downloadedRecord{
		Version:      m.Version,
		Channel:      u.cfg.Channel,
		Platform:     plat,
		Path:         destPath,
		Size:         int64(len(body)),
		SHA256:       sumHex,
		DownloadedAt: time.Now().UTC().Format(time.RFC3339),
	}
	if err := u.writeDownloadedRecord(rec); err != nil {
		u.cfg.Logger("warn", "update: save record failed: %v", err)
	}

	// emit downloaded
	u.emitProgress("downloaded", int64(len(body)), asset.Size, "")

	return &UpdateDownloadResult{
		Version:  rec.Version,
		Channel:  rec.Channel,
		Platform: rec.Platform,
		Path:     rec.Path,
		Size:     rec.Size,
		SHA256:   rec.SHA256,
	}, nil
}

// emitProgress 转发给 UpdaterConfig.Progress；nil safe。
func (u *Updater) emitProgress(phase string, received, total int64, errMsg string) {
	if u.cfg.Progress != nil {
		u.cfg.Progress(phase, received, total, errMsg)
	}
}

// Install 把缓存的 binary 应用到当前平台。
func (u *Updater) Install() error {
	plat := CurrentPlatform()
	rec, err := u.readDownloadedRecord("", u.cfg.Channel, plat)
	if err != nil {
		return fmt.Errorf("%w: no cached update: %v", ErrApplyFailed, err)
	}

	if _, err := os.Stat(rec.Path); err != nil {
		return fmt.Errorf("%w: cached file missing: %v", ErrApplyFailed, err)
	}

	switch runtime.GOOS {
	case "windows":
		return u.applyWindows(rec.Path)
	case "darwin":
		return u.applyMacOS(rec.Path)
	default:
		return fmt.Errorf("%w: %s", ErrUnsupportedOS, runtime.GOOS)
	}
}

// OpenDownloadPage 打开浏览器到 GitHub release 页面（未签名 macOS build 走这条）。
func (u *Updater) OpenDownloadPage() error {
	url := GitHubReleasePageURL
	return u.cfg.OpenBrowser(url)
}

// canSelfUpdate 当前平台是否支持自动 in-place apply。
//
// v0.8.0 规则：
//   - Windows: 支持
//   - macOS: 不支持（未签名 build；签名+notarize 后会变成 true）
func (u *Updater) canSelfUpdate() bool {
	switch runtime.GOOS {
	case "windows":
		return true
	case "darwin":
		// 真实判断需要 build tag（v0.8.0 暂用 stub，签名发布时由 maintainer 改）
		return false
	default:
		return false
	}
}

// manualUpdateReason macOS 未签名 build 的可读原因。
func (u *Updater) manualUpdateReason() string {
	switch runtime.GOOS {
	case "darwin":
		return "macOS build 未签名+notarize，请手动前往 GitHub release 页下载"
	default:
		return ""
	}
}

// fetchLatestManifest 调 GitHub releases/latest 端点。
//
// ⚠️ v0.8.0 stub：用 owner/repo 写死为本仓库。Phase 5 cmd/sign 工具和 CI 发版脚本会同步这个 owner/repo。
func (u *Updater) fetchLatestManifest(ctx context.Context) (*Manifest, error) {
	url := GitHubLatestReleaseAPI
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrManifestFetch, err)
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "gitea-kanban-updater/0.8")

	resp, err := u.hc.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrManifestFetch, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%w: status %d", ErrManifestFetch, resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrManifestFetch, err)
	}

	var raw struct {
		TagName     string `json:"tag_name"`
		Body        string `json:"body"`
		PublishedAt string `json:"published_at"`
		Assets      []struct {
			Name               string `json:"name"`
			BrowserDownloadURL string `json:"browser_download_url"`
			Size               int64  `json:"size"`
		} `json:"assets"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrManifestParse, err)
	}

	m := &Manifest{
		Version: NormalizeVersion(raw.TagName),
		Notes:   raw.Body,
		PubDate: raw.PublishedAt,
		Assets:  map[string]Asset{},
	}
	for _, a := range raw.Assets {
		// 从 asset name 推断 platform key（约定：gitea-kanban-v0.8.0-windows-amd64.exe）
		pk, ok := extractPlatformFromAssetName(a.Name)
		if !ok {
			continue
		}
		m.Assets[pk] = Asset{
			URL:    a.BrowserDownloadURL,
			Size:   a.Size,
			SigURL: a.BrowserDownloadURL + ".sig",
		}
	}
	if m.Version == "" {
		return nil, fmt.Errorf("%w: empty tag_name", ErrManifestParse)
	}
	return m, nil
}

// downloadWithRetry HTTP GET with retry + Range 续传 + size cap.
//
// start 是已下载字节数（0 = 全量下载）。
func (u *Updater) downloadWithRetry(ctx context.Context, url string, start int64, maxSize int64) ([]byte, error) {
	var lastErr error
	for attempt := 1; attempt <= defaultMaxRetries; attempt++ {
		body, err := u.downloadOnce(ctx, url, start, maxSize)
		if err == nil {
			return body, nil
		}
		lastErr = err
		u.cfg.Logger("warn", "update: download attempt %d/%d failed: %v", attempt, defaultMaxRetries, err)
		time.Sleep(time.Duration(attempt) * time.Second)
	}
	return nil, lastErr
}

func (u *Updater) downloadOnce(ctx context.Context, url string, start, maxSize int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	if start > 0 {
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-", start))
	}
	resp, err := u.hc.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusPartialContent {
		return nil, fmt.Errorf("status %d", resp.StatusCode)
	}

	// size cap 防 OOM
	limited := io.LimitReader(resp.Body, maxSize+1)
	body, err := io.ReadAll(limited)
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > maxSize && maxSize > 0 {
		return nil, fmt.Errorf("size exceeded: got %d, cap %d", len(body), maxSize)
	}
	return body, nil
}

// readDownloadedRecord 读缓存元信息。version 为空时返最近一个匹配 channel+platform 的记录。
func (u *Updater) readDownloadedRecord(version, channel, platform string) (*downloadedRecord, error) {
	path := filepath.Join(u.cfg.CacheDir, "downloaded.json")
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var records []downloadedRecord
	if err := json.Unmarshal(data, &records); err != nil {
		return nil, err
	}
	// 倒序匹配：最新的优先
	for i := len(records) - 1; i >= 0; i-- {
		r := records[i]
		if r.Channel != channel || r.Platform != platform {
			continue
		}
		if version != "" && r.Version != version {
			continue
		}
		return &r, nil
	}
	return nil, fmt.Errorf("no matching record")
}

func (u *Updater) writeDownloadedRecord(rec downloadedRecord) error {
	path := filepath.Join(u.cfg.CacheDir, "downloaded.json")
	var records []downloadedRecord
	if data, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(data, &records)
	}
	records = append(records, rec)
	body, err := json.MarshalIndent(records, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(path, body, 0o644)
}

// --- 平台 apply 函数 ---

// applyWindows in-place replace + restart-helper.cmd 避开文件锁。
func (u *Updater) applyWindows(newBinaryPath string) error {
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("%w: %v", ErrApplyFailed, err)
	}
	exeDir := filepath.Dir(exe)
	exeName := filepath.Base(exe)

	newPath := filepath.Join(exeDir, exeName+".new")
	bakPath := filepath.Join(exeDir, exeName+".bak")
	helperPath := filepath.Join(exeDir, "restart-helper.cmd")

	body, err := os.ReadFile(newBinaryPath)
	if err != nil {
		return fmt.Errorf("%w: read new: %v", ErrApplyFailed, err)
	}
	if err := writeFileAtomic(newPath, body, 0o755); err != nil {
		return fmt.Errorf("%w: %v", ErrApplyFailed, err)
	}

	// 备份当前
	currentBody, err := os.ReadFile(exe)
	if err != nil {
		return fmt.Errorf("%w: read current: %v", ErrApplyFailed, err)
	}
	if err := writeFileAtomic(bakPath, currentBody, 0o755); err != nil {
		return fmt.Errorf("%w: backup: %v", ErrApplyFailed, err)
	}

	// 写 restart helper
	helper := fmt.Sprintf(`@echo off
timeout /t 1 /nobreak >nul
move /Y "%s" "%s"
start "" "%s"
del "%s"
`, newPath, exe, exe, helperPath)
	if err := writeFileAtomic(helperPath, []byte(helper), 0o644); err != nil {
		return fmt.Errorf("%w: helper: %v", ErrApplyFailed, err)
	}

	// detach helper 后 exit
	cmd := exec.Command("cmd", "/c", "start", "", helperPath)
	_ = cmd.Start()
	os.Exit(0)
	return nil // unreachable
}

// applyMacOS 未签名 build 直接返 manual update error，签名后改 in-place replace。
func (u *Updater) applyMacOS(newBinaryPath string) error {
	// v0.8.0 暂不支持自动 in-place（需要签名 + notarize 才能让 .app 内 binary 替换生效）
	if !u.canSelfUpdate() {
		return fmt.Errorf("%w: %s", ErrManualUpdateOnly, u.manualUpdateReason())
	}
	// 签名+notarize 后这里实现：
	// 1. 拿 .app/Contents/MacOS/gitea-kanban 路径
	// 2. 写新 binary 到 .app/Contents/MacOS/gitea-kanban.new
	// 3. rename 覆盖
	// 4. exec.Command(os.Executable()) relaunch + os.Exit(0)
	return fmt.Errorf("%w: macOS in-place not yet implemented", ErrApplyFailed)
}

// --- helpers ---

// extractPlatformFromAssetName 从 "gitea-kanban-v0.8.0-windows-amd64.exe" 提取 "windows-amd64"。
func extractPlatformFromAssetName(name string) (string, bool) {
	const prefix = "gitea-kanban-"
	if !strings.HasPrefix(name, prefix) {
		return "", false
	}
	rest := strings.TrimPrefix(name, prefix)
	// 去掉扩展名
	if idx := strings.LastIndex(rest, "."); idx > 0 {
		rest = rest[:idx]
	}
	// rest 形如 "v0.8.0-windows-amd64"
	idx := strings.Index(rest, "-")
	if idx < 0 {
		return "", false
	}
	// 跳过 "vX.Y.Z-" 前缀
	afterVer := rest[idx+1:]
	if !strings.HasPrefix(rest, "v") {
		return "", false
	}
	// afterVer 现在是 "windows-amd64" 或 "darwin-arm64"
	return afterVer, true
}

func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, perm); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func defaultOpenBrowser(url string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	return cmd.Start()
}

// --- 常量 ---

// ed25519SignatureSize ed25519 detached signature 固定 64 字节。
const ed25519SignatureSize = 64

// GitHubLatestReleaseAPI owner/repo 写死为本仓库；Phase 5 CI / cmd/sign 工具同步。
const GitHubLatestReleaseAPI = "https://api.github.com/repos/July-X/gitea-kanban/releases/latest"

// GitHubReleasePageURL 同上。
const GitHubReleasePageURL = "https://github.com/July-X/gitea-kanban/releases/latest"

// 抑制 unused 警告
var _ = errors.New
