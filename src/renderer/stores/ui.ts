/**
 * ui store —— 主题切换 state + applyTheme / initTheme action（v1.1.2 cycle 2 scope）
 *
 * 设计来源（SSOT）：design-system/pages/tech-refine.md §14-§16
 *   - §14    3 主题 token 系统（A 暗 / C 暗 / Light）—— theme.css 已落地
 *   - §15.1  3 入口（StatusBar cycle / Settings 外观 / 命令面板 ⌘K）→ 同一 store
 *   - §15.2  切换瞬间：localStorage 写 + DOM 改 + IPC set + 失败提示（不阻塞 UI）
 *   - §15.4  数据流：user → preload api.theme.set → main handler → sqlite → return → store applyTheme
 *   - §15.5  启动期：localStorage 同步（0ms） + IPC get 异步（50-200ms）reconcile
 *   - §16    IPC 契约：preferences.theme.{get,set}，ThemeName enum = 'A-dark' | 'C-dark' | 'light'
 *
 * 150ms 过渡说明：
 *   - theme.css 的 `*` 选择器已加 `transition: background-color 150ms ease-out, color 150ms ease-out`
 *     （theme-tokens task 落地）
 *   - 本 store 只触发 dataset.theme 改写，CSS 过渡由浏览器接管
 *   - 不阻塞 UI：IPC set 失败时**只**弹 toast，**不**回滚 currentTheme
 *     （localStorage 已写，DOM 已改——撤销反而让用户觉得"按了按钮没反应"）
 *
 * 边界（AGENTS §5.2 frontend agent）：
 *   - ✅ 不碰 src/main/**
 *   - ✅ 不改 src/shared/ipc-types.ts（只 import 类型 if 必要）
 *   - ✅ 不动 src/preload/**
 *   - ✅ 不动 src/renderer/styles/theme.css
 *   - ✅ 调用 IPC 通过 @renderer/lib/ipc-client 的 getIpcClient().invokeNested 通用入口
 *     （不新增 preferencesThemeGet/Set 具名 helper —— 与 board.columns.list 等
 *      嵌套 namespace 一致用 invokeNested；后续如多 store 复用可补 helper）
 */

import { defineStore } from 'pinia';
import { ref } from 'vue';
import { getIpcClient } from '@renderer/lib/ipc-client';
import { showToast } from '@renderer/lib/toast';

// ============================================================================
// 主题枚举（与 src/main/ipc/schema.ts ThemeEnumSchema 同步 · single source of truth）
// ============================================================================

export type Theme = 'A-dark' | 'C-dark' | 'light';

/** 默认主题（A 暗 · tech-refine §15.3 拍板） */
export const DEFAULT_THEME: Theme = 'A-dark';

/**
 * StatusBar cycle 顺序：A → C → L → A（暗 → 暗 → 亮 → 暗）
 * 选这个是因为「暗 → 暗 → 亮 → 暗」最后回到暗感觉自然；
 * 备选 A → L → C → A 会让 cycle 撞回前一个暗色时「亮度跳变」更大。
 */
export const THEME_CYCLE_ORDER: readonly Theme[] = [
  'A-dark',
  'C-dark',
  'light',
] as const;

/** localStorage 缓存 key（§15.5 启动期 0 闪烁；与 settings.ts 的 'gitea-kanban.prefs' 分开） */
export const THEME_STORAGE_KEY = 'gitea-kanban.theme';

/** 主题显示名（i18n 占位 · cycle 2 接到 src/shared/i18n 文案表） */
export const THEME_DISPLAY_NAME: Record<Theme, string> = {
  'A-dark': 'A 暗 · 苍蓝提饱和',
  'C-dark': 'C 暗 · 中性近黑',
  light: '浅色 · 浅苍蓝',
};

// ============================================================================
// 纯 helper（不依赖 IPC / DOM / store · cycle 2 立即可用）
// ============================================================================

/**
 * 给定当前主题，返回 cycle 下一个
 * 非法输入（不在 enum 3 选 1）回退到 THEME_CYCLE_ORDER[0]
 */
export function nextThemeInCycle(current: Theme): Theme {
  const idx = THEME_CYCLE_ORDER.indexOf(current);
  if (idx < 0) return THEME_CYCLE_ORDER[0]!;
  return THEME_CYCLE_ORDER[(idx + 1) % THEME_CYCLE_ORDER.length]!;
}

/** 类型守卫：s 是否合法 Theme（与 Zod enum 等价 · 离线场景用） */
export function isValidTheme(s: unknown): s is Theme {
  return typeof s === 'string' && (THEME_CYCLE_ORDER as readonly string[]).includes(s);
}

// ============================================================================
// IPC 调用（窄封装，避免 store action 体积膨胀）
// ============================================================================

/**
 * preferences.theme.get 出参（与 src/main/ipc/schema.ts ThemeGetResultSchema 同步）
 *
 * 这里**不**import schema.ts —— renderer 跨边界读 schema 是历史模式（auth.ts 那样），
 * 但本 task 只需要这个 DTO 类型，独立定义更轻；后续如 v2 收紧可统一抽到 src/shared/ipc-types.ts。
 */
