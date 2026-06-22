#!/usr/bin/env bash
#
# ci-local.sh —— 本地 4 件套串行 wrapper
#
# 设计动机：项目必跑 4 件套 = type-check / build / test / check:no-jargon
# （AGENTS.md §7.4 + CLAUDE.md §"4 件套必跑"），
# 每次手动敲 4 条命令太烦 + 容易漏 —— 本脚本一气呵成，CI 出错立刻定位到第几步。
#
# 用法：
#   bash scripts/ci-local.sh         # 跑全部 4 件套
#   bash scripts/ci-local.sh fast     # 跳过 build（type-check 已经保证类型对齐；日常开发够用）
#
# 退出码：
#   0 = 全部通过
#   非 0 = 第一个失败的步骤退出码
#
# 注意：
# - 串行：build 在 type-check 之后；test 跟 build 独立可并行但为日志可读性串行
# - 不做 `--bail` 标志的依赖：每步独立判断，第一步失败立刻停
# - 输出保留原 pnpm 命令的 stdout/stderr（不 buffer），便于错误定位

set -euo pipefail

# ===== 路径定位 =====
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# ===== 参数解析 =====
MODE="${1:-full}"
case "$MODE" in
  full) SKIP_BUILD=0 ;;
  fast) SKIP_BUILD=1 ;;
  *)
    echo "❌ unknown mode: $MODE (use 'full' or 'fast')" >&2
    exit 2
    ;;
esac

# ===== 计时 =====
START_TIME=$(date +%s)
STEP_COUNT=0

run_step() {
  local label="$1"
  shift
  STEP_COUNT=$((STEP_COUNT + 1))
  local step_start=$(date +%s)
  echo ""
  echo "═══ [$STEP_COUNT] $label ═══"
  if "$@"; then
    local elapsed=$(( $(date +%s) - step_start ))
    echo "✅ $label passed (${elapsed}s)"
  else
    local exit_code=$?
    local elapsed=$(( $(date +%s) - step_start ))
    echo "❌ $label FAILED after ${elapsed}s (exit $exit_code)" >&2
    exit "$exit_code"
  fi
}

# ===== 4 件套 =====
run_step "type-check" pnpm type-check

if [ "$SKIP_BUILD" -eq 0 ]; then
  run_step "build" pnpm build
fi

run_step "test" pnpm test

run_step "check:no-jargon" pnpm check:no-jargon

# ===== 收尾 =====
TOTAL_ELAPSED=$(( $(date +%s) - START_TIME ))
echo ""
echo "═══════════════════════════════════════"
echo "🎉 all 4 suites passed in ${TOTAL_ELAPSED}s (${STEP_COUNT} steps)"
echo "═══════════════════════════════════════"
