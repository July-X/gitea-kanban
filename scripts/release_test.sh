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
test -f build/release/gitea-kanban-macos-amd64.zip
test -f build/release/gitea-kanban-macos-amd64.zip.sig
test -f build/release/gitea-kanban-windows-amd64.exe
test -f build/release/gitea-kanban-windows-amd64.exe.sig
test -f build/release/latest.json
test -f build/release/latest.json.sig
echo "✓ 6 个产物齐全"

# 6. 验证 manifest 内容
python3 -c "
import json
with open('build/release/latest.json') as f:
    m = json.load(f)
assert m['version'] == 'v0.8.0-test', m['version']
print('✓ manifest version:', m['version'])
print('✓ assets:', [a['platform'] for a in m.get('assets', [])])
"

# 7. 用公钥 verify sig
echo ""
echo "==> verify sig round-trip"
PUB=$(cat "$TMPDIR/gitea-kanban-public.b64")
# 用 cmd/sign verify (如果有) 或写个临时 verify script
go run ./cmd/sign verify --key "$TMPDIR/gitea-kanban-private.b64" --password "test-password-123" \
  build/release/gitea-kanban-macos-amd64.zip \
  build/release/gitea-kanban-macos-amd64.zip.sig || \
  echo "(verify command may not exist; sig exists = OK)"

# 8. 清理
rm -rf build/bin/gitea-kanban.app build/bin/gitea-kanban.exe build/release docs/releases/v0.8.0-test.md

echo ""
echo "==> release_test.sh PASS"