interface ThemeGetResult {
  theme: Theme;
  changedAt: string;
}

/**
 * preferences.theme.get —— 拉远端持久化的主题
 *
 * 错误处理：
 * - DATABASE_UNAVAILABLE / NETWORK_OFFLINE → 静默，调用方保持 localStorage 值
 * - 其他错误 → 同样静默（启动期不让用户看到"主题加载失败"——会感觉系统坏了）
 */
async function fetchPersistedTheme(): Promise<Theme | null> {
  try {
    const result = (await getIpcClient().invokeNested(
      'preferences',
      'theme',
      'get',
      {},
    )) as ThemeGetResult | null;
    if (!result || !isValidTheme(result.theme)) return null;
    return result.theme;
  } catch {
    // 启动期任何错误都静默 —— localStorage 是兜底
    return null;
  }
}

/**
 * preferences.theme.set —— 持久化主题到 sqlite（异步，不阻塞 UI）
 *
 * 错误处理：失败抛 Error（normalizeError 已把 IpcError → UserFacingError），
 * 由 applyTheme 调方决定 toast 提示策略。
 */
async function persistTheme(theme: Theme): Promise<void> {
  await getIpcClient().invokeNested('preferences', 'theme', 'set', { theme });
}

// ============================================================================
// Pinia store
// ============================================================================

export const useUiStore = defineStore('ui', () => {
  // ===== state =====
  // 默认 = DEFAULT_THEME（不在这里读 localStorage —— 那是 initTheme 的活）
  const currentTheme = ref<Theme>(DEFAULT_THEME);

  // ===== actions =====

  /**
   * applyTheme —— 用户触发主题切换（StatusBar / Settings / ⌘K 都调它）
   *
   * 数据流（§15.4）：
   *   1. 写 currentTheme ref + documentElement.dataset.theme（CSS 150ms 过渡接管）
   *   2. 写 localStorage 同步缓存（启动期 initTheme 用，**不**是持久化主路径）
   *   3. 异步调 IPC preferences.theme.set（不阻塞 UI）
   *   4. 失败 → toast '主题保存失败，请重试'（不回滚 currentTheme）
   *
   * 不做 rollback 的理由：localStorage + DOM 已经改了，回滚会让用户感觉"按钮无反应"；
   * 错误是远端 sqlite 写失败，下次启动 initTheme 会用 localStorage 值（用户视角无感知）。
   *
   * 防御：非法 theme 输入直接 noop（runtime 校验，TS 之外兜底）。
   */
  async function applyTheme(theme: Theme): Promise<void> {
    if (!isValidTheme(theme)) {
      // 防御性：理论上 TS 已经保证 enum，这里兜底恶意调用 / 反序列化脏数据
      return;
    }

    // 1. 同步改 state + DOM（CSS 150ms 过渡由 theme.css `*` 选择器接管）
    currentTheme.value = theme;
    if (typeof document !== 'undefined') {
      document.documentElement.dataset.theme = theme;
    }

    // 2. 同步写 localStorage（启动期 0 闪烁缓存）
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // localStorage 不可用（隐私模式 / quota）—— 静默，下次启动 initTheme 走默认
    }

    // 3. 异步持久化到 sqlite（不 await 阻塞 UI）
    //    注：调用方也可以 await，但 UI 上**不**应该等
    persistTheme(theme).catch(() => {
      showToast({ type: 'error', message: '主题保存失败，请重试' });
    });
  }

  /**
   * initTheme —— 应用启动时调一次（App.vue mount 或 main.ts 入口）
   *
   * 数据流（§15.5）：
   *   1. 同步：localStorage 读 → 立即设 currentTheme + dataset.theme（**避免白屏**）
   *   2. 异步：fetchPersistedTheme() → 若不一致则 applyTheme(result)
   *
   * 容错：
   * - localStorage 读不到 / 值非法 → 用 DEFAULT_THEME
   * - IPC get 失败 / sqlite 没值 → 静默保留 localStorage 值
   * - IPC get 拿到值与 localStorage 一致 → noop（不重写 IPC）
   */
  async function initTheme(): Promise<void> {
    // 1. 同步：localStorage 兜底（避免启动期白屏闪烁）
    let initialTheme: Theme = DEFAULT_THEME;
    try {
      const cached = localStorage.getItem(THEME_STORAGE_KEY);
      if (isValidTheme(cached)) {
        initialTheme = cached;
      }
    } catch {
      // localStorage 不可用，保持 DEFAULT_THEME
    }
    currentTheme.value = initialTheme;
    if (typeof document !== 'undefined') {
      document.documentElement.dataset.theme = initialTheme;
    }

    // 2. 异步：拉远端持久化值，reconcile（启动期 50-200ms 后台完成）
    const persisted = await fetchPersistedTheme();
    if (persisted && persisted !== currentTheme.value) {
      // 不一致 → 重新 apply（会重写 localStorage + IPC set；首次 reconcile 无害，
      // 后续切换场景下不一致 = 远端更新了，启动期也应当同步上来）
      await applyTheme(persisted);
    }
  }

  return {
    // state
    currentTheme,
    // actions
    applyTheme,
    initTheme,
  };
});