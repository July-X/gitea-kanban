package sign

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"strings"
	"testing"
)

// TestEncryptDecryptRoundtrip 验证 argon2id + aes-256-gcm 加密/解密 round-trip。
func TestEncryptDecryptRoundtrip(t *testing.T) {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	password := "test-password-123"
	blob, err := EncryptPrivateKey(priv, password)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	if blob == "" {
		t.Fatal("blob is empty")
	}

	got, err := DecryptPrivateKey(blob, password)
	if err != nil {
		t.Fatalf("decrypt with correct password: %v", err)
	}
	if !bytes.Equal(got, priv) {
		t.Error("decrypted key doesn't match original")
	}

	if _, err := DecryptPrivateKey(blob, "wrong-password"); !errors.Is(err, ErrWrongPassword) {
		t.Errorf("wrong password: want errors.Is(err, ErrWrongPassword), got %v", err)
	}

	tampered := strings.Replace(blob, "A", "B", 1)
	if len(tampered) == len(blob) {
		tampered = blob[:len(blob)-4] + "AAAA"
	}
	if _, err := DecryptPrivateKey(tampered, password); !errors.Is(err, ErrWrongPassword) {
		t.Errorf("tampered ciphertext: want errors.Is(err, ErrWrongPassword), got %v", err)
	}

	// 非 Base64 输入也必须返 ErrWrongPassword（不区分"格式错"vs"密码错"）
	if _, err := DecryptPrivateKey("not-base64-!@#$%", password); !errors.Is(err, ErrWrongPassword) {
		t.Errorf("invalid base64: want errors.Is(err, ErrWrongPassword), got %v", err)
	}

	// blob 过短也必须返 ErrWrongPassword
	if _, err := DecryptPrivateKey("AAAA", password); !errors.Is(err, ErrWrongPassword) {
		t.Errorf("blob too short: want errors.Is(err, ErrWrongPassword), got %v", err)
	}
}

// TestSignFileAndVerifyRoundtrip 验证 SignFile → ed25519.Verify round-trip。
func TestSignFileAndVerifyRoundtrip(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}

	tmp := t.TempDir()
	assetPath := tmp + "/gitea-kanban-v0.8.0-windows-amd64.exe"
	if err := writeFileFull(assetPath, []byte("fake gitea-kanban binary"), 0o644); err != nil {
		t.Fatalf("write asset: %v", err)
	}

	sig, err := SignFile(priv, assetPath)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	if len(sig) != ed25519.SignatureSize {
		t.Errorf("signature size = %d, want %d", len(sig), ed25519.SignatureSize)
	}

	if err := WriteSignature(assetPath, sig); err != nil {
		t.Fatalf("write sig: %v", err)
	}

	// 验证：读 asset + sig 文件，ed25519.Verify
	body, err := readFile(assetPath)
	if err != nil {
		t.Fatalf("read asset: %v", err)
	}
	gotSig, err := readFile(assetPath + ".sig")
	if err != nil {
		t.Fatalf("read sig: %v", err)
	}
	if !ed25519.Verify(pub, body, gotSig) {
		t.Error("Verify should pass with correct signature")
	}

	// 篡改 binary → Verify fail
	if ed25519.Verify(pub, []byte("tampered"), gotSig) {
		t.Error("Verify should fail with tampered binary")
	}
}

// TestGenkeySignManifestRoundtrip 完整 genkey → sign → manifest end-to-end（sub-command 路径）。
//
// 这是 review_report 提的「TestGenkeySignRoundtrip 仍 SKIP」修复——重构 sign 为
// 内部 package 后，sub-command 的核心逻辑（EncryptPrivateKey → DecryptPrivateKey →
// SignFile → BuildManifest → MarshalManifest）全部 unit-testable。
func TestGenkeySignManifestRoundtrip(t *testing.T) {
	// 1. genkey
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	password := "round-trip-pwd"

	// 2. encrypt private key + write to disk (模拟 runGenkey)
	blob, err := EncryptPrivateKey(priv, password)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}

	tmp := t.TempDir()
	assetPath := tmp + "/gitea-kanban-v0.8.0-darwin-arm64.zip"
	otherAssetPath := tmp + "/gitea-kanban-v0.8.0-windows-amd64.exe"
	assetContent := []byte("fake binary content for round-trip")
	if err := writeFileFull(assetPath, assetContent, 0o644); err != nil {
		t.Fatalf("write asset: %v", err)
	}
	if err := writeFileFull(otherAssetPath, []byte("other fake"), 0o644); err != nil {
		t.Fatalf("write other: %v", err)
	}

	// 3. sign 2 assets (模拟 runSign)
	decoded, err := DecryptPrivateKey(blob, password)
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	for _, p := range []string{assetPath, otherAssetPath} {
		sig, err := SignFile(decoded, p)
		if err != nil {
			t.Fatalf("sign %s: %v", p, err)
		}
		if err := WriteSignature(p, sig); err != nil {
			t.Fatalf("write sig %s: %v", p, err)
		}
	}

	// 4. build manifest (模拟 runManifest)
	m, err := BuildManifest("v0.8.0", "release notes", "July-X/gitea-kanban", []string{assetPath, otherAssetPath})
	if err != nil {
		t.Fatalf("build manifest: %v", err)
	}
	if m.Version != "v0.8.0" {
		t.Errorf("Version = %q", m.Version)
	}
	if _, ok := m.Assets["darwin-arm64"]; !ok {
		t.Errorf("missing darwin-arm64")
	}
	if _, ok := m.Assets["windows-amd64"]; !ok {
		t.Errorf("missing windows-amd64")
	}

	// 5. marshal
	out, err := MarshalManifest(m)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(out), `"darwin-arm64"`) {
		t.Error("manifest JSON missing darwin-arm64")
	}

	// 6. final verify：用公钥校验两个 asset 签名
	for _, p := range []string{assetPath, otherAssetPath} {
		body, _ := readFile(p)
		sig, _ := readFile(p + ".sig")
		if !ed25519.Verify(pub, body, sig) {
			t.Errorf("Verify failed for %s", p)
		}
	}

	_ = pub // 已经在 step 6 用了
}

// TestExtractPlatformFromAssetName 测试 asset name 解析。
func TestExtractPlatformFromAssetName(t *testing.T) {
	cases := []struct {
		name string
		want string
		ok   bool
	}{
		{"gitea-kanban-v0.8.0-windows-amd64.exe", "windows-amd64", true},
		{"gitea-kanban-v0.8.0-darwin-arm64.zip", "darwin-arm64", true},
		{"gitea-kanban-v0.8.0-darwin-universal.zip", "darwin-universal", true},
		{"random.txt", "", false},
		{"gitea-kanban-v0.8.0.zip", "", false},
	}
	for _, c := range cases {
		got, ok := ExtractPlatformFromAssetName(c.name)
		if got != c.want || ok != c.ok {
			t.Errorf("ExtractPlatformFromAssetName(%q) = (%q, %v), want (%q, %v)",
				c.name, got, ok, c.want, c.ok)
		}
	}
}
