/**
 * 全局命令面板（⌘K）—— v1.1.2 主题切换入口 3
 *
 * 设计来源（SSOT）：
 *   - design-system/pages/tech-refine.md §15.1（3 入口之一：命令面板 ⌘K）
 *   - design-system/gitea-kanban/OVERRIDE.md §本项目专属规则 #1（零术语）
 *
 * 范围（task spec · 2026-06-12 / v1.2 收敛 2026-06-13）：
 *   - 按 ⌘K (mac) / Ctrl+K (其他) 打开 / 关闭 dialog
 *   - 输入框 + 命令列表，prefix 匹配（includes · 不做 fuzzy）
 *   - Enter 触发当前选中命令；Esc 关闭；↑/↓ 移动选中
 *   - 当前 v1 接 2 个主题命令（v1.2 收敛自 v1.1.2 的 3 个）
 *
 * 主题命令 label（跟 stores/ui.ts 的 THEME_DISPLAY_NAME 同步 · task spec 1:1 对齐）：
 *   - "主题: 暗色 · 中性近黑" → applyTheme('dark')
 *   - "主题: 浅色 · 浅苍蓝"   → applyTheme('light')
 *
 * 预留扩展（v1 不做）：
 *   - fuzzy 算法（v1 用 prefix / includes 即可）
 *   - 命令历史 / 收藏（COMMAND_GROUPS 数组结构预留多组 + section 维度分组）
 *   - 接其他命令（结构已留位：往 COMMAND_GROUPS 推 group 即可）
 *
 * 架构（与 toast.ts / confirm.ts 同模式）：
 *   - 控制 API + 状态放本 .ts 文件，可被 main.ts 入口直接 import
 *   - UI 用 vanilla DOM 创建（不引 Vue SFC，main.ts mount 之前就能用）
 *   - 样式用内联字符串注入到 <head>，**不**污染 theme.css
 *
 * 边界（AGENTS §5.2 frontend agent · task spec 强约束）：
 *   - ✅ 不碰 app/**
 *   - ✅ 不改 frontend/wailsjs/wailsjs/go/main/App.d.ts
 *   - ✅ 不动 frontend/src/styles/theme.css
 *   - ✅ 不动其他 frontend/src/lib/*（toast.ts / confirm.ts / ipc-client.ts）
 *   - ✅ 只 import 现有 useUiStore / THEME_DISPLAY_NAME，**不**改 store
 *   - ✅ 只 import toast 用来"命令执行失败"提示（lazy import，run 失败兜底用）
 *   - ✅ main.ts 改：import + 调 mountCommandPalette()（task spec §4 明确算本任务范畴）
 *
 * v0.3.0 注：v1 Electron 时代的 src/main/ / src/preload/ / src/renderer/ 边界已废弃。

import { useUiStore, THEME_DISPLAY_NAME, type Theme } from '@renderer/stores/ui';
import { showToast } from '@renderer/lib/toast';

// ============================================================================
// 命令模型（v1 极简版：扁平 Command[] + 视觉分组用 section id）
// ============================================================================

/** 命令执行回调（同步 / 异步均可；v1 主题切换是 fire-and-forget） */
type CommandRun = () => void | Promise<void>;

export interface Command {
  /** 唯一 id（DOM dataset 用 · 调试用） */
  id: string;
  /** 视觉分组用（同一 section 的命令之间加 divider） */
  section: string;
  /** 列表里显示的标题（用户可输入匹配） */
  title: string;
  /** 右侧灰色提示（如"默认"） */
  hint?: string;
  run: CommandRun;
}

export interface CommandGroup {
  id: string;
  /** 分组小标题（divider 上面） */
  label: string;
  commands: Command[];
}

// ============================================================================
// 主题命令（v1 唯一命令组 · 跟 stores/ui.ts 的 THEME_CYCLE_ORDER / THEME_DISPLAY_NAME 同步）
// ============================================================================

/**
 * 当前主题在 ⌘K 打开时**不**特别标注（v1 简化）—— 用户执行后再看 StatusBar 顶
 * 栏 + App 主区颜色变化感知；v2 考虑加 "✓ 当前" 标记（要读 useUiStore().currentTheme）。
 */
const THEME_COMMANDS: Command[] = (
  ['dark', 'light'] as const satisfies readonly Theme[]
).map<Command>((theme) => ({
  id: `theme:${theme}`,
  section: 'theme',
  title: `主题: ${THEME_DISPLAY_NAME[theme]}`,
  hint: theme === 'dark' ? '默认' : undefined,
  run: () => {
    // applyTheme 是 async（同步改 DOM + 异步持久化 IPC）—— fire-and-forget
    // 内部已经接 toast 失败兜底（IPC set 失败时弹"主题保存失败，请重试"）
    void useUiStore().applyTheme(theme);
  },
}));

