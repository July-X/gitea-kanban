#!/usr/bin/env bash
# check-commit-message.sh — git commit-msg hook
#
# v0.5.0 bugfix 防再发：拦截「伪装成 docs commit 实际改了 store/视图」的提交。
#
# 触发方式（手动安装，不进 git）：
#   ln -sf ../../scripts/hooks/check-commit-message.sh .git/hooks/commit-msg
#
# 规则：
#   1. 当 commit subject 以 `docs:` 开头时，校验 staged files 必须全部属于文档白名单。
#      白名单 = AGENTS.md / CLAUDE.md / docs/**.md / *.md (项目根) / README* / CHANGELOG*
#   2. 任何含 frontend/src/** / app/** / main.go / wails.json / go.mod / go.sum / package.json
#      / pnpm-lock.yaml / .vue / .ts / .go 等非文档路径的 docs commit → exit 1 拒绝。
#   3. 非 docs commit 不做限制。
#
# 设计：白名单优先（更稳），新增文件类型只在白名单里就放行。
# 失败提示给出违规文件清单 + 修正建议，方便 reasonix 模型下一次提交自动改对。
#
# 关闭方法（如需临时绕过）：
#   SKIP_DOCS_COMMIT_CHECK=1 git commit -m "..."

set -euo pipefail

COMMIT_MSG_FILE="$1"

# 读 subject（commit message 第一行非空行）
SUBJECT="$(awk 'NF { sub(/^#.*$/, ""); print; exit }' "$COMMIT_MSG_FILE" 2>/dev/null || true)"

# 仅检查 docs: 前缀
case "$SUBJECT" in
  docs:*) ;;
  *) exit 0 ;;
esac

# 跳过开关
if [ "${SKIP_DOCS_COMMIT_CHECK:-0}" = "1" ]; then
  echo "[hook] SKIP_DOCS_COMMIT_CHECK=1，跳过 docs commit 文件白名单校验" 1>&2
  exit 0
fi

# 取 staged files（包括新增 / 修改 / 删除）
STAGED="$(git diff --cached --name-only 2>/dev/null || true)"
if [ -z "$STAGED" ]; then
  # merge / amend 等场景可能没有 staged files，直接放行
  exit 0
fi

# 文档白名单
is_doc_path() {
  case "$1" in
    AGENTS.md|CLAUDE.md|README*|CHANGELOG*|LICENSE*|CONTRIBUTING*|CODE_OF_CONDUCT*) return 0 ;;
    docs/*|docs/**/*.md) return 0 ;;
    *.md) return 0 ;;
    .github/*) return 0 ;;  # issue template / PR template 也算文档
    *) return 1 ;;
  esac
}

VIOLATIONS=""
while IFS= read -r F; do
  [ -z "$F" ] && continue
  if ! is_doc_path "$F"; then
    VIOLATIONS="${VIOLATIONS}${F}\n"
  fi
done <<EOF
$STAGED
EOF

if [ -n "$VIOLATIONS" ]; then
  cat 1>&2 <<EOERR
[hook] docs commit 文件白名单校验失败 ❌

提交标题是「${SUBJECT}」，但 staged files 包含非文档文件：

$(printf "$VIOLATIONS" | sed 's/^/  - /')

docs commit 只允许改以下类型的文件：
  - AGENTS.md / CLAUDE.md（项目根）
  - docs/**/*.md（含 docs/adr/、docs/releases/、docs/design/）
  - README* / CHANGELOG* / LICENSE*（项目根）
  - 任何 *.md / .github/*

如果实际改的是代码，请改 commit subject 前缀，例如：
  - feat: 新增 XX 功能
  - fix: 修复 XX bug
  - chore: 整理 XX 代码

临时绕过（不推荐）：SKIP_DOCS_COMMIT_CHECK=1 git commit -m "..."
EOERR
  exit 1
fi

exit 0