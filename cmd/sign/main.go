// cmd/sign —— v0.8.0 自动更新签名 / 公钥生成 CLI
//
// 用法（CI / maintainer 本地）：
//
//	# 1. 生成 ed25519 key pair（一次性）
//	go run ./cmd/sign genkey ./keys
//	# 产出：./keys/gitea-kanban-public.b64  （嵌入 verify.go 常量）
//	#       ./keys/gitea-kanban-private.b64 （加密存 CI secret）
//
//	# 2. 对 release asset 签名
//	go run ./cmd/sign sign \
//	  --key ./keys/private.b64 \
//	  --password "$SIGN_PASSWORD" \
//	  ./build/bin/gitea-kanban-windows-amd64.exe \
//	  ./build/bin/gitea-kanban-darwin-arm64.zip
//	# 产出：每个 asset 同名 .sig 文件
//
//	# 3. 生成 manifest（latest.json）
//	go run ./cmd/sign manifest \
//	  --version v0.8.0 \
//	  --notes docs/releases/v0.8.0.md \
//	  ./build/bin/gitea-kanban-windows-amd64.exe \
//	  ./build/bin/gitea-kanban-darwin-arm64.zip \
//	  > ./build/bin/latest.json
//
// 设计：
//   - 私钥加密：aes-256-gcm（密码用 argon2id 派生 32 字节 key）
//   - 私钥文件格式：salt(16) || nonce(12) || ciphertext（base64）
//   - 公钥格式：纯 ed25519.PublicKey 32 字节（base64）
package main

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
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
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

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(1)
	}
	cmd := os.Args[1]
	args := os.Args[2:]

	switch cmd {
	case "genkey":
		os.Exit(runGenkey(args))
	case "sign":
		os.Exit(runSign(args))
	case "manifest":
		os.Exit(runManifest(args))
	default:
		fmt.Fprintf(os.Stderr, "unknown subcommand: %s\n", cmd)
		usage()
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintf(os.Stderr, "usage: sign <subcommand> [args]\n\nsubcommands:\n  genkey <out-dir>                  生成 ed25519 key pair\n  sign --key <key> --password <pwd> <asset>...\n  manifest --version <ver> --notes <file> <asset>...\n")
}

// --- genkey ---

func runGenkey(args []string) int {
	fs := flag.NewFlagSet("genkey", flag.ExitOnError)
	password := fs.String("password", "", "private key encryption password (required)")
	fs.Parse(args)
	if *password == "" {
		fmt.Fprintln(os.Stderr, "ERROR: --password required")
		return 1
	}
	if fs.NArg() < 1 {
		fmt.Fprintln(os.Stderr, "ERROR: output dir required")
		return 1
	}
	outDir := fs.Arg(0)
	if err := os.MkdirAll(outDir, 0o700); err != nil {
		fmt.Fprintln(os.Stderr, "mkdir:", err)
		return 1
	}

	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		fmt.Fprintln(os.Stderr, "genkey:", err)
		return 1
	}

	// 公钥：纯 base64，嵌入 verify.go 常量
	pubB64 := base64.StdEncoding.EncodeToString(pub)
	if err := os.WriteFile(filepath.Join(outDir, "gitea-kanban-public.b64"), []byte(pubB64+"\n"), 0o644); err != nil {
		fmt.Fprintln(os.Stderr, "write pub:", err)
		return 1
	}

	// 私钥：加密后 base64（salt || nonce || ciphertext）
	privB64, err := encryptPrivateKey(priv, *password)
	if err != nil {
		fmt.Fprintln(os.Stderr, "encrypt priv:", err)
		return 1
	}
	if err := os.WriteFile(filepath.Join(outDir, "gitea-kanban-private.b64"), []byte(privB64+"\n"), 0o600); err != nil {
		fmt.Fprintln(os.Stderr, "write priv:", err)
		return 1
	}

	fmt.Printf("public key (paste into app/updater/verify.go):\n%s\n", pubB64)
	fmt.Printf("private key saved to %s (encrypted, password required)\n",
		filepath.Join(outDir, "gitea-kanban-private.b64"))
	fmt.Println("Next:")
	fmt.Println("  # Verify:")
	fmt.Println("  base64 -d keys/gitea-kanban-public.b64 | xxd | head")
	fmt.Println("  # Test sign:")
	fmt.Println("  echo 'test' > /tmp/test && sign sign --key keys/gitea-kanban-private.b64 --password \"$pwd\" /tmp/test && ls -la /tmp/test.sig")
	return 0
}

