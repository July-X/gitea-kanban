#!/usr/bin/env bash
# scripts/e2e.sh
#
# M7 e2e 收口：自动切 ABI + 串跑 W1/W2/W3/W4 4 个 e2e + 切回。
#
# 设计：
# - better-sqlite3 默认装 electron ABI（给 dev/build 用），e2e 跑在 node 25 上
# - 所以 e2e 跑前必须切到 node 25 ABI，**不**切 dev/build 用不上
# - 跑完自动切回 electron ABI（dev 不受影响）
# - 任一 e2e 失败：exit 1（CI 友好）；不**自动**恢复（避免掩盖问题）
#
# 用法：
#   bash scripts/e2e.sh                # 跑完切回 electron ABI
#   bash scripts/e2e.sh --keep-node   # 跑完**不**切回（dev 前要 pnpm rebuild:native）
#
# 退码：
#   0 = 4 个 e2e 全 pass
#   非 0 = 至少 1 个 e2e fail（或 ABI 切换失败）

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

KEEP_NODE_ABI=false
for arg in "$@"; do
  case "$arg" in
    --keep-node) KEEP_NODE_ABI=true ;;
    *) echo "unknown arg: $arg"; exit 1 ;;
  esac
done

# 找 better-sqlite3 实际路径
BSQLITE_DIR=$(ls -d "$ROOT"/node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 2>/dev/null | sort -V | tail -1)
if [ -z "$BSQLITE_DIR" ]; then
  echo "FATAL: better-sqlite3 not found in pnpm store"
  exit 1
fi

# 取 electron 版本（切回用）
ELECTRON_VERSION=$(node -p "require('electron/package.json').version" 2>/dev/null || echo "")

# 切到 node 25 ABI
echo ">>> [1/3] prebuild-install (node 25 ABI) for $BSQLITE_DIR"
if ! (cd "$BSQLITE_DIR" && npx -y prebuild-install --runtime=node --target=25.9.0 2>&1 | tail -3); then
  echo "FATAL: failed to switch to node 25 ABI"
  exit 1
fi

# 4 个 e2e 串跑
KB_TOKEN="${KB_TOKEN:-9c3fdf27b132c9564b012326344c3993486bf868}"
export KB_TOKEN

declare -a RESULTS=()

run_one() {
  local label="$1"
  local script="$2"
  echo ""
  echo "=========================================="
  echo ">>> [2/3] run e2e: $label"
  echo "=========================================="
  if node "$ROOT/scripts/_e2e-runner.mjs" "$ROOT/scripts/$script"; then
    RESULTS+=("$label: PASS")
  else
    rc=$?
    RESULTS+=("$label: FAIL (exit=$rc)")
    OVERALL_RC=1
  fi
}

OVERALL_RC=0
run_one "W1 (repos/branches/commits)" "e2e-verify-w1.ts"
run_one "W2 (board/issue/labels)"     "e2e-verify-w2.ts"
run_one "W3 (pulls/timeline)"         "e2e-verify-w3.ts"
run_one "W4 (auth/prefs)"             "e2e-verify-w4.ts"

# 切回 electron ABI
echo ""
if [ "$KEEP_NODE_ABI" = false ] && [ -n "$ELECTRON_VERSION" ]; then
  echo ">>> [3/3] prebuild-install (electron $ELECTRON_VERSION ABI) for dev/build"
  (cd "$BSQLITE_DIR" && npx prebuild-install --runtime=electron --target="$ELECTRON_VERSION" 2>&1 | tail -3) || true
else
  echo ">>> [3/3] --keep-node set, skipping ABI restore (run pnpm rebuild:native before dev)"
fi

# 报告
echo ""
echo "=========================================="
echo "M7 e2e 串跑结果"
echo "=========================================="
for r in "${RESULTS[@]}"; do
  echo "  $r"
done
echo "=========================================="

exit $OVERALL_RC
