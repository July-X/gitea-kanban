/**
 * settings store —— 用户偏好设置（polling interval / UI 偏好 / Git 二进制路径）
 *
 * 设计（AGENTS §5.2）：
 *   - **临时**用 localStorage 存（prefs IPC 端点未注册，要 §7.1 拍板才加）
 *   - 未来迁移路径：localStorage key 'gitea-kanban.prefs' → main 端 prefs 表
 *   - 默认值：pollingInterval = 300_000ms（5 min）
 *
 * 边界：
 *   - 30s 最小（防止刷爆 gitea）
 *   - 30min 最大（防止太久不刷）
 *
 * v0.4.0：gitBinaryPath 字段
 *   - 启动期从后端 App.GetGitBinaryConfig() 拉一次最新值（覆盖 localStorage）
 *   - 用户在 SettingsView 改完走 setGitBinaryPath → 后端持久化到 prefs map
 *   - 进程内即时生效（后端调 gitbinary.SetUserOverride）
 *   - 跨进程持久化（state.json prefs["app.gitBinaryPath"]）
 */

import { defineStore } from 'pinia';
import { ref } from 'vue';
import {
  getGitBinaryConfig,
  setGitBinaryPath,
  type GitBinaryConfig,
} from '@renderer/lib/ipc-client';

const DEFAULT_POLLING_INTERVAL_MS = 5 * 60 * 1000;
const MIN_POLLING_INTERVAL_MS = 30 * 1000;
const MAX_POLLING_INTERVAL_MS = 30 * 60 * 1000;
const STORAGE_KEY = 'gitea-kanban.prefs';

interface PersistedPrefs {
  pollingIntervalMs?: number;
  gitBinaryPath?: string;
}

function readFromStorage(): PersistedPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as PersistedPrefs;
  } catch {
    return {};
  }
}

function writeToStorage(p: PersistedPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* quota / privacy mode 静默 */
  }
}

export const useSettingsStore = defineStore('settings', () => {
  const initial = readFromStorage();
  const pollingIntervalMs = ref<number>(
    typeof initial.pollingIntervalMs === 'number' &&
      initial.pollingIntervalMs >= MIN_POLLING_INTERVAL_MS &&
      initial.pollingIntervalMs <= MAX_POLLING_INTERVAL_MS
      ? initial.pollingIntervalMs
      : DEFAULT_POLLING_INTERVAL_MS,
  );
  const gitBinaryPath = ref<string>(initial.gitBinaryPath ?? '');

  // v0.4.0：从后端拉最新 git binary 配置（覆盖 localStorage 旧值）
  // 后端会读 LocalState.prefs["app.gitBinaryPath"]，权威性高于 localStorage
  // 失败时静默回退到 localStorage 默认值
  const gitBinary = ref<GitBinaryConfig | null>(null);
  void (async (): Promise<void> => {
    try {
      const cfg = await getGitBinaryConfig();
      gitBinary.value = cfg;
      // 用后端 userOverride 覆盖 localStorage（避免两端不一致）
      if (cfg.userOverride !== gitBinaryPath.value) {
        gitBinaryPath.value = cfg.userOverride;
        writeToStorage({ pollingIntervalMs: pollingIntervalMs.value, gitBinaryPath: cfg.userOverride });
      }
    } catch {
      /* 离线 / Wails 未启动 静默 */
    }
  })();

  const loading = ref(false);

  /** 写回 localStorage（key=gitea-kanban.prefs） */
  async function setPollingIntervalMs(ms: number): Promise<void> {
    if (ms < MIN_POLLING_INTERVAL_MS || ms > MAX_POLLING_INTERVAL_MS) {
      throw new Error(
        `pollingInterval 必须在 ${MIN_POLLING_INTERVAL_MS}-${MAX_POLLING_INTERVAL_MS}ms 之间`,
      );
    }
    pollingIntervalMs.value = ms;
    writeToStorage({ pollingIntervalMs: ms, gitBinaryPath: gitBinaryPath.value });
  }

  /**
   * v0.4.0：保存用户填的 git binary 路径。
   *
   * 流程：
   *   1. 调后端 setGitBinaryPath → 写 LocalState.prefs + gitbinary.SetUserOverride
   *   2. 成功后刷新本地 gitBinary.value 反映 effectivePath
   *   3. 写 localStorage 备份（v0.5+ 仍可走 IPC，但保留双源）
   *   4. 失败抛 error 让 SettingsView 卡片 UI 提示
   */
  async function saveGitBinaryPath(path: string): Promise<GitBinaryConfig> {
    const trimmed = path.trim();
    await setGitBinaryPath(trimmed);
    // 重新拉一次 backend 配置拿到 effectivePath
    const cfg = await getGitBinaryConfig();
    gitBinary.value = cfg;
    gitBinaryPath.value = cfg.userOverride;
    writeToStorage({ pollingIntervalMs: pollingIntervalMs.value, gitBinaryPath: cfg.userOverride });
    return cfg;
  }

  return {
    pollingIntervalMs,
    gitBinaryPath,
    gitBinary,
    loading,
    setPollingIntervalMs,
    saveGitBinaryPath,
  };
});

export const SETTINGS_LIMITS = {
  MIN_POLLING_INTERVAL_MS,
  MAX_POLLING_INTERVAL_MS,
  DEFAULT_POLLING_INTERVAL_MS,
};
