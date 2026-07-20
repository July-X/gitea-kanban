package updater

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func contextBackground() context.Context { return context.Background() }

// TestNormalizeVersion 测试 semver 规范化。
func TestNormalizeVersion(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"", ""},
		{"dev", ""},
		{"DEV", ""},
		{"debug", ""},
		{"DEBUG", ""},
		{"  ", ""},
		{"0.8.0", "v0.8.0"},
		{"v0.8.0", "v0.8.0"},
		{"  v0.8.0  ", "v0.8.0"},
		{"v0.8.0-rc1", "v0.8.0-rc1"},
	}
	for _, c := range cases {
		got := NormalizeVersion(c.in)
		if got != c.want {
			t.Errorf("NormalizeVersion(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// TestCompareVersion 测试版本比较。
func TestCompareVersion(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"v0.8.0", "v0.8.0", 0},
		{"v0.8.0", "v0.8.1", -1},
		{"v0.8.1", "v0.8.0", 1},
		{"v0.9.0", "v0.8.99", 1},
		{"v1.0.0", "v0.99.99", 1},
		{"v0.8.0-rc1", "v0.8.0", -1}, // pre-release < release
		{"v0.8.0", "v0.8.0-rc1", 1},
		{"v0.8.0-rc1", "v0.8.0-rc2", -1},
		{"v0.8.0-rc10", "v0.8.0-rc2", -1}, // 字典序：'1' < '2'，所以 rc10 < rc2
		{"dev", "v0.8.0", 0},              // dev 不可比较
		{"", "v0.8.0", 0},
	}
	for _, c := range cases {
		got := CompareVersion(c.a, c.b)
		if got != c.want {
			t.Errorf("CompareVersion(%q, %q) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}

// TestPlatformKey 测试 platform key 格式。
func TestPlatformKey(t *testing.T) {
	cases := []struct {
		goos, goarch, want string
	}{
		{"windows", "amd64", "windows-amd64"},
		{"windows", "arm64", "windows-arm64"},
		{"darwin", "amd64", "darwin-amd64"},
		{"darwin", "arm64", "darwin-arm64"},
		{"darwin", "universal", "darwin-universal"},
	}
	for _, c := range cases {
		got := PlatformKey(c.goos, c.goarch)
		if got != c.want {
			t.Errorf("PlatformKey(%q, %q) = %q, want %q", c.goos, c.goarch, got, c.want)
		}
	}
}

// TestAssetFilename 测试安装包文件名拼接。
func TestAssetFilename(t *testing.T) {
	if got := AssetFilename("v0.8.0", "windows-amd64"); got != "gitea-kanban-v0.8.0-windows-amd64.exe" {
		t.Errorf("windows: got %q", got)
	}
	if got := AssetFilename("v0.8.0", "darwin-arm64"); got != "gitea-kanban-v0.8.0-darwin-arm64.zip" {
		t.Errorf("darwin: got %q", got)
	}
}

// TestSignatureFilename 测试签名文件名。
func TestSignatureFilename(t *testing.T) {
	if got := SignatureFilename("gitea-kanban-v0.8.0-windows-amd64.exe"); got != "gitea-kanban-v0.8.0-windows-amd64.exe.sig" {
		t.Errorf("got %q", got)
	}
}

// TestExtractPlatformFromAssetName 测试从 asset name 反推 platform key。
func TestExtractPlatformFromAssetName(t *testing.T) {
	cases := []struct {
		name string
		want string
		ok   bool
	}{
		{"gitea-kanban-v0.8.0-windows-amd64.exe", "windows-amd64", true},
		{"gitea-kanban-v0.8.0-darwin-arm64.zip", "darwin-arm64", true},
		{"gitea-kanban-v0.8.0-darwin-universal.zip", "darwin-universal", true},
		{"random-file.txt", "", false},
		{"gitea-kanban-v0.8.0.zip", "", false},
	}
	for _, c := range cases {
		got, ok := extractPlatformFromAssetName(c.name)
		if got != c.want || ok != c.ok {
			t.Errorf("extractPlatformFromAssetName(%q) = (%q, %v), want (%q, %v)", c.name, got, ok, c.want, c.ok)
		}
	}
}

// TestEvaluateRunningAndLatest 测 Check 在 running=latest / running<latest 时的行为。
func TestEvaluateRunningAndLatest(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tag_name":     "v0.8.0",
			"body":         "release notes",
			"published_at": time.Now().Format(time.RFC3339),
			"assets": []map[string]any{
				{
					"name":                 "gitea-kanban-v0.8.0-" + CurrentPlatform() + ".exe",
					"browser_download_url": "http://example.com/asset",
					"size":                 int64(1024),
				},
			},
		})
	}))
	defer srv.Close()

	t.Run("running=latest available=false", func(t *testing.T) {
		u := &Updater{
			cfg: UpdaterConfig{
				RunningVersion: "v0.8.0",
				Channel:        "stable",
				CacheDir:       t.TempDir(),
				HTTPClient:     srv.Client(),
				Logger:         func(string, string, ...any) {},
			},
			hc: srv.Client(),
		}
		info, err := u.checkFromAPI(srv.URL + "/releases/latest")
		if err != nil {
			t.Fatalf("checkFromAPI: %v", err)
		}
		if info.Available {
			t.Errorf("expected available=false (running=latest), got true")
		}
		if info.Latest != "v0.8.0" {
			t.Errorf("latest = %q", info.Latest)
		}
	})

	t.Run("running<latest available=true", func(t *testing.T) {
		u := &Updater{
			cfg: UpdaterConfig{
				RunningVersion: "v0.7.0",
				Channel:        "stable",
				CacheDir:       t.TempDir(),
				HTTPClient:     srv.Client(),
				Logger:         func(string, string, ...any) {},
			},
			hc: srv.Client(),
		}
		info, err := u.checkFromAPI(srv.URL + "/releases/latest")
		if err != nil {
			t.Fatalf("checkFromAPI: %v", err)
		}
		if !info.Available {
			t.Errorf("expected available=true (running<latest), got false")
		}
		if info.Latest != "v0.8.0" {
			t.Errorf("latest = %q", info.Latest)
		}
	})

	t.Run("dev build returns no available", func(t *testing.T) {
		u := &Updater{
			cfg: UpdaterConfig{
				RunningVersion: "dev",
				Channel:        "stable",
				CacheDir:       t.TempDir(),
				HTTPClient:     srv.Client(),
				Logger:         func(string, string, ...any) {},
			},
			hc: srv.Client(),
		}
		info, err := u.checkFromAPI(srv.URL + "/releases/latest")
		if err != nil {
			t.Fatalf("checkFromAPI: %v", err)
		}
		if info.Available {
			t.Errorf("dev build should never be available")
		}
	})
}

