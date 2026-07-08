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

trim_text() {
  awk '{$1=$1; print}'
}

is_conventional_subject() {
  printf '%s' "$1" | grep -Eq '^(feat|fix|refactor|perf|chore|test|docs|style)(\([^)]+\))?: .+'
}

is_bad_summary_subject() {
  printf '%s' "$1" | grep -Eqi '^(#+[[:space:]]*)?(修复总结|修复完成|完成|编译错误修复完成|完整动态宽度修复|真正的根因|性能优化总结|所有[[:space:]]*[0-9]*[[:space:]]*(个|项)?[[:space:]]*todo|所有 todos|全部阶段通过|交付总结)'
}

is_generic_fallback_subject() {
  printf '%s' "$1" | grep -Eqi '^(feat|fix|refactor|perf|chore|test|docs|style)(\([^)]+\))?: 优化 (git-graph 时间线|代码改动|Reasonix hooks 提交说明|项目文档|.*工具逻辑)$'
}

normalize_commit_subject() {
  local RAW SUBJECT
  RAW="$(printf '%s' "$1" | tr -d '\r')"
  SUBJECT="$(printf '%s\n' "$RAW" | sed -n '/./{p;q;}')"
  SUBJECT="$(printf '%s' "$SUBJECT" | sed -E 's/^#+[[:space:]]*//; s/^`([^`]+)`$/\1/' | trim_text)"
  if [ "${POST_EDIT_COMMIT_STYLE:-}" = "concise-conventional" ] && ! is_conventional_subject "$SUBJECT"; then
    return 1
  fi
  if is_bad_summary_subject "$SUBJECT"; then
    return 1
  fi
  if is_conventional_subject "$SUBJECT"; then
    printf '%s' "$SUBJECT" | cut -c 1-72
    return 0
  fi
  return 1
}

guess_commit_type() {
  local FIRST
  FIRST="$(primary_changed_file)"
  # v0.5.0 bugfix 复盘 (ac897fc): primary 是项目文档但同时改了非文档代码/视图时，
  # type 不应该选 docs（否则 fallback 会生成 docs: 伪装标题被 commit-msg hook 拦下）。
  # 先看是否有非文档改动，有的话用 primary_non_doc_file 重新判定。
  if has_non_doc_changes; then
    FIRST="$(primary_non_doc_file || true)"
    if [ -z "$FIRST" ]; then
      FIRST="$(primary_changed_file)"
    fi
  fi
  if printf '%s\n' "$FIRST" | grep -Eq '(^|/)(README|AGENTS|CLAUDE|docs/|.*\.md$)'; then
    printf 'docs'
  elif printf '%s\n' "$FIRST" | grep -Eq '(^|/)(.*(_test|\.test|\.spec)\.|tests?/)' ; then
    printf 'test'
  elif printf '%s\n' "$FIRST" | grep -Eq '(^|/)(package.json|pnpm-lock.yaml|go.mod|go.sum|wails.json|scripts/|\.reasonix/)'; then
    printf 'chore'
  elif printf '%s\n' "$FIRST" | grep -Eq '\.(css|scss|vue)$'; then
    printf 'fix'
  else
    printf 'fix'
  fi
}

primary_changed_file() {
  local FILES FIRST PRIORITY
  FILES="$(git diff --cached --name-only 2>/dev/null; git diff --name-only 2>/dev/null)"
  PRIORITY="$(printf '%s\n' "$FILES" | grep -E '^(scripts/hooks/|\.reasonix/)' | sed -n '/./{p;q;}')"
  if [ -n "$PRIORITY" ]; then
    printf '%s' "$PRIORITY"
    return 0
  fi
  PRIORITY="$(printf '%s\n' "$FILES" | grep -E '^frontend/src/views/TimelineNewView\.vue$|^app/git/graph/' | sed -n '/./{p;q;}')"
  if [ -n "$PRIORITY" ]; then
    printf '%s' "$PRIORITY"
    return 0
  fi
  FIRST="$(printf '%s\n' "$FILES" | sed -n '/./{p;q;}')"
  printf '%s' "$FIRST"
}

