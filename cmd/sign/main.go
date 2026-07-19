// cmd/sign —— v0.8.0 自动更新签名 / 公钥生成 CLI（thin shell）
//
// 用法（CI / maintainer 本地）：
//
//	# 1. 生成 ed25519 key pair（一次性）
//	go run ./cmd/sign genkey ./keys --password "$pwd"
//	# 产出：./keys/gitea-kanban-public.b64（嵌入 verify.go 常量）
//	#       ./keys/gitea-kanban-private.b64（加密存 CI secret）
//
//	# 2. 对 release asset 签名
//	go run ./cmd/sign sign \
//	  --key ./keys/private.b64 --password "$pwd" \
//	  ./build/bin/gitea-kanban-windows-amd64.exe \
//	  ./build/bin/gitea-kanban-darwin-arm64.zip
//	# 产出：每个 asset 同名 .sig 文件
//
//	# 3. 生成 manifest（latest.json）
//	go run ./cmd/sign manifest \
//	  --version v0.8.0 --notes docs/releases/v0.8.0.md \
//	  --repo July-X/gitea-kanban \
//	  ./build/bin/gitea-kanban-windows-amd64.exe \
//	  ./build/bin/gitea-kanban-darwin-arm64.zip \
//	  > ./build/bin/latest.json
//
// 核心加密 + 签名 + manifest 逻辑在 sign.go（package sign，可 unit test）。
// 本文件只做 flag 解析 + 调用 sign 包 + 文件 IO。
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"flag"
	"fmt"
	"os"

	"gitea-kanban/cmd/sign/sign"
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
	fmt.Fprintf(os.Stderr, "usage: sign <subcommand> [args]\n\nsubcommands:\n  genkey <out-dir> [--password <pwd>]\n  sign --key <key> --password <pwd> <asset>...\n  manifest --version <ver> --notes <file> [--repo <owner/name>] <asset>...\n")
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
	pubB64 := encodeKey(pub)
	if err := os.WriteFile(outDir+"/gitea-kanban-public.b64", []byte(pubB64+"\n"), 0o644); err != nil {
		fmt.Fprintln(os.Stderr, "write pub:", err)
		return 1
	}

	// 私钥：加密后 base64
	privB64, err := sign.EncryptPrivateKey(priv, *password)
	if err != nil {
		fmt.Fprintln(os.Stderr, "encrypt priv:", err)
		return 1
	}
	if err := os.WriteFile(outDir+"/gitea-kanban-private.b64", []byte(privB64+"\n"), 0o600); err != nil {
		fmt.Fprintln(os.Stderr, "write priv:", err)
		return 1
	}

	fmt.Printf("public key (paste into app/updater/verify.go):\n%s\n", pubB64)
	fmt.Printf("private key saved to %s/gitea-kanban-private.b64 (encrypted, password required)\n", outDir)
	fmt.Println("Next:")
	fmt.Println("  # Verify:")
	fmt.Println("  base64 -d keys/gitea-kanban-public.b64 | xxd | head")
	fmt.Println("  # Test sign:")
	fmt.Println("  echo 'test' > /tmp/test && sign sign --key keys/gitea-kanban-private.b64 --password \"$pwd\" /tmp/test && ls -la /tmp/test.sig")
	return 0
}

func encodeKey[T ed25519.PublicKey | ed25519.PrivateKey](k T) string {
	return base64.StdEncoding.EncodeToString([]byte(k))
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
	priv, err := sign.DecryptPrivateKey(string(keyBlob), *password)
	if err != nil {
		fmt.Fprintln(os.Stderr, "decrypt:", err)
		return 1
	}

	for _, assetPath := range fs.Args() {
		sig, err := sign.SignFile(priv, assetPath)
		if err != nil {
			fmt.Fprintln(os.Stderr, "sign:", err)
			return 1
		}
		if err := sign.WriteSignature(assetPath, sig); err != nil {
			fmt.Fprintln(os.Stderr, "write sig:", err)
			return 1
		}
		fmt.Printf("signed %s → %s.sig (%d bytes)\n", assetPath, assetPath, len(sig))
	}
	return 0
}

// --- manifest ---

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

	m, err := sign.BuildManifest(*version, notes, *repoSlug, fs.Args())
	if err != nil {
		fmt.Fprintln(os.Stderr, "build manifest:", err)
		return 1
	}
	out, err := sign.MarshalManifest(m)
	if err != nil {
		fmt.Fprintln(os.Stderr, "marshal:", err)
		return 1
	}
	fmt.Println(string(out))
	return 0
}