/** 全局命令清单（v1 只主题一组；预留多组扩展位） */
const COMMAND_GROUPS: readonly CommandGroup[] = [
  { id: 'theme', label: '主题', commands: THEME_COMMANDS },
];

// ============================================================================
// 匹配（prefix / includes · v1 不做 fuzzy）
// ============================================================================

/** 简单 includes 匹配：title 里能找到子串即命中（不区分大小写） */
function filterCommands(query: string): Command[] {
  const q = query.trim().toLowerCase();
  const all = COMMAND_GROUPS.flatMap((g) => g.commands);
  if (!q) return all;
  return all.filter((c) => c.title.toLowerCase().includes(q));
}

// ============================================================================
// 状态（模块内单例 · 跟 toast.ts 同模式）
// ============================================================================

interface PaletteState {
  isOpen: boolean;
  query: string;
  selectedIndex: number;
  filtered: Command[];
}

const state: PaletteState = {
  isOpen: false,
  query: '',
  selectedIndex: 0,
  filtered: THEME_COMMANDS,
};

function refreshFiltered(): void {
  state.filtered = filterCommands(state.query);
  if (state.selectedIndex >= state.filtered.length) {
    state.selectedIndex = Math.max(0, state.filtered.length - 1);
  }
}

// ============================================================================
// DOM 注入（vanilla · 一次 mount 永久节点 · open/close 切 display）
// ============================================================================

let mounted = false;
let rootEl: HTMLDivElement | null = null;
let inputEl: HTMLInputElement | null = null;
let listEl: HTMLDivElement | null = null;

function createEl<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  return el;
}

function buildDOM(): void {
  if (mounted) return;
  if (typeof document === 'undefined') return;

  // backdrop + panel 一体
  rootEl = createEl('div', 'cmd-palette');
  rootEl.style.display = 'none';
  rootEl.setAttribute('role', 'dialog');
  rootEl.setAttribute('aria-modal', 'true');
  rootEl.setAttribute('aria-label', '命令面板');

  // 点击 backdrop 关闭（点到 panel 外）
  rootEl.addEventListener('mousedown', (e) => {
    if (e.target === rootEl) closePalette();
  });

  const panel = createEl('div', 'cmd-palette__panel');

  // 输入框
  inputEl = createEl('input', 'cmd-palette__input');
  inputEl.type = 'text';
  inputEl.placeholder = '输入命令或主题名称...';
  inputEl.spellcheck = false;
  inputEl.autocomplete = 'off';
  inputEl.setAttribute('aria-label', '命令输入框');
  inputEl.addEventListener('input', () => {
    state.query = inputEl!.value;
    refreshFiltered();
    renderList();
  });
  inputEl.addEventListener('keydown', handleKeydown);
  panel.appendChild(inputEl);

  // 列表
  listEl = createEl('div', 'cmd-palette__list');
  listEl.setAttribute('role', 'listbox');
  listEl.setAttribute('aria-label', '匹配命令');
  panel.appendChild(listEl);

  // 底栏（键帽提示）
  const footer = createEl('div', 'cmd-palette__footer');
  footer.appendChild(makeKeyHint('选择', ['↑', '↓']));
  footer.appendChild(makeKeyHint('执行', ['↵']));
  footer.appendChild(makeKeyHint('关闭', ['Esc']));
  panel.appendChild(footer);

  rootEl.appendChild(panel);
  document.body.appendChild(rootEl);
  mounted = true;
}

/** 构造一个 "<kdb>↑</kdb><kdb>↓</kdb> 选择" 形式的提示 span */
function makeKeyHint(label: string, keys: string[]): HTMLSpanElement {
  const span = createEl('span', 'cmd-palette__hint');
  for (const k of keys) {
    const kbd = createEl('kbd', 'cmd-palette__kbd');
    kbd.textContent = k;
    span.appendChild(kbd);
  }
  const txt = createEl('span', 'cmd-palette__hint-label');
  txt.textContent = label;
  span.appendChild(txt);
  return span;
}

// ============================================================================
// 列表渲染（每次 query 变 / 初次 open 重渲染）
// ============================================================================

