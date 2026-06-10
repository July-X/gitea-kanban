#!/usr/bin/env bash
# scripts/rebuild-native.sh
#
# 把 better-sqlite3 native binding 重建到当前 electron ABI。
#
# 背景（AGENTS.md §8.11）：
# - better-sqlite3 prebuilt 同时发布 node ABI 和 electron ABI 两份
# - `pnpm install` 默认按 node ABI 装（vitest 跑测试用）
# - 但 dev / build / 打包都跑在 electron 进程里 → 必须用 electron ABI
# - `electron-builder install-app-deps` 在 pnpm 11 + @electron/rebuild 4.0.4
#   组合下静默不重建（输出 "completed" 但 .node mod time 不变，bug）
# - 改用 `prebuild-install --runtime=electron --target=<electron version>`
#   显式下载 electron ABI prebuilt，实测有效（2026-06-11 验证）
#
# 调用方：package.json postinstall
# 失败策略：打印 warn 不 exit 1（装包不应该因为这个 fail；用户可以手动再跑）
set -u

# 1. 找 better-sqlite3 在 pnpm store 里的实际路径
# pnpm 把所有依赖装在 node_modules/.pnpm/<name>@<version>/node_modules/<name>
# 选 version 最大的（最新 prebuilt 覆盖矩阵最广）
BSQLITE_DIR=$(ls -d node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 2>/dev/null | sort -V | tail -1)
if [ -z "$BSQLITE_DIR" ]; then
  echo "[rebuild-native] better-sqlite3 not found in pnpm store, skip"
  exit 0
fi

# 2. 取当前项目装的 electron 版本
ELECTRON_VERSION=$(node -p "require('electron/package.json').version" 2>/dev/null || echo "")
if [ -z "$ELECTRON_VERSION" ]; then
  echo "[rebuild-native] electron not found in package.json, skip"
  exit 0
fi

# 3. 用 prebuild-install 下载匹配 prebuilt
cd "$BSQLITE_DIR"
echo "[rebuild-native] target: electron $ELECTRON_VERSION at $BSQLITE_DIR"
if npx prebuild-install --runtime=electron --target="$ELECTRON_VERSION" 2>&1 | tail -5; then
  echo "[rebuild-native] ok: better-sqlite3 now matches electron $ELECTRON_VERSION ABI"
else
  echo "[rebuild-native] WARN: prebuild-install failed, run manually:"
  echo "  cd $BSQLITE_DIR && npx prebuild-install --runtime=electron --target=$ELECTRON_VERSION"
  # 不 exit 1，避免阻塞 pnpm install
fi
