/**
 * 主进程配置加载
 *
 * 职责：
 * - 提供默认值（gitea URL、轮询间隔等）
 * - 不持久化——持久化在 localStore（state.json 的 prefs 子键）
 * - 不接用户输入（避免路径遍历，AGENTS.md §9.3）
 */

import {
  CACHE_TTL_DEFAULT_SECONDS,
  POLL_INTERVALS_MS,
} from '@shared/constants';

export interface AppConfig {
  /** gitea 轮询周期（毫秒） */
  poll: {
    pull: number;
    commit: number;
    branch: number;
  };
  /** 默认缓存 TTL（秒） */
  cacheTtlDefaultSeconds: number;
  /** token 内存缓存 TTL（毫秒） */
  tokenCacheTtlMs: number;
  /** 应用名（IPC channel 前缀 / 日志 tag） */
  appName: string;
  /** 是否开发模式 */
  isDev: boolean;
}

/**
 * 默认配置——所有数值都来自 @shared/constants，便于全局调
 */
export function loadConfig(): AppConfig {
  return {
    poll: {
      pull: POLL_INTERVALS_MS.PULL,
      commit: POLL_INTERVALS_MS.COMMIT,
      branch: POLL_INTERVALS_MS.BRANCH,
    },
    cacheTtlDefaultSeconds: CACHE_TTL_DEFAULT_SECONDS,
    tokenCacheTtlMs: 5 * 60 * 1000,
    appName: 'gitea-kanban',
    isDev: !isPackaged(),
  };
}

/**
 * 安全判断 packaged —— 替代直接 import electron.isPackaged
 * （electron 在测试环境可能未加载）
 */
function isPackaged(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as typeof import('electron');
    return app.isPackaged;
  } catch {
    // 测试环境无 electron
    return false;
  }
}

/** 全局单例 */
let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (!cached) cached = loadConfig();
  return cached;
}

/** 测试用：重置单例 */
export function _resetConfigForTest(): void {
  cached = null;
}