// TestFetchManifestMock httptest mock GitHub API 解析。
func TestFetchManifestMock(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tag_name":     "v0.9.0",
			"body":         "v0.9.0 release",
			"published_at": "2026-07-12T00:00:00Z",
			"assets": []map[string]any{
				{
					"name":                 "gitea-kanban-v0.9.0-windows-amd64.exe",
					"browser_download_url": "https://example.com/win.exe",
					"size":                 int64(1024 * 1024),
				},
				{
					"name":                 "gitea-kanban-v0.9.0-darwin-arm64.zip",
					"browser_download_url": "https://example.com/mac.zip",
					"size":                 int64(2048 * 1024),
				},
			},
		})
	}))
	defer srv.Close()

	u := &Updater{cfg: UpdaterConfig{Logger: func(string, string, ...any) {}}, hc: srv.Client()}
	m, err := u.fetchFromURL(srv.URL)
	if err != nil {
		t.Fatalf("fetchFromURL: %v", err)
	}
	if m.Version != "v0.9.0" {
		t.Errorf("Version = %q", m.Version)
	}
	if m.Notes != "v0.9.0 release" {
		t.Errorf("Notes = %q", m.Notes)
	}
	if len(m.Assets) != 2 {
		t.Fatalf("Assets len = %d, want 2", len(m.Assets))
	}
	if m.Assets["windows-amd64"].URL != "https://example.com/win.exe" {
		t.Errorf("win URL = %q", m.Assets["windows-amd64"].URL)
	}
	if m.Assets["darwin-arm64"].URL != "https://example.com/mac.zip" {
		t.Errorf("mac URL = %q", m.Assets["darwin-arm64"].URL)
	}
}

// TestDownloadVerifyMock mock asset+sig URL，成功 / 篡改 sig → 失败。
func TestDownloadVerifyMock(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	fakeBinary := []byte("fake binary content for testing")
	sig := ed25519.Sign(priv, fakeBinary)

	var sigHit int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, ".sig") {
			sigHit++
			if sigHit == 1 {
				_, _ = w.Write(sig)
			} else {
				_, _ = w.Write([]byte("tampered signature bytes that are too short to be valid"))
			}
			return
		}
		_, _ = w.Write(fakeBinary)
	}))
	defer srv.Close()

	origPub := PublicKey
	PublicKey = pub
	defer func() { PublicKey = origPub }()

	t.Run("valid signature passes Verify", func(t *testing.T) {
		gotSig, err := downloadOnceForTest(srv.Client(), srv.URL+"/asset.sig")
		if err != nil {
			t.Fatalf("download: %v", err)
		}
		if err := Verify(fakeBinary, gotSig); err != nil {
			t.Errorf("Verify: %v", err)
		}
	})

	t.Run("tampered signature fails Verify", func(t *testing.T) {
		gotSig, err := downloadOnceForTest(srv.Client(), srv.URL+"/asset.sig")
		if err != nil {
			t.Fatalf("download sig: %v", err)
		}
		if err := Verify(fakeBinary, gotSig); !errors.Is(err, ErrSignatureInvalid) {
			t.Errorf("expected ErrSignatureInvalid, got %v", err)
		}
	})
}

