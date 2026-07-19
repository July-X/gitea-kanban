#!/usr/bin/env bash
# scripts/release_test.sh —— 本地 dry-run 验证 scripts/release.sh
set -euo pipefail

cd "$(dirname "$0")/.."

# 1. 生成测试密钥
echo "==> genkey"
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
go run ./cmd/sign genkey --password "test-password-123" "$TMPDIR"

# 2. 创建假 build 产物
mkdir -p build/bin
mkdir -p build/bin/gitea-kanban.app/Contents/MacOS
echo "fake macos app" > build/bin/gitea-kanban.app/Contents/MacOS/gitea-kanban
echo "fake windows exe" > build/bin/gitea-kanban.exe

# 3. 写 release notes
mkdir -p docs/releases
echo "test release notes" > docs/releases/v0.8.0-test.md

# 4. 跑 release.sh
SIGN_PRIVATE_KEY="$(cat "$TMPDIR/gitea-kanban-private.b64")" \
SIGN_PASSWORD="test-password-123" \
GITHUB_REPOSITORY="July-X/gitea-kanban" \
NOTES_FILE="docs/releases/v0.8.0-test.md" \
./scripts/release.sh v0.8.0-test

# 5. 校验产物
echo ""
echo "==> 校验产物"
RELEASE_DIR="${RELEASE_DIR:-/tmp/gitea-kanban-release-v0.8.0-test}"
test -f "$RELEASE_DIR/gitea-kanban-v0.8.0-test-macos-amd64.zip"
test -f "$RELEASE_DIR/gitea-kanban-v0.8.0-test-macos-amd64.zip.sig"
test -f "$RELEASE_DIR/gitea-kanban-v0.8.0-test-windows-amd64.exe"
test -f "$RELEASE_DIR/gitea-kanban-v0.8.0-test-windows-amd64.exe.sig"
test -f "$RELEASE_DIR/latest.json"
test -f "$RELEASE_DIR/latest.json.sig"
echo "✓ 6 个产物齐全"

# 6. 验证 manifest 内容
python3 -c "
import json
with open('${RELEASE_DIR}/latest.json') as f:
    m = json.load(f)
assert m['version'] == 'v0.8.0-test', m['version']
print('✓ manifest version:', m['version'])
print('✓ assets:', [a['platform'] for a in m.get('assets', [])])
"

# 7. 用私钥 + sig 验签 round-trip（不是 cmd/sign verify — cmd/sign 没 verify subcommand；
#    直接用 Go 程序 ed25519.Verify 验公钥/sig）
echo ""
echo "==> verify sig round-trip (ed25519.Verify)"

# 写临时 verify 程序
mkdir -p "$TMPDIR/verify"
cat > "$TMPDIR/verify/main.go" << 'GOEOF'
package main

import (
	"crypto/ed25519"
	"encoding/hex"
	"fmt"
	"os"
)

func main() {
	pubHex := os.Args[1]
	sigPath := os.Args[2]
	assetPath := os.Args[3]

	pub, err := hex.DecodeString(pubHex)
	if err != nil {
		fmt.Fprintln(os.Stderr, "decode pub:", err)
		os.Exit(1)
	}
	if len(pub) != ed25519.PublicKeySize {
		fmt.Fprintln(os.Stderr, "bad pub size")
		os.Exit(1)
	}

	sig, err := os.ReadFile(sigPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "read sig:", err)
		os.Exit(1)
	}
	asset, err := os.ReadFile(assetPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "read asset:", err)
		os.Exit(1)
	}

	if !ed25519.Verify(pub, asset, sig) {
		fmt.Fprintln(os.Stderr, "verify FAILED")
		os.Exit(1)
	}
	fmt.Println("✓ ed25519.Verify PASS")
}
GOEOF

# pub 文件是 base64 不是 hex，先转
PUB_B64=$(cat "$TMPDIR/gitea-kanban-public.b64" | tr -d '\n')
PUB_HEX=$(printf '%s' "$PUB_B64" | base64 -d 2>/dev/null | xxd -p -c 1000 | tr -d '\n')
echo "pub hex len: ${#PUB_HEX}"

RELEASE_DIR="${RELEASE_DIR:-/tmp/gitea-kanban-release-v0.8.0-test}"
if ! (cd "$TMPDIR/verify" && go run main.go "$PUB_HEX" \
  "$RELEASE_DIR/gitea-kanban-v0.8.0-test-macos-amd64.zip.sig" \
  "$RELEASE_DIR/gitea-kanban-v0.8.0-test-macos-amd64.zip") 2>&1 | head -5; then
  echo "ERROR: ed25519.Verify FAILED（zip.sig 不是 zip 的合法签名）" >&2
  exit 1
fi

# 8. 清理
rm -rf build/bin/gitea-kanban.app build/bin/gitea-kanban.exe "$RELEASE_DIR" docs/releases/v0.8.0-test.md

echo ""
echo "==> release_test.sh PASS"
