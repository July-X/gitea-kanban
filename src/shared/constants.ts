/**
 * 共享常量
 *
 * 跨主进程 / 渲染进程 / preload 的常量集中地。
 */

/** Electron app 单例锁名 */
export const APP_SINGLE_INSTANCE_LOCK_NAME = 'io.gitea-kanban.app.single-instance';

/** 应用主窗口名（DevTools / 日志标识用） */
export const APP_NAME = 'gitea-kanban';

/** logs 子目录（$GITEA_KANBAN_DATA_DIR/logs/<dir> 或 ~/.gitea-kanban/logs/<dir>，详见 AGENTS §8.15） */
export const LOG_SUBDIR = 'main';

/** pino 日志保留天数 */
export const LOG_RETENTION_DAYS = 14;

/** keychain service 前缀（keychainAccount = `gitea-kanban@<giteaUrl>`） */
export const KEYCHAIN_SERVICE_PREFIX = 'gitea-kanban@';

/** token 内存缓存 TTL（毫秒）—— 减少 keychain 重复读 */
export const TOKEN_CACHE_TTL_MS = 5 * 60 * 1000;

/** 缓存 TTL 默认值（秒），资源级 TTL 走 cache/ttl.ts */
export const CACHE_TTL_DEFAULT_SECONDS = 300; // 5 min

/** 资源级 TTL（02-architecture.md §6.2 / §6.3 表格） */
export const CACHE_TTL = {
  REPO: 30 * 60,         // 30 min
  BRANCH: 5 * 60,        // 5 min
  COMMIT: 10 * 60,       // 10 min
  PULL: 2 * 60,          // 2 min
  ISSUE: 5 * 60,         // 5 min
  HOOK: 60 * 60,         // 1 h
} as const;

/** 后台轮询周期（毫秒）—— v1 默认不开 webhook server */
export const POLL_INTERVALS_MS = {
  PULL: 30 * 1000,       // 30 s
  COMMIT: 2 * 60 * 1000, // 2 min
  BRANCH: 5 * 60 * 1000, // 5 min
} as const;
