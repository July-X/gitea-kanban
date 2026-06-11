/**
 * settings store —— 用户偏好设置（polling interval / UI 偏好）
 *
 * 设计（AGENTS §5.2 + 03-frontend §6）：
 *   - **临时**用 localStorage 存（prefs IPC 端点未注册，要 §7.1 拍板才加）
 *   - 未来迁移路径：localStorage key 'gitea-kanban.prefs' → main 端 prefs 表
 *   - 默认值：pollingInterval = 300_000ms（5 min）
 *
 * 边界：
 *   - 30s 最小（防止刷爆 gitea）
 *   - 30min 最大（防止太久不刷）
 */

import { defineStore } from 'pinia';
import { ref } from 'vue';

const DEFAULT_POLLING_INTERVAL_MS = 5 * 60 * 1000;
const MIN_POLLING_INTERVAL_MS = 30 * 1000;
const MAX_POLLING_INTERVAL_MS = 30 * 60 * 1000;
const STORAGE_KEY = 'gitea-kanban.prefs';

interface PersistedPrefs {
  pollingIntervalMs?: number;
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
  const loading = ref(false);

  /** 写回 localStorage（key=gitea-kanban.prefs） */
  async function setPollingIntervalMs(ms: number): Promise<void> {
    if (ms < MIN_POLLING_INTERVAL_MS || ms > MAX_POLLING_INTERVAL_MS) {
      throw new Error(`pollingInterval 必须在 ${MIN_POLLING_INTERVAL_MS}-${MAX_POLLING_INTERVAL_MS}ms 之间`);
    }
    pollingIntervalMs.value = ms;
    writeToStorage({ pollingIntervalMs: ms });
  }

  return {
    pollingIntervalMs,
    loading,
    setPollingIntervalMs,
  };
});

export const SETTINGS_LIMITS = {
  MIN_POLLING_INTERVAL_MS,
  MAX_POLLING_INTERVAL_MS,
  DEFAULT_POLLING_INTERVAL_MS,
};
