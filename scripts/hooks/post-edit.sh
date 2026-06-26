#!/usr/bin/env bash
# post-edit.sh — Reasonix Stop / PostToolUse hook
# 在大模型完成代码修改后跑：format → build → test → git commit（中文记录）
#
# 触发事件：
#   - Stop           → 跑完整流程（format / build / test / commit）
#   - PostToolUse    → 只跑轻量格式化（gofmt -l），保证下一次 build 不会被格式错误阻断
#
# 调用方式（reasonix 通过平台 shell 执行）：
#   stdin 是一行 JSON，包含 event / cwd 等字段
#   exit 0 = 通过；exit 2 = 阻塞（PreToolUse 才用）；其它非零 = warning
#
# 设计原则：
#   - 任何阶段失败立即停止，不做兜底 commit
#   - 前端格式化仅在源文件存在且工具就绪时执行；缺失 prettier/eslint 不会报错
#   - commit 信息用中文，从最近一次模型回复或 Stop payload 中提取线索；提取失败用兜底模板

set -euo pipefail

# ---------- 读 stdin payload ----------
PAYLOAD="$(cat || true)"
EVENT="$(printf '%s' "$PAYLOAD" | python3 -c "import json,sys; d=json.loads(sys.stdin.read() or '{}'); print(d.get('event',''))" 2>/dev/null || echo "")"
CWD_HOOK="$(printf '%s' "$PAYLOAD" | python3 -c "import json,sys; d=json.loads(sys.stdin.read() or '{}'); print(d.get('cwd',''))" 2>/dev/null || echo "")"

# hook 命令的工作目录：reasonix 默认注入 cwd
WORKDIR="${CWD_HOOK:-$(pwd)}"
cd "$WORKDIR" 2>/dev/null || cd "$(pwd)"