function renderList(): void {
  if (!listEl) return;
  listEl.innerHTML = '';

  if (state.filtered.length === 0) {
    const empty = createEl('div', 'cmd-palette__empty');
    empty.textContent = '没有匹配的命令';
    listEl.appendChild(empty);
    return;
  }

  // 按 section 分组（视觉分组：上一组结束加 divider + 新组开头加 group label）
  let lastSectionId: string | null = null;
  state.filtered.forEach((cmd, idx) => {
    if (cmd.section !== lastSectionId) {
      if (lastSectionId !== null) {
        const divider = createEl('div', 'cmd-palette__divider');
        listEl!.appendChild(divider);
      }
      const group = COMMAND_GROUPS.find((g) => g.id === cmd.section);
      if (group) {
        const label = createEl('div', 'cmd-palette__group-label');
        label.textContent = group.label;
        listEl!.appendChild(label);
      }
      lastSectionId = cmd.section;
    }

    const item = createEl('div', 'cmd-palette__item');
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(idx === state.selectedIndex));
    item.dataset.idx = String(idx);
    item.dataset.id = cmd.id;
    if (idx === state.selectedIndex) item.classList.add('is-selected');

    item.addEventListener('click', () => {
      state.selectedIndex = idx;
      runSelected();
    });
    item.addEventListener('mouseenter', () => {
      if (state.selectedIndex !== idx) {
        state.selectedIndex = idx;
        updateSelection();
      }
    });

    const title = createEl('span', 'cmd-palette__item-title');
    title.textContent = cmd.title;
    item.appendChild(title);

    if (cmd.hint) {
      const hint = createEl('span', 'cmd-palette__item-hint');
      hint.textContent = cmd.hint;
      item.appendChild(hint);
    }

    listEl!.appendChild(item);
  });
}

function updateSelection(): void {
  if (!listEl) return;
  const items = listEl.querySelectorAll<HTMLElement>('.cmd-palette__item');
  items.forEach((it, i) => {
    const selected = i === state.selectedIndex;
    it.classList.toggle('is-selected', selected);
    it.setAttribute('aria-selected', String(selected));
    if (selected) it.scrollIntoView({ block: 'nearest' });
  });
}

// ============================================================================
// 键盘事件（input 内部 keydown）
// ============================================================================

function handleKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault();
    closePalette();
    return;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (state.filtered.length === 0) return;
    state.selectedIndex = (state.selectedIndex + 1) % state.filtered.length;
    updateSelection();
    return;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (state.filtered.length === 0) return;
    state.selectedIndex = (state.selectedIndex - 1 + state.filtered.length) % state.filtered.length;
    updateSelection();
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    runSelected();
    return;
  }
}

// ============================================================================
// 打开 / 关闭
// ============================================================================

function openPalette(): void {
  buildDOM();
  if (!rootEl || !inputEl) return;
  state.isOpen = true;
  state.query = '';
  state.selectedIndex = 0;
  inputEl.value = '';
  refreshFiltered();
  rootEl.style.display = 'flex';
  // next tick：display 切到 flex 后 focus 才生效
  setTimeout(() => {
    inputEl?.focus();
    renderList();
  }, 0);
}

function closePalette(): void {
  state.isOpen = false;
  if (rootEl) rootEl.style.display = 'none';
}

function togglePalette(): void {
  if (state.isOpen) closePalette();
  else openPalette();
}

function runSelected(): void {
  const cmd = state.filtered[state.selectedIndex];
  if (!cmd) return;
  // 关闭在前 → 用户立即看到 dialog 收起（applyTheme 内部还要走 IPC 异步持久化）
  closePalette();
  try {
    void cmd.run();
  } catch (err) {
    // 命令同步抛错时落 toast（v1 主题命令不会抛，但预留扩展位）
    showToast({
      type: 'error',
      message: '命令执行失败',
      description: err instanceof Error ? err.message : String(err),
    });
  }
}

// ============================================================================
// 挂载（main.ts 入口调一次）
// ============================================================================

let _globalKeyHandlerInstalled = false;

/**
 * 注册全局 ⌘K / Ctrl+K 快捷键 + 注入 dialog DOM。
 *
 * 调用时机：main.ts 入口，**必须**在 `app.use(pinia)` 之后（useUiStore 依赖 active pinia）。
 * 当前 main.ts 调法：`app.mount('#app')` 之后调 mountCommandPalette()，确保 pinia active。
 *
 * 幂等：重复调用只注册一次快捷键 + 一次 DOM 注入。
 */
export function mountCommandPalette(): void {
  if (typeof window === 'undefined') return;
  if (mounted && _globalKeyHandlerInstalled) return;
  injectCSS();
  buildDOM();
  window.addEventListener('keydown', handleGlobalKeydown);
  _globalKeyHandlerInstalled = true;
}