// TestCanSelfUpdate 平台判断。
func TestCanSelfUpdate(t *testing.T) {
	u := &Updater{cfg: UpdaterConfig{}}
	if u.canSelfUpdate() != (runtime.GOOS == "windows") {
		t.Errorf("canSelfUpdate = %v, want %v", u.canSelfUpdate(), runtime.GOOS == "windows")
	}
}

// TestManualUpdateReason 返回可读原因。
func TestManualUpdateReason(t *testing.T) {
	u := &Updater{cfg: UpdaterConfig{}}
	reason := u.manualUpdateReason()
	if runtime.GOOS == "darwin" {
		if !strings.Contains(reason, "macOS") {
			t.Errorf("macOS reason should mention macOS, got %q", reason)
		}
	}
	if runtime.GOOS == "windows" {
		if reason != "" {
			t.Errorf("windows reason should be empty, got %q", reason)
		}
	}
}

// TestApplyWindowsMock 写 new.exe + .bak + restart-helper.cmd（windows-only）。
func TestApplyWindowsMock(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("windows-only test")
	}
	// 因 os.Exit(0) 在 applyWindows 末尾触发，测试只覆盖 writeFileAtomic 层面
	dir := t.TempDir()
	src := filepath.Join(dir, "new-source.bin")
	if err := os.WriteFile(src, []byte("new binary content"), 0o644); err != nil {
		t.Fatalf("write src: %v", err)
	}
	body, err := os.ReadFile(src)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	dest := filepath.Join(dir, "gitea-kanban.exe.new")
	if err := writeFileAtomic(dest, body, 0o755); err != nil {
		t.Fatalf("write atomic: %v", err)
	}
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if string(got) != "new binary content" {
		t.Errorf("got %q", got)
	}
}

// TestApplyMacOSSkipped 未签名 macOS 应走 manual update error。
func TestApplyMacOSSkipped(t *testing.T) {
	u := &Updater{cfg: UpdaterConfig{Logger: func(string, string, ...any) {}}}
	dir := t.TempDir()
	src := filepath.Join(dir, "fake.zip")
	if err := os.WriteFile(src, []byte("fake"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	if runtime.GOOS == "darwin" {
		err := u.applyMacOS(src)
		if !errors.Is(err, ErrManualUpdateOnly) {
			t.Errorf("expected ErrManualUpdateOnly on darwin, got %v", err)
		}
	} else {
		err := u.applyMacOS(src)
		if !errors.Is(err, ErrApplyFailed) {
			t.Errorf("expected ErrApplyFailed on non-darwin, got %v", err)
		}
	}
}

// TestCacheInvalidOnChannelOrPlatformChange 缓存失效逻辑。
func TestCacheInvalidOnChannelOrPlatformChange(t *testing.T) {
	dir := t.TempDir()
	u := &Updater{cfg: UpdaterConfig{CacheDir: dir, Channel: "stable", Logger: func(string, string, ...any) {}}}

	rec1 := downloadedRecord{
		Version:      "v0.8.0",
		Channel:      "stable",
		Platform:     "windows-amd64",
		Path:         "/some/path",
		Size:         1024,
		SHA256:       "abc",
		DownloadedAt: time.Now().Format(time.RFC3339),
	}
	if err := u.writeDownloadedRecord(rec1); err != nil {
		t.Fatalf("write rec1: %v", err)
	}

	// 1. 同 channel 同 platform 返 rec1
	got, err := u.readDownloadedRecord("v0.8.0", "stable", "windows-amd64")
	if err != nil {
		t.Fatalf("read same: %v", err)
	}
	if got.Version != "v0.8.0" {
		t.Errorf("version mismatch: %q", got.Version)
	}

	// 2. 不同 channel 返错
	_, err = u.readDownloadedRecord("v0.8.0", "canary", "windows-amd64")
	if err == nil {
		t.Errorf("different channel should not match")
	}

	// 3. 不同 platform 返错
	_, err = u.readDownloadedRecord("v0.8.0", "stable", "darwin-arm64")
	if err == nil {
		t.Errorf("different platform should not match")
	}

	// 4. 不同 version 返错
	_, err = u.readDownloadedRecord("v0.8.1", "stable", "windows-amd64")
	if err == nil {
		t.Errorf("different version should not match")
	}
}

// TestRetryOnTransientError httptest 第一次 500 → 第二次 200。
func TestRetryOnTransientError(t *testing.T) {
	var attempts int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		if attempts == 1 {
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		_, _ = w.Write([]byte("success"))
	}))
	defer srv.Close()

	u := &Updater{
		cfg: UpdaterConfig{Logger: func(string, string, ...any) {}},
		hc:  &http.Client{Timeout: 5 * time.Second},
	}
	body, err := u.downloadWithRetry(contextBackground(), srv.URL+"/test", 0, 1024)
	if err != nil {
		t.Fatalf("downloadWithRetry: %v", err)
	}
	if string(body) != "success" {
		t.Errorf("body = %q", string(body))
	}
	if attempts != 2 {
		t.Errorf("attempts = %d, want 2", attempts)
	}
}