# v0.5.0 bugfix 复盘 (ac897fc)：「docs: 更新项目文档」 commit 实际改了
# frontend/src/stores/pull.ts + frontend/src/views/MergesView.vue + 删除 scripts/review_code.go，
# 因为 primary_changed_file 拿到 AGENTS.md 就把 type 判为 docs、area 判为「项目文档」。
# commit-msg hook 能拦住 docs: 伪装 commit，但更上游应该不生成这种 subject。
#
# has_non_doc_changes: 当 staged/工作区中有任何不属于 docs 白名单的文件时返回 0，
# 让 describe_changed_area 跳过 docs 区域，避免后续 fallback 生成 docs: 标题。
has_non_doc_changes() {
  local FILES F
  FILES="$(git diff --cached --name-only 2>/dev/null; git diff --name-only 2>/dev/null)"
  while IFS= read -r F; do
    [ -z "$F" ] && continue
    case "$F" in
      AGENTS.md|CLAUDE.md|README*|CHANGELOG*|LICENSE*|CONTRIBUTING*|CODE_OF_CONDUCT*) continue ;;
      docs/*|*.md|.github/*) continue ;;
      *) return 0 ;;
    esac
  done <<EOF
$FILES
EOF
  return 1
}

# primary_non_doc_file: 当 staged/工作区中有非文档文件时返回首个非文档文件路径。
# (在 hooks 路径里的优先于其他)
primary_non_doc_file() {
  local FILES F
  FILES="$(git diff --cached --name-only 2>/dev/null; git diff --name-only 2>/dev/null)"
  while IFS= read -r F; do
    [ -z "$F" ] && continue
    case "$F" in
      AGENTS.md|CLAUDE.md|README*|CHANGELOG*|LICENSE*|CONTRIBUTING*|CODE_OF_CONDUCT*) continue ;;
      docs/*|*.md|.github/*) continue ;;
      *) printf '%s' "$F"; return 0 ;;
    esac
  done <<EOF
$FILES
EOF
  return 1
}

describe_changed_area() {
  local FIRST BASE AREA NON_DOC
  FIRST="$(primary_changed_file)"
  BASE="${FIRST##*/}"
  # v0.5.0 bugfix 复盘 (ac897fc): 当 primary 是项目文档但同时改了非文档代码/视图时，
  # area 不应该选「项目文档」(否则 fallback 会生成 docs: 伪装标题，被 commit-msg hook 拦下)。
  # 直接用首个非文档文件作为 area 源头。
  if has_non_doc_changes; then
    NON_DOC="$(primary_non_doc_file || true)"
    if [ -n "$NON_DOC" ]; then
      FIRST="$NON_DOC"
      BASE="${FIRST##*/}"
    fi
  fi
  case "$FIRST" in
    frontend/src/views/TimelineNewView.vue) AREA="git-graph 时间线" ;;
    frontend/src/components/*) AREA="${BASE%.*} 组件" ;;
    frontend/src/views/*) AREA="${BASE%.*} 页面" ;;
    frontend/src/stores/*) AREA="${BASE%.*} 状态" ;;
    frontend/src/lib/*) AREA="${BASE%.*} 工具逻辑" ;;
    app/git/graph/*) AREA="git-graph 布局算法" ;;
    app/git/*) AREA="git 客户端" ;;
    app/platform/*) AREA="平台接口" ;;
    app/store/*) AREA="本地状态存储" ;;
    scripts/hooks/*|.reasonix/*) AREA="Reasonix hooks 提交说明" ;;
    docs/*|*.md) AREA="项目文档" ;;
    *) AREA="${BASE%.*}" ;;
  esac
  if [ -z "$AREA" ]; then
    AREA="代码改动"
  fi
  printf '%s' "$AREA"
}

fallback_commit_subject() {
  local TYPE AREA
  TYPE="$(guess_commit_type)"
  AREA="$(describe_changed_area)"
  case "$AREA" in
    *提交说明*) printf '%s: 优化 %s' "$TYPE" "$AREA" ;;
    项目文档) printf '%s: 更新项目文档' "$TYPE" ;;
    代码改动) printf '%s: 优化代码改动' "$TYPE" ;;
    *) printf '%s: 优化 %s' "$TYPE" "$AREA" ;;
  esac
}

subject_from_details() {
  local TEXT TYPE LINE
  TEXT="$(printf '%s' "$1" | tr -d '\r')"
  TYPE="$(guess_commit_type)"

  if printf '%s\n' "$TEXT" | grep -Eq '表头中文化'; then
    printf '%s: 中文化 git-graph 表头' "$TYPE"
  elif printf '%s\n' "$TEXT" | grep -Eq 'author/date/sha.*minmax|作者、日期、SHA.*遮挡|最后 3 列.*遮挡'; then
    printf '%s: 放宽作者日期 SHA 列宽' "$TYPE"
  elif printf '%s\n' "$TEXT" | grep -Eq 'minmax\(480px, 1fr\).*minmax\(60px|描述列.*内部.*空白'; then
    printf '%s: 降低描述列最小宽度' "$TYPE"
  elif printf '%s\n' "$TEXT" | grep -Eq 'desc 列.*1fr|描述列.*占用.*屏宽|占满剩余'; then
    printf '%s: 让描述列占满剩余宽度' "$TYPE"
  elif printf '%s\n' "$TEXT" | grep -Eq '移除.*graph.*占位|graph 占位列|130px 空白'; then
    printf '%s: 移除提交行图形占位列' "$TYPE"
  elif printf '%s\n' "$TEXT" | grep -Eq 'userHandleLeft|handleLeft.*svgWidth|持久化.*380'; then
    printf '%s: 按 lane 数限制图形列宽' "$TYPE"
  elif printf '%s\n' "$TEXT" | grep -Eq '放弃 flex|文字流|display: block'; then
    printf '%s: 改用文字流展示提交描述' "$TYPE"
  elif printf '%s\n' "$TEXT" | grep -Eq 'margin-left: auto|紧跟 subject|紧跟提交'; then
    printf '%s: 让分支标记紧跟提交标题' "$TYPE"
  elif printf '%s\n' "$TEXT" | grep -Eq 'commit-subject.*commit-refs.*之前|subject.*贴左'; then
    printf '%s: 让提交标题优先左对齐' "$TYPE"
  elif printf '%s\n' "$TEXT" | grep -Eq 'accounts\[0\]|projectId.*Platform|按 platform 分流'; then
    printf '%s: 按项目平台选择同步入口' "$TYPE"
  elif printf '%s\n' "$TEXT" | grep -Eq 'COL_WIDTH.*10|lane 间距|FLOW_LEFT_PAD|中线对齐'; then
    printf '%s: 统一 GitHub 与 Gitea 图谱间距' "$TYPE"
  else
    LINE="$(printf '%s\n' "$TEXT" |
      awk '
        /^(问题|根因|验证|统计|变更文件|总结|修复完成|本轮修复总结)/ { next }
        /^\*\*(问题|根因|验证|修复|效果)/ { next }
        /^(修复|调整|统一|新增|移除|去掉|限制|放宽|改用|让)/ {
          gsub(/^[-*0-9.[:space:]]+/, "")
          gsub(/[`*_（）()]/, "")
          print
          exit
        }
      ' |
      sed -E 's/[：:].*$//; s/[。；;].*$//' | trim_text)"
    if [ -n "$LINE" ]; then
      printf '%s: %s' "$TYPE" "$LINE" | cut -c 1-72
    fi
  fi
}

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

  git add -A

  # 生成中文 commit 信息
  COMMIT_MSG="$(make_commit_message)"
  log "提交信息："
  printf '  %s\n' "$COMMIT_MSG" | head -10

  local MSG_FILE
  MSG_FILE="$(mktemp "${TMPDIR:-/tmp}/gitea-kanban-commit-msg.XXXXXX")"
  printf '%s\n' "$COMMIT_MSG" > "$MSG_FILE"
  if git commit -F "$MSG_FILE"; then
    rm -f "$MSG_FILE"
    ok "git commit 成功：$(git rev-parse --short HEAD)"
  else
    rm -f "$MSG_FILE"
    err "git commit 失败"
    return 1
  fi
}

assistant_text() {
  printf '%s' "$PAYLOAD" | python3 -c "
import json, re, sys
try:
    d=json.loads(sys.stdin.read() or '{}')
    t=(d.get('lastAssistantText') or '').strip().replace('\r\n', '\n')
    t=re.sub(r'\n?<oai-mem-citation>.*?</oai-mem-citation>\s*$', '', t, flags=re.S).strip()
    print(t[:4000])
except Exception:
    pass
" 2>/dev/null || true
}

commit_body() {
  local TEXT="$1"
  local FILES STAT BODY
  BODY="$(printf '%s\n' "$TEXT" |
    sed -E 's/^#+[[:space:]]*//; s/^已完成[：:]?[[:space:]]*//g' |
    awk '
      NR == 1 && /^(feat|fix|refactor|perf|chore|test|docs|style)(\([^)]+\))?: / { next }
      /^改动说明[：:]?[[:space:]]*$/ { next }
      /^本轮无新指令/ { next }
      /^---[[:space:]]*$/ { exit }
      /^\[goal:/ { exit }
      /^判定：active goal/ { next }
      /^未跑的验证/ { exit }
      /^你的下一步/ { exit }
      /^Commit[[:space:]]*$/ { exit }
      /^```/ { exit }
      /noise_filter|受限|不可 practical|下一步|兜底/ { next }
      { print }
    ' |
    sed '/^$/N;/^\n$/D' |
    head -60)"
  FILES="$(git diff --cached --name-status 2>/dev/null | sed -n '1,12p' || true)"
  STAT="$(git diff --cached --stat 2>/dev/null | tail -1 || true)"

  if [ -n "$BODY" ]; then
    printf '改动说明：\n%s\n\n' "$BODY"
  fi
  if [ -n "$FILES" ]; then
    printf '变更文件：\n'
    printf '%s\n' "$FILES" | sed 's/^/- /'
    printf '\n'
  fi
  if [ -n "$STAT" ]; then
    printf '统计：\n- %s\n' "$STAT"
  fi
}

make_commit_message() {
  # 优先策略：
  #   1. 从 Stop payload 的 lastAssistantText 提取明确的 conventional commit 标题
  #   2. 标题不可信时按实际变更文件兜底
  #   3. 正文保留 Stop 事件的详细改动描述 + 变更文件摘要
  #
  # v2.35 改写：
  #   - 截图风格固定为短中文 Conventional Commit 标题
  #   - commit body 保留详细改动描述，避免 Stop 自动提交只剩一句标题
  #   - 拒绝"修复总结 / 所有 todos 完成 / 完成"等模型最终回复标题
  #   - 兜底基于实际变更区域生成，例如 `fix: 优化 git-graph 时间线`

  local ASSISTANT_TEXT SUBJECT BODY
  ASSISTANT_TEXT="$(assistant_text)"

  if [ -n "$ASSISTANT_TEXT" ]; then
    SUBJECT="$(normalize_commit_subject "$ASSISTANT_TEXT" || true)"
  fi

  if [ -n "$ASSISTANT_TEXT" ] && { [ -z "$SUBJECT" ] || is_generic_fallback_subject "$SUBJECT"; }; then
    local DETAIL_SUBJECT
    DETAIL_SUBJECT="$(subject_from_details "$ASSISTANT_TEXT" || true)"
    if [ -n "$DETAIL_SUBJECT" ]; then
      SUBJECT="$DETAIL_SUBJECT"
    fi
  fi

  if [ -z "$SUBJECT" ]; then
    SUBJECT="$(fallback_commit_subject | cut -c 1-72)"
  fi

  BODY="$(commit_body "$ASSISTANT_TEXT")"
  if [ -n "$BODY" ]; then
    printf '%s\n\n%s' "$SUBJECT" "$BODY"
  else
    printf '%s' "$SUBJECT"
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
