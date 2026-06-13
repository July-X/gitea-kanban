#!/usr/bin/env bash
# scripts/e2e-verify-w1.sh
#
# W1 e2e 验证的薄壳入口 —— 推荐改用 `pnpm e2e:w1` 或 `pnpm e2e:all`
#
# M7 收口前：此脚本走 esbuild bundle + ABI 切来切去（3 步）
# M7 收口后：调 M6 的 _e2e-runner.mjs（与 pnpm e2e:w1 完全等价）
#
# 为何保留 .sh：
# - commit 4dba52d（用户 6月 11 写）的历史入口，不 reset
# - 习惯 bash wrapper 的 dev 可继续用
# - 跑 e2e:all 太重时，单跑 w1 的入口
#
# 用法：
#   bash scripts/e2e-verify-w1.sh                # 跑完切回 electron ABI
#   bash scripts/e2e-verify-w1.sh --keep-node   # 跑完**不**切回
#
# 等价于：
#   bash scripts/e2e.sh --keep-node  # 但这个会串跑 4 个
#
# 真正推荐：
#   pnpm e2e:w1
#   pnpm e2e:all
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

# 1. 切 ABI 到 node 25
BSQLITE_DIR=$(ls -d "$ROOT"/node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 2>/dev/null | sort -V | tail -1)
if [ -z "$BSQLITE_DIR" ]; then
  echo "FATAL: better-sqlite3 not found in pnpm store"; exit 1
fi
echo ">>> [1/3] prebuild-install (node 25 ABI) for $BSQLITE_DIR"
(cd "$BSQLITE_DIR" && npx -y prebuild-install --runtime=node --target=25.9.0 2>&1 | tail -3)

# 2. 调 M6 runner
echo ">>> [2/3] run e2e via _e2e-runner.mjs"
trap 'rc=$?' EXIT
set +e
node "$ROOT/scripts/_e2e-runner.mjs" "$ROOT/scripts/e2e-verify-w1.ts"
RC=$?
set -e

# 3. 切回 electron ABI（除非 --keep-node）
if [ "$KEEP_NODE_ABI" = false ]; then
  ELECTRON_VERSION=$(node -p "require('electron/package.json').version" 2>/dev/null || echo "")
  if [ -n "$ELECTRON_VERSION" ]; then
    echo ""
    echo ">>> [3/3] prebuild-install (electron $ELECTRON_VERSION ABI) for dev/build"
    (cd "$BSQLITE_DIR" && npx prebuild-install --runtime=electron --target="$ELECTRON_VERSION" 2>&1 | tail -3)
  fi
else
  echo ""
  echo ">>> [3/3] --keep-node set, skipping ABI restore (run pnpm rebuild:native before dev)"
fi

exit $RC
