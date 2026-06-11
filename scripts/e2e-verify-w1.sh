#!/usr/bin/env bash
# scripts/e2e-verify-w1.sh
#
# W1 e2e 验证的一键复跑脚本
#
# 流程：
#  1. bundle scripts/e2e-verify-w1.ts → scripts/.e2e-verify-w1.bundled.mjs
#     （esbuild alias: electron → stub, pino → stub，external: better-sqlite3 / keyring）
#  2. 切 better-sqlite3 到 node 25 ABI（默认装的是 electron 41 ABI=145，node 25 是 ABI=141）
#  3. 跑 bundled 脚本，输出写到 stdout + samples.json 写到 .opencode/tmp/
#  4. （可选）切回 electron ABI
#
# 用法：
#   bash scripts/e2e-verify-w1.sh                # 跑完切回 electron ABI
#   bash scripts/e2e-verify-w1.sh --keep-node   # 跑完**不**切回 electron ABI
#
# 背景（AGENTS.md §8.11）：
# - better-sqlite3 12.10 默认装 electron 41 ABI=145（给 dev / build 用）
# - node 25 / vitest 跑要 ABI=141
# - 切 ABI = 重新下载 prebuilt（prebuild-install --runtime=node --target=25.9.0）
# - 跑完 dev 要 `pnpm rebuild:native` 切回 electron ABI
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

KEEP_NODE_ABI=false
for arg in "$@"; do
  case "$arg" in
    --keep-node) KEEP_NODE_ABI=true ;;
    *) echo "unknown arg: $arg"; exit 1 ;;
  esac
done

# 1. bundle
BUNDLE_OUT="$ROOT/scripts/.e2e-verify-w1.bundled.mjs"
echo ">>> [1/4] bundle e2e-verify-w1.ts → $BUNDLE_OUT"
node /tmp/e2e-shim/bundle.mjs \
  "$ROOT/scripts/e2e-verify-w1.ts" \
  "$BUNDLE_OUT"

# 2. 切 ABI 到 node 25（如果已经是 node ABI 跳过）
BSQLITE_DIR=$(ls -d "$ROOT"/node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 2>/dev/null | sort -V | tail -1)
if [ -z "$BSQLITE_DIR" ]; then
  echo "FATAL: better-sqlite3 not found in pnpm store"; exit 1
fi
echo ">>> [2/4] prebuild-install (node 25 ABI) for $BSQLITE_DIR"
(cd "$BSQLITE_DIR" && npx -y prebuild-install --runtime=node --target=25.9.0 2>&1 | tail -3)

# 3. 跑
echo ">>> [3/4] run e2e"
trap 'rc=$?' EXIT
set +e
node "$BUNDLE_OUT"
RC=$?
set -e

# 4. 切回 electron ABI（除非 --keep-node）
if [ "$KEEP_NODE_ABI" = false ]; then
  echo ""
  echo ">>> [4/4] prebuild-install (electron ABI) for dev/build"
  (cd "$BSQLITE_DIR" && npx prebuild-install --runtime=electron --target="$(node -p "require('electron/package.json').version")" 2>&1 | tail -3)
else
  echo ""
  echo ">>> [4/4] --keep-node set, skipping ABI restore (run pnpm rebuild:native before dev)"
fi

exit $RC