function handleGlobalKeydown(e: KeyboardEvent): void {
  // ⌘K (mac) / Ctrl+K (其他) 切换开关
  const isMod = e.metaKey || e.ctrlKey;
  if (isMod && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    togglePalette();
    return;
  }
  // Esc 关闭（仅打开时响应；input keydown 已经处理了，但兜底一下焦点失焦场景）
  if (state.isOpen && e.key === 'Escape') {
    e.preventDefault();
    closePalette();
  }
}

// ============================================================================
// 样式（内联注入 <head>，避免污染 theme.css）
//
// 走主题 token · 2 主题自适应（dark / light）
// 阴影 / 描边 / glow 跟 design-system/gitea-kanban/OVERRIDE §v1.2 决策一致
// ============================================================================

let cssInjected = false;
function injectCSS(): void {
  if (cssInjected || typeof document === 'undefined') return;
  const style = document.createElement('style');
  style.dataset.source = 'command-palette';
  style.textContent = COMMAND_PALETTE_CSS;
  document.head.appendChild(style);
  cssInjected = true;
}

const COMMAND_PALETTE_CSS = `
/* ============================================================
 * 命令面板（⌘K）· v1.2 主题切换入口 3
 *
 * 走主题 token，2 主题自适应（dark / light）
 * 注入到 <head>，**不**污染 theme.css
 * ============================================================ */

.cmd-palette {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 18vh;
  background: var(--color-bg-overlay);
  animation: cmd-palette-fade var(--t-base) var(--ease-out);
}

.cmd-palette__panel {
  width: min(540px, 92vw);
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  background: var(--color-bg-elevated);
  border-radius: var(--radius-modal);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
  animation: cmd-palette-slide var(--t-base) var(--ease-out);
}

.cmd-palette__input {
  width: 100%;
  padding: var(--space-4) var(--space-5);
  font-size: var(--font-lg);
  color: var(--color-text);
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--color-divider);
  border-radius: 0;
  outline: none;
}

.cmd-palette__input::placeholder {
  color: var(--color-text-muted);
}

.cmd-palette__input:focus {
  background: transparent;
  box-shadow: none;
}

.cmd-palette__list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-2) 0;
}

.cmd-palette__group-label {
  padding: var(--space-2) var(--space-5) var(--space-1);
  font-size: var(--font-xs);
  font-weight: 600;
  color: var(--color-text-muted);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.cmd-palette__divider {
  height: 1px;
  margin: var(--space-1) 0;
  background: var(--color-divider);
}

.cmd-palette__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-5);
  cursor: pointer;
  border-left: 2px solid transparent;
  transition:
    background var(--t-fast) var(--ease),
    border-color var(--t-fast) var(--ease);
}

.cmd-palette__item:hover {
  background: var(--color-bg-hover);
}

.cmd-palette__item.is-selected {
  background: var(--color-bg-hover);
  border-left-color: var(--color-primary);
}

.cmd-palette__item-title {
  flex: 1;
  min-width: 0;
  font-size: var(--font-md);
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cmd-palette__item-hint {
  flex-shrink: 0;
  font-size: var(--font-sm);
  color: var(--color-text-muted);
}

.cmd-palette__empty {
  padding: var(--space-6) var(--space-5);
  text-align: center;
  color: var(--color-text-muted);
  font-size: var(--font-sm);
}

.cmd-palette__footer {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-5);
  border-top: 1px solid var(--color-divider);
  background: var(--color-canvas);
}

.cmd-palette__hint {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--font-xs);
  color: var(--color-text-muted);
}

.cmd-palette__kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 var(--space-1);
  font-family: var(--font-mono-stack);
  font-size: var(--font-xs);
  color: var(--color-text);
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-divider-strong);
  border-radius: var(--radius-chip);
  font-feature-settings: 'cv11', 'ss01';
}

.cmd-palette__hint-label {
  margin-left: 2px;
}

/* 进入 / 离开动画（v1 简化：单步淡入 + 顶部下推） */
@keyframes cmd-palette-fade {
  from { opacity: 0; }
  to   { opacity: 1; }
}

@keyframes cmd-palette-slide {
  from { opacity: 0; transform: translateY(-8px); }
  to   { opacity: 1; transform: translateY(0); }
}

@media (prefers-reduced-motion: reduce) {
  .cmd-palette,
  .cmd-palette__panel {
    animation: none;
  }
}
`;
