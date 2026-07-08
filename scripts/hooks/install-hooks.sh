#!/usr/bin/env bash
# install-hooks.sh — 一键安装项目 commit-msg hook
#
# 用途：
#   scripts/hooks/check-commit-message.sh 是 commit-msg hook，
#   但 .git/hooks/ 不进版本库，每个开发者 clone 后需要手动安装。
#
# 本脚本创建 symlink 到 .git/hooks/commit-msg：
#   $ ln -sf ../../scripts/hooks/check-commit-message.sh .git/hooks/commit-msg
#
# 用法：
#   bash scripts/hooks/install-hooks.sh
#
# 卸载：
#   rm .git/hooks/commit-msg
#
# 幂等：重复运行不会破坏现有 hook。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
HOOK_SRC="$SCRIPT_DIR/check-commit-message.sh"
HOOK_DST="$PROJECT_ROOT/.git/hooks/commit-msg"

if [ ! -d "$PROJECT_ROOT/.git" ]; then
  echo "[install-hooks] 当前不是 git 仓库（缺少 .git/），跳过安装" 1>&2
  exit 0
fi

if [ ! -f "$HOOK_SRC" ]; then
  echo "[install-hooks] 找不到 $HOOK_SRC" 1>&2
  exit 1
fi

# 如果 commit-msg 已经是 symlink 到我们的脚本，no-op
if [ -L "$HOOK_DST" ] && [ "$(readlink "$HOOK_DST")" = "../../scripts/hooks/check-commit-message.sh" ]; then
  echo "[install-hooks] commit-msg hook 已安装，跳过"
  exit 0
fi

# 如果 commit-msg 存在但是别的 hook（用户自建），提示不要覆盖
if [ -e "$HOOK_DST" ] || [ -L "$HOOK_DST" ]; then
  echo "[install-hooks] 检测到现有 commit-msg hook（$HOOK_DST）" 1>&2
  echo "[install-hooks] 如要覆盖请先备份：mv $HOOK_DST ${HOOK_DST}.bak" 1>&2
  echo "[install-hooks] 然后重新运行本脚本" 1>&2
  exit 1
fi

ln -sf ../../scripts/hooks/check-commit-message.sh "$HOOK_DST"
chmod +x "$HOOK_SRC"
echo "[install-hooks] ✅ commit-msg hook 安装成功"
echo "[install-hooks]   $HOOK_DST -> $HOOK_SRC"
echo "[install-hooks] 验证：git commit -m 'docs: 测试' (有 staged .go 时应被拒)"