// TestVerifySHA256 SHA256 校验。
func TestVerifySHA256(t *testing.T) {
	body := []byte("test content")
	sum := sha256.Sum256(body)
	sumHex := hex.EncodeToString(sum[:])
	if err := VerifySHA256(body, sumHex); err != nil {
		t.Errorf("same SHA should pass: %v", err)
	}
	if err := VerifySHA256(body, ""); err != nil {
		t.Errorf("empty SHA should skip: %v", err)
	}
	if err := VerifySHA256(body, "wronghex"); !errors.Is(err, ErrSHA256Mismatch) {
		t.Errorf("wrong SHA should fail: %v", err)
	}
}

// TestPublicKeyInvalid 未配置公钥时 Verify 返 ErrPublicKeyInvalid。
func TestPublicKeyInvalid(t *testing.T) {
	origPub := PublicKey
	PublicKey = ed25519.PublicKey(make([]byte, ed25519.PublicKeySize))
	defer func() { PublicKey = origPub }()

	err := Verify([]byte("x"), []byte("y"))
	if !errors.Is(err, ErrPublicKeyInvalid) {
		t.Errorf("expected ErrPublicKeyInvalid, got %v", err)
	}
}

// TestErrNoAssetForPlatform 自定义错误类型断言。
func TestErrNoAssetForPlatform(t *testing.T) {
	err := &ErrNoAssetForPlatform{Platform: "linux-amd64"}
	if !IsNoAssetForPlatform(err) {
		t.Errorf("IsNoAssetForPlatform should be true")
	}
	if !strings.Contains(err.Error(), "linux-amd64") {
		t.Errorf("error msg should mention platform")
	}
	if IsNoAssetForPlatform(errors.New("other")) {
		t.Errorf("other err should not match")
	}
}

// --- helpers ---

// fetchFromURL 是 fetchLatestManifest 的 URL 可变版本，方便测试。
func (u *Updater) fetchFromURL(url string) (*Manifest, error) {
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := u.hc.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, ErrManifestFetch
	}
	const maxBytes = 16 * 1024 * 1024
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBytes))
	if err != nil {
		return nil, err
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
		return nil, err
	}
	m := &Manifest{
		Version: NormalizeVersion(raw.TagName),
		Notes:   raw.Body,
		PubDate: raw.PublishedAt,
		Assets:  map[string]Asset{},
	}
	for _, a := range raw.Assets {
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
	return m, nil
}

// checkFromAPI 是 Check 的 URL 可变版本。
func (u *Updater) checkFromAPI(apiURL string) (*UpdateInfo, error) {
	info := &UpdateInfo{
		Current: u.cfg.RunningVersion,
		Channel: u.cfg.Channel,
	}
	if NormalizeVersion(u.cfg.RunningVersion) == "" {
		return info, nil
	}
	m, err := u.fetchFromURL(apiURL)
	if err != nil {
		info.Err = err.Error()
		return info, nil
	}
	info.Latest = m.Version
	info.Notes = m.Notes
	cmp := CompareVersion(u.cfg.RunningVersion, m.Version)
	if cmp >= 0 {
		info.Available = false
		return info, nil
	}
	info.Available = true
	plat := CurrentPlatform()
	if asset, ok := m.Assets[plat]; ok {
		info.DownloadURL = asset.URL
		info.AssetSize = asset.Size
	}
	info.CanSelfUpdate = u.canSelfUpdate()
	if !info.CanSelfUpdate {
		info.ManualOnly = true
		info.ManualReason = u.manualUpdateReason()
	}
	return info, nil
}

func downloadOnceForTest(client *http.Client, url string) ([]byte, error) {
	resp, err := client.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, errors.New("status " + http.StatusText(resp.StatusCode))
	}
	const maxBytes = 16 * 1024 * 1024
	return io.ReadAll(io.LimitReader(resp.Body, maxBytes))
}
