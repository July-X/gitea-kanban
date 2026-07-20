#!/usr/bin/env bash
# scripts/release.sh —— v0.8.0 自动发版打包脚本（release.yml 调用）
#
# 输入：
#   $1 = TAG          如 v0.8.0 / v0.8.0-rc1（默认从 git describe 取）
#   env SIGN_PRIVATE_KEY（base64 单行，加密的 ed25519 私钥）
#   env SIGN_PASSWORD（解密密码）
#
# 行为：
#   1. 检测 build/bin/ 下的 macOS dmg + Windows exe 双平台产物
#   2. macOS dmg（已由 build job 用 hdiutil 构造好含完整 .app bundle）
#      + Windows exe 直接作为 release asset
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
# v0.8.0：build/release 默认在仓库内，但某些 sandbox 拒绝写 build/ 子树
# （如 gh CLI 的 bash sandbox 限制），所以默认改写到 /tmp 下，maintainer 可
# 通过 RELEASE_DIR env 覆盖到仓库内（CI 上用 build/release 让 artifact upload 找到）。
RELEASE_DIR="${RELEASE_DIR:-/tmp/gitea-kanban-release-${TAG}}"

echo "==> TAG=$TAG"
echo "==> REPO=$REPO"
echo "==> BUILD_DIR=$BUILD_DIR"
echo "==> RELEASE_DIR=$RELEASE_DIR"

# ===== 1. 依赖检查 =====
# v0.8.0 rc30：去 zip 依赖（macOS 改 dmg，dmg 在 build job 已经构造好）
for cmd in file go sha256sum; do
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

# v0.8.0 rc30：macOS 改成 dmg，dmg 在 build job 已经构造好（hdiutil 在 macos runner）。
# 本脚本不再做 dmg 构造，只负责 rename + 移到 RELEASE_DIR + sign。
# 兼容 2 种 build job 产物命名：
#   1. gitea-kanban-${TAG}-macos-amd64.dmg（tag 化命名，user 期望）
#   2. *.dmg（带 tag 命名前的中间产物，artifact 上传后改名）
MACOS_DMG_BUILD=$(find "$BUILD_DIR" -maxdepth 1 -name '*.dmg' -type f | head -n 1 || true)
# v0.8.5 follow-up: Windows 优先选 NSIS installer（setup.exe），fallback portable exe
# NSIS installer 输出文件名：gitea-kanban-setup.exe（wails build -nsis 默认命名）
WINDOWS_EXE_BUILD=""
if [[ -f "$BUILD_DIR/gitea-kanban-setup.exe" ]]; then
  WINDOWS_EXE_BUILD="$BUILD_DIR/gitea-kanban-setup.exe"
  echo "==> Windows: 优先使用 NSIS installer ($WINDOWS_EXE_BUILD)"
elif [[ -f "$BUILD_DIR/gitea-kanban.exe" ]]; then
  WINDOWS_EXE_BUILD="$BUILD_DIR/gitea-kanban.exe"
  echo "==> Windows: 使用 portable exe ($WINDOWS_EXE_BUILD)"
fi

# 产物名带 TAG，跟 app/updater/manifest.go:158 AssetFilename() 一致
MACOS_DMG="$RELEASE_DIR/gitea-kanban-${TAG}-macos-amd64.dmg"
WINDOWS_EXE_OUT="$RELEASE_DIR/gitea-kanban-${TAG}-windows-amd64.exe"

ASSETS=()

if [[ -n "$MACOS_DMG_BUILD" && -f "$MACOS_DMG_BUILD" ]]; then
  if [[ "$MACOS_DMG_BUILD" != "$MACOS_DMG" ]]; then
    mv "$MACOS_DMG_BUILD" "$MACOS_DMG"
    echo "==> 移动 macOS dmg: $MACOS_DMG_BUILD → $MACOS_DMG"
  fi
  # sanity check dmg 格式
  DMG_TYPE=$(file --mime-type -b "$MACOS_DMG" || true)
  if [[ "$DMG_TYPE" != *zip* && "$DMG_TYPE" != *dmg* && "$DMG_TYPE" != *x-apple* ]]; then
    echo "WARN: dmg file 类型异常: $DMG_TYPE（期望 application/x-apple-diskimage 或类似）"
  fi
  ASSETS+=("$MACOS_DMG")
elif [[ -f "$MACOS_DMG" ]]; then
  echo "==> 复用已存在的 macOS dmg: $MACOS_DMG"
  ASSETS+=("$MACOS_DMG")
else
  echo "WARN: macOS build missing (*.dmg in $BUILD_DIR) — skipping" >&2
fi

if [[ -f "$WINDOWS_EXE_BUILD" ]]; then
  cp "$WINDOWS_EXE_BUILD" "$WINDOWS_EXE_OUT"
  ASSETS+=("$WINDOWS_EXE_OUT")
elif [[ -f "$WINDOWS_EXE_OUT" ]]; then
  echo "==> 复用已存在的 Windows exe: $WINDOWS_EXE_OUT"
  ASSETS+=("$WINDOWS_EXE_OUT")
else
  echo "WARN: Windows build missing ($WINDOWS_EXE_BUILD) — skipping" >&2
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
sha256sum gitea-kanban-macos-amd64.dmg \
          gitea-kanban-macos-amd64.dmg.sig \
          gitea-kanban-windows-amd64.exe \
          gitea-kanban-windows-amd64.exe.sig \
          latest.json \
          latest.json.sig 2>/dev/null || true
echo "================================================="

echo ""
echo "==> release.sh 完成。产物在 $RELEASE_DIR/"