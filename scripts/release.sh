#!/usr/bin/env bash
# scripts/release.sh —— v0.8.0 自动发版打包脚本（release.yml 调用）
#
# 输入：
#   $1 = TAG          如 v0.8.0 / v0.8.0-rc1（默认从 git describe 取）
#   env SIGN_PRIVATE_KEY（base64 单行，加密的 ed25519 私钥）
#   env SIGN_PASSWORD（解密密码）
#
# 行为：
#   1. 检测 build/bin/ 下的 .app / .exe 双平台产物
#   2. macOS .app → zip 打包
#   3. 写私钥到临时文件 + chmod 600
#   4. cmd/sign sign 对每个 asset 生成 .sig
#   5. cmd/sign manifest 生成 latest.json
#   6. 打印产物清单 + SHA256
#
# 退出码：
#   0 = 成功
#   1 = 缺依赖 / 缺产物 / 缺 secrets / cmd/sign 失败

set -euo pipefail

# ===== 输入解析 =====
TAG="${1:-$(git describe --tags --abbrev=0 2>/dev/null || echo "")}"
if [[ -z "$TAG" ]]; then
  echo "ERROR: TAG not provided and git describe failed" >&2
  echo "Usage: $0 <tag>" >&2
  exit 1
fi

REPO="${GITHUB_REPOSITORY:-$(git remote get-url origin 2>/dev/null | sed -E 's#.*[:/]([^/]+/[^/]+)(\.git)?$#\1#' || echo "")}"
if [[ -z "$REPO" ]]; then
  echo "ERROR: REPO not set (GITHUB_REPOSITORY env or git remote required)" >&2
  exit 1
fi

BUILD_DIR="${BUILD_DIR:-build/bin}"
RELEASE_DIR="${RELEASE_DIR:-build/release}"

echo "==> TAG=$TAG"
echo "==> REPO=$REPO"
echo "==> BUILD_DIR=$BUILD_DIR"
echo "==> RELEASE_DIR=$RELEASE_DIR"

# ===== 1. 依赖检查 =====
for cmd in zip go sha256sum; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "ERROR: required command not found: $cmd" >&2
    exit 1
  fi
done

if [[ -z "${SIGN_PRIVATE_KEY:-}" ]]; then
  echo "ERROR: SIGN_PRIVATE_KEY env not set" >&2
  exit 1
fi

if [[ -z "${SIGN_PASSWORD:-}" ]]; then
  echo "ERROR: SIGN_PASSWORD env not set" >&2
  exit 1
fi

# ===== 2. 检测产物 =====
mkdir -p "$RELEASE_DIR"

MACOS_APP="$BUILD_DIR/gitea-kanban.app"
WINDOWS_EXE="$BUILD_DIR/gitea-kanban.exe"

MACOS_ZIP="$RELEASE_DIR/gitea-kanban-macos-amd64.zip"
WINDOWS_EXE_OUT="$RELEASE_DIR/gitea-kanban-windows-amd64.exe"

ASSETS=()

if [[ -d "$MACOS_APP" ]]; then
  echo "==> 打包 macOS .app → zip"
  (cd "$BUILD_DIR" && zip -r "$MACOS_ZIP" gitea-kanban.app >/dev/null)
  ASSETS+=("$MACOS_ZIP")
elif [[ -f "$MACOS_ZIP" ]]; then
  echo "==> 复用已存在的 macOS zip: $MACOS_ZIP"
  ASSETS+=("$MACOS_ZIP")
else
  echo "WARN: macOS build missing ($MACOS_APP / $MACOS_ZIP) — skipping" >&2
fi

if [[ -f "$WINDOWS_EXE" ]]; then
  cp "$WINDOWS_EXE" "$WINDOWS_EXE_OUT"
  ASSETS+=("$WINDOWS_EXE_OUT")
elif [[ -f "$WINDOWS_EXE_OUT" ]]; then
  echo "==> 复用已存在的 Windows exe: $WINDOWS_EXE_OUT"
  ASSETS+=("$WINDOWS_EXE_OUT")
else
  echo "WARN: Windows build missing ($WINDOWS_EXE / $WINDOWS_EXE_OUT) — skipping" >&2
fi

if [[ ${#ASSETS[@]} -eq 0 ]]; then
  echo "ERROR: no assets to release" >&2
  exit 1
fi

# ===== 3. 写私钥（临时 + chmod 600） =====
KEY_FILE="$RELEASE_DIR/.private.b64"
echo "$SIGN_PRIVATE_KEY" > "$KEY_FILE"
chmod 600 "$KEY_FILE"
trap 'rm -f "$KEY_FILE"' EXIT  # 退出前清理

# ===== 4. cmd/sign sign（每个 asset 一个 .sig） =====
echo "==> ed25519 sign assets"
for asset in "${ASSETS[@]}"; do
  go run ./cmd/sign sign \
    --key "$KEY_FILE" \
    --password "$SIGN_PASSWORD" \
    "$asset"
done

# ===== 5. cmd/sign manifest → latest.json =====
echo "==> 生成 manifest → latest.json"
NOTES_FILE="${NOTES_FILE:-docs/releases/${TAG}.md}"
if [[ ! -f "$NOTES_FILE" ]]; then
  echo "WARN: notes file not found: $NOTES_FILE, using empty notes" >&2
  NOTES_FILE_ARG=()
else
  NOTES_FILE_ARG=(--notes "$NOTES_FILE")
fi

LATEST_JSON="$RELEASE_DIR/latest.json"
go run ./cmd/sign manifest \
  --version "$TAG" \
  "${NOTES_FILE_ARG[@]}" \
  --repo "$REPO" \
  "$@" \
  "${ASSETS[@]}" > "$LATEST_JSON"

# 注：上面 "--" 是占位符，实际 main.go manifest 只接 positional assets
# 重写：
go run ./cmd/sign manifest \
  --version "$TAG" \
  "${NOTES_FILE_ARG[@]}" \
  --repo "$REPO" \
  "${ASSETS[@]}" > "$LATEST_JSON"

# ===== 6. sign latest.json 自身 =====
echo "==> sign latest.json"
go run ./cmd/sign sign \
  --key "$KEY_FILE" \
  --password "$SIGN_PASSWORD" \
  "$LATEST_JSON"

# ===== 7. 输出产物清单 + SHA256 =====
echo ""
echo "================ Release artifacts ================"
cd "$RELEASE_DIR"
ls -la
echo ""
echo "================ SHA256 checksums ================"
sha256sum gitea-kanban-macos-amd64.zip \
          gitea-kanban-macos-amd64.zip.sig \
          gitea-kanban-windows-amd64.exe \
          gitea-kanban-windows-amd64.exe.sig \
          latest.json \
          latest.json.sig 2>/dev/null || true
echo "================================================="

echo ""
echo "==> release.sh 完成。产物在 $RELEASE_DIR/"