# ---------- 颜色与日志 ----------
if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'; C_GRAY=$'\033[90m'
else
  C_RESET=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''; C_GRAY=''
fi

log()  { printf '%s[hook]%s %s\n' "$C_BLUE" "$C_RESET" "$*"; }
ok()   { printf '%s[hook]%s %s %s%s\n' "$C_BLUE" "$C_RESET" "$C_GREEN" "$*" "$C_RESET"; }
warn() { printf '%s[hook]%s %s %s%s\n' "$C_BLUE" "$C_RESET" "$C_YELLOW" "$*" "$C_RESET" 1>&2; }
err()  { printf '%s[hook]%s %s %s%s\n' "$C_BLUE" "$C_RESET" "$C_RED" "$*" "$C_RESET" 1>&2; }

# ---------- 工具探测 ----------
has() { command -v "$1" >/dev/null 2>&1; }

# ---------- 阶段函数：失败立即停止 ----------
stage_format() {
  log "阶段 1/4：格式化 (gofmt)"
  if has gofmt; then
    # 先把格式写回（gofmt -w 幂等），再列出仍存在差异的（应为空）
    gofmt -w . >/dev/null 2>&1 || true
    # 用 || true 防止 pipefail 因 SIGPIPE 误杀；同时禁用 errexit 直到子 shell 结束
    set +e
    UNFORMATTED="$(gofmt -l . 2>/dev/null | grep -v '^$' || true)"
    set -e
    if [ -n "$UNFORMATTED" ]; then
      warn "以下文件 gofmt 失败（请检查）："
      printf '  %s\n' "$UNFORMATTED"
      return 1
    else
      ok "Go 源码全部已格式化"
    fi
  else
    warn "未找到 gofmt，跳过"
  fi

  # 前端格式化（prettier / eslint --fix），缺失不报错
  if [ -d frontend ]; then
    (
      cd frontend
      if [ -f package.json ] && has pnpm && [ -d node_modules ]; then
        # 检查是否声明了 lint/format 脚本
        if pnpm run --silent 2>/dev/null | grep -qE "^(lint|format|check)$"; then
          if pnpm run --silent 2>/dev/null | grep -q "^lint$"; then
            log "  frontend: pnpm lint --fix"
            pnpm lint --fix >/dev/null 2>&1 || true
          fi
          if pnpm run --silent 2>/dev/null | grep -q "^format$"; then
            log "  frontend: pnpm format"
            pnpm format >/dev/null 2>&1 || true
          fi
        else
          warn "  frontend 未声明 lint/format 脚本，跳过"
        fi
      else
        warn "  frontend 缺少 pnpm 或 node_modules，跳过"
      fi
    )
  fi
}

stage_format_incremental() {
  # 仅用于 PostToolUse 阶段：gofmt -w 当前包，快速写回
  log "PostToolUse：gofmt -w 增量修复"
  if has gofmt; then
    gofmt -w . >/dev/null 2>&1 || true
    ok "gofmt 增量完成"
  fi
}

stage_build() {
  log "阶段 2/4：编译验证 (go build ./...)"
  if has go; then
    if go build ./...; then
      ok "go build 通过"
    else
      err "go build 失败，停止后续流程"
      return 1
    fi
  else
    warn "未找到 go，跳过"
  fi
}

stage_test() {
  log "阶段 3/4：单元测试 (go test ./...)"
  if has go; then
    # 跳过开关：POST_EDIT_SKIP_TEST=1 时跳过测试（适用于已知失败或快速验证 commit 路径）
    if [ "${POST_EDIT_SKIP_TEST:-0}" = "1" ]; then
      warn "POST_EDIT_SKIP_TEST=1，跳过测试阶段（注意：测试失败不会被记录）"
      return 0
    fi
    # -count=1 关闭测试缓存，确保每次都是真实运行
    if go test ./... -count=1 -timeout 120s; then
      ok "go test 通过"
    else
      err "go test 失败，停止后续流程"
      return 1
    fi
  else
    warn "未找到 go，跳过"
  fi
}

stage_commit() {
  log "阶段 4/4：git add + commit（中文记录）"

  if ! has git; then
    warn "未找到 git，跳过提交"
    return 0
  fi

  # 检查是否在 git 仓库
  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    warn "当前目录不是 git 仓库，跳过提交"
    return 0
  fi

  # 检查是否有变更
  if git diff --quiet HEAD 2>/dev/null && git diff --cached --quiet 2>/dev/null; then
    ok "工作区干净，无需提交"
    return 0
  fi

  # 生成中文 commit 信息
  COMMIT_MSG="$(make_commit_message)"
  log "提交信息："
  printf '  %s\n' "$COMMIT_MSG" | head -10

  git add -A
  if git commit -m "$COMMIT_MSG"; then
    ok "git commit 成功：$(git rev-parse --short HEAD)"
  else
    err "git commit 失败"
    return 1
  fi
}

make_commit_message() {
  # 优先策略：
  #   1. 从 Stop payload 的 lastAssistantText 提取首段（最多 300 字，保留 commit 标题/正文结构）
  #   2. 否则从 git diff --stat + 文件名提取精确摘要（变更行数 + 关键文件）
  #   3. 兜底模板
  #
  # v2.33 改写（用户反馈："commit 应该是具体的功能改动说明，不要机械模板"）：
  #   - 不再强制 `chore: 模型自动提交` 前缀
  #   - 第一行直接用模型回复的首句（用户已写好 conventional commit 标题如 `fix: ...`）
  #   - body 用模型回复的完整首段（最多 300 字），保留问题/方案/测试说明
  #   - 兜底用 diff stat 生成"fix/feat: <文件> <行数> 行"等具体摘要

  local ASSISTANT_TEXT=""
  ASSISTANT_TEXT="$(printf '%s' "$PAYLOAD" | python3 -c "
import json,sys
try:
    d=json.loads(sys.stdin.read() or '{}')
    t=(d.get('lastAssistantText') or '').strip().replace('\r\n', '\n')
    if t:
        # 保留前 300 字的完整内容（让 commit message body 包含问题/方案/测试说明）
        # 优先在段落结束（双换行）处截断，其次在单换行/句号
        seps = ['\n\n', '\n', '。', '！', '？']
        cut = None
        for sep in seps:
            i = t.find(sep)
            # 至少保留 200 字，避免截得太短；最多 300 字
            if 200 <= i <= 300:
                cut = i
                break
        if cut is not None:
            t = t[:cut].rstrip()
        else:
            # 找不到合适分隔符：截前 300 字
            head = t[:300]
            if len(t) > len(head):
                t = head.rstrip() + '…'
        print(t)
except Exception:
    pass
" 2>/dev/null || true)"

  if [ -n "$ASSISTANT_TEXT" ]; then
    # 不再强制 'chore: 模型自动提交' 前缀 —— 直接用模型回复的完整首段
    # 模型自己写的 commit 标题（fix:/feat:/refactor:/style: 等）就是第一行
    printf '%s' "$ASSISTANT_TEXT"
    return 0
  fi

  # 兜底 1：从 git diff stat 提取精确摘要（文件 + 行数）
  local DIFF_SUMMARY
  DIFF_SUMMARY="$(git diff --cached --stat 2>/dev/null | tail -1 || git diff --stat 2>/dev/null | tail -1 || true)"
  if [ -n "$DIFF_SUMMARY" ]; then
    # 从 stat 提取文件名前缀（取第一个文件名）
    local FIRST_FILE
    FIRST_FILE="$(git diff --cached --name-only 2>/dev/null | head -1 || git diff --name-only 2>/dev/null | head -1 || true)"
    if [ -n "$FIRST_FILE" ]; then
      local BASENAME="${FIRST_FILE##*/}"
      printf 'chore: %s 改动\n\n变更摘要：%s' "$BASENAME" "$DIFF_SUMMARY"
    else
      printf 'chore: 代码改动\n\n变更摘要：%s' "$DIFF_SUMMARY"
    fi
  else
    # 兜底 2：没有 diff 时用 git status
    local STATUS_LINE
    STATUS_LINE="$(git status --short 2>/dev/null | head -1 || true)"
    if [ -n "$STATUS_LINE" ]; then
      printf 'chore: %s' "$STATUS_LINE"
    else
      printf 'chore: 代码改动'
    fi
  fi
}

# ---------- 主流程 ----------
case "$EVENT" in
  PostToolUse)
    stage_format_incremental
    exit 0
    ;;
  Stop)
    log "Stop 事件触发 → 完整后处理流程"
    # 任何 stage_* 失败时 exit 1，且不再继续后续阶段
    stage_format || { err "格式化阶段失败"; exit 1; }
    stage_build  || { err "编译阶段失败"; exit 1; }
    stage_test   || { err "测试阶段失败，不提交（请修复测试后重试）"; exit 1; }
    stage_commit || { err "提交阶段失败"; exit 1; }
    ok "全部阶段通过"
    exit 0
    ;;
  SessionStart|SessionEnd|PreCompact|UserPromptSubmit|PreToolUse|PostLLMCall|SubagentStop|Notification|"")
    # 忽略这些事件，避免副作用
    exit 0
    ;;
  *)
    warn "未知事件：$EVENT，跳过"
    exit 0
    ;;
esac