func encryptPrivateKey(priv ed25519.PrivateKey, password string) (string, error) {
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

	// 拼成 salt || nonce || ciphertext
	out := append(salt, nonce...)
	out = append(out, ciphertext...)
	return base64.StdEncoding.EncodeToString(out), nil
}

func decryptPrivateKey(blob string, password string) (ed25519.PrivateKey, error) {
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
		return nil, fmt.Errorf("decrypt (wrong password?): %w", err)
	}
	if len(plain) != ed25519.PrivateKeySize {
		return nil, fmt.Errorf("plain size mismatch: %d", len(plain))
	}
	return ed25519.PrivateKey(plain), nil
}

// --- sign ---

func runSign(args []string) int {
	fs := flag.NewFlagSet("sign", flag.ExitOnError)
	keyPath := fs.String("key", "", "encrypted private key file (required)")
	password := fs.String("password", "", "private key password (required)")
	fs.Parse(args)

	if *keyPath == "" || *password == "" {
		fmt.Fprintln(os.Stderr, "ERROR: --key and --password required")
		return 1
	}
	if fs.NArg() < 1 {
		fmt.Fprintln(os.Stderr, "ERROR: at least one asset required")
		return 1
	}

	keyBlob, err := os.ReadFile(*keyPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "read key:", err)
		return 1
	}
	priv, err := decryptPrivateKey(string(keyBlob), *password)
	if err != nil {
		fmt.Fprintln(os.Stderr, "decrypt:", err)
		return 1
	}

	for _, assetPath := range fs.Args() {
		body, err := os.ReadFile(assetPath)
		if err != nil {
			fmt.Fprintln(os.Stderr, "read asset:", err)
			return 1
		}
		sig := ed25519.Sign(priv, body)
		sigPath := assetPath + ".sig"
		if err := os.WriteFile(sigPath, sig, 0o644); err != nil {
			fmt.Fprintln(os.Stderr, "write sig:", err)
			return 1
		}
		fmt.Printf("signed %s → %s (%d bytes)\n", assetPath, sigPath, len(sig))
	}
	return 0
}

// --- manifest ---

type manifestEntry struct {
	Version string                   `json:"version"`
	Notes   string                   `json:"notes,omitempty"`
	Assets  map[string]manifestAsset `json:"assets"`
}

type manifestAsset struct {
	URL    string `json:"url"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

func runManifest(args []string) int {
	fs := flag.NewFlagSet("manifest", flag.ExitOnError)
	version := fs.String("version", "", "release version (required, e.g. v0.8.0)")
	notesFile := fs.String("notes", "", "release notes file (markdown, optional)")
	repoSlug := fs.String("repo", "July-X/gitea-kanban", "GitHub repo (owner/name)")
	fs.Parse(args)

	if *version == "" {
		fmt.Fprintln(os.Stderr, "ERROR: --version required")
		return 1
	}
	if fs.NArg() < 1 {
		fmt.Fprintln(os.Stderr, "ERROR: at least one asset required")
		return 1
	}

	notes := ""
	if *notesFile != "" {
		b, err := os.ReadFile(*notesFile)
		if err != nil {
			fmt.Fprintln(os.Stderr, "read notes:", err)
			return 1
		}
		notes = string(b)
	}

	m := manifestEntry{
		Version: *version,
		Notes:   notes,
		Assets:  map[string]manifestAsset{},
	}
	for _, assetPath := range fs.Args() {
		body, err := os.ReadFile(assetPath)
		if err != nil {
			fmt.Fprintln(os.Stderr, "read asset:", err)
			return 1
		}
		sum := sha256.Sum256(body)
		platformKey, ok := extractPlatformFromAssetName(filepath.Base(assetPath))
		if !ok {
			fmt.Fprintf(os.Stderr, "WARN: cannot extract platform from %s, skip\n", assetPath)
			continue
		}
		url := fmt.Sprintf("https://github.com/%s/releases/download/%s/%s",
			*repoSlug, *version, filepath.Base(assetPath))
		m.Assets[platformKey] = manifestAsset{
			URL:    url,
			Size:   int64(len(body)),
			SHA256: hex.EncodeToString(sum[:]),
		}
	}
	out, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		fmt.Fprintln(os.Stderr, "marshal:", err)
		return 1
	}
	_, _ = io.WriteString(os.Stdout, string(out)+"\n")
	return 0
}

// extractPlatformFromAssetName 对齐 app/updater/manifest.go 的逻辑
func extractPlatformFromAssetName(name string) (string, bool) {
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
