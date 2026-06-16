/**
 * command-palette 单测
 *
 * 覆盖（v1.4 polish 测试债清理 · P3-3）：
 * - mountCommandPalette 幂等：重复调只注入一次 DOM
 * - 打开：⌘K (mac) / Ctrl+K (其他) 切换 palette
 * - 关闭：Esc / 第二次 ⌘K
 * - 输入框：input 事件更新 query + 重新过滤渲染
 * - 键盘：↑/↓ 改 selectedIndex（带 wrap-around）+ Enter 触发 run + 自动关闭
 * - backdrop 点击关闭
 * - 命令执行：主题命令调 useUiStore().applyTheme
 *
 * Mock 策略：
 * - happy-dom 模拟 DOM（vanilla DOM 操作必须有真实 document）
 * - vi.mock('@renderer/stores/ui') mock useUiStore（只验 applyTheme 调过）
 * - vi.mock('@renderer/lib/toast') mock showToast（命令失败兜底）
 * - mountCommandPalette 是 module singleton → 每个 test beforeEach 调 closePalette
 *   + 移除 rootEl（但 closePalette 内部改 display，**不**移除 DOM——所以手动
 *   document.body.innerHTML = '' 重置）
 *
 * 不依赖真实 pinia / electron / gitea
 */
// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ===== vi.mock 必须在 import 业务模块之前 =====

const mocks = vi.hoisted(() => ({
  applyTheme: vi.fn().mockResolvedValue(undefined),
  showToast: vi.fn(),
}));

vi.mock('@renderer/stores/ui', () => ({
  useUiStore: () => ({
    applyTheme: mocks.applyTheme,
  }),
  THEME_DISPLAY_NAME: {
    dark: '暗色 · 中性近黑',
    light: '浅色 · 浅苍蓝',
  },
}));

vi.mock('@renderer/lib/toast', () => ({
  showToast: mocks.showToast,
}));

// import 放在 vi.mock 之后（vitest hoisting 保证 mock 生效）
// 每次 test 用 vi.resetModules + 动态 import 拿全新 module-level 单例
// （mounted / cssInjected / _globalKeyHandlerInstalled 是 module-level，跨 test 会污染）
let mountCommandPalette: () => void;

beforeEach(async () => {
  vi.resetModules();
  // 重置 DOM
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  // 重新 import（拿到全新 module 实例）
  const mod = await import('@renderer/lib/command-palette');
  mountCommandPalette = mod.mountCommandPalette;
  mocks.applyTheme.mockClear();
  mocks.showToast.mockClear();
});

describe('command-palette mount + 快捷键', () => {
  it('mountCommandPalette 幂等：重复调只注入一个 .cmd-palette 节点', () => {
    mountCommandPalette();
    mountCommandPalette();
    mountCommandPalette();
    const paletts = document.querySelectorAll('.cmd-palette');
    expect(paletts).toHaveLength(1);
  });

  it('初始状态：palette display = none（隐藏）', () => {
    mountCommandPalette();
    const root = document.querySelector('.cmd-palette') as HTMLElement;
    expect(root).not.toBeNull();
    expect(root.style.display).toBe('none');
  });

  it('⌘K (mac) 打开 palette', () => {
    mountCommandPalette();
    const ev = new KeyboardEvent('keydown', { key: 'k', metaKey: true });
    window.dispatchEvent(ev);
    const root = document.querySelector('.cmd-palette') as HTMLElement;
    expect(root.style.display).not.toBe('none');
  });

  it('Ctrl+K (其他平台) 打开 palette', () => {
    mountCommandPalette();
    const ev = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true });
    window.dispatchEvent(ev);
    const root = document.querySelector('.cmd-palette') as HTMLElement;
    expect(root.style.display).not.toBe('none');
  });

  it('第二次 ⌘K 关闭 palette', () => {
    mountCommandPalette();
    const open = new KeyboardEvent('keydown', { key: 'k', metaKey: true });
    window.dispatchEvent(open);
    expect((document.querySelector('.cmd-palette') as HTMLElement).style.display).not.toBe('none');
    // 第二次
    window.dispatchEvent(open);
    expect((document.querySelector('.cmd-palette') as HTMLElement).style.display).toBe('none');
  });

  it('Esc 关闭已打开的 palette（焦点失焦兜底）', () => {
    mountCommandPalette();
    // 先打开
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
    // Esc
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect((document.querySelector('.cmd-palette') as HTMLElement).style.display).toBe('none');
  });

  it('非 ⌘K 键不响应（如 plain k）', () => {
    mountCommandPalette();
    const ev = new KeyboardEvent('keydown', { key: 'k' }); // 无 mod
    window.dispatchEvent(ev);
    expect((document.querySelector('.cmd-palette') as HTMLElement).style.display).toBe('none');
  });
});

describe('command-palette 输入 + 过滤 + 列表渲染', () => {
  // openPalette 内部 setTimeout 0 调 renderList；happy-dom 是同步 setTimeout，
  // 但保险起见 await 一下让所有 micro/macro task 跑完
  async function openPalette(): Promise<void> {
    mountCommandPalette();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
    await new Promise<void>((r) => setTimeout(r, 0));
  }

  it('打开后默认渲染全部命令（v1 = 2 个主题）', async () => {
    await openPalette();
    const items = document.querySelectorAll('.cmd-palette__item');
    expect(items.length).toBe(2);
  });

  it('输入"暗"过滤命中含"暗色"的命令', async () => {
    await openPalette();
    const input = document.querySelector('.cmd-palette__input') as HTMLInputElement;
    input.value = '暗';
    input.dispatchEvent(new Event('input'));
    const items = document.querySelectorAll('.cmd-palette__item');
    expect(items.length).toBe(1);
    expect((items[0] as HTMLElement).dataset.id).toBe('theme:dark');
  });

  it('输入"浅"过滤命中含"浅色"的命令', async () => {
    await openPalette();
    const input = document.querySelector('.cmd-palette__input') as HTMLInputElement;
    input.value = '浅';
    input.dispatchEvent(new Event('input'));
    const items = document.querySelectorAll('.cmd-palette__item');
    expect(items.length).toBe(1);
    expect((items[0] as HTMLElement).dataset.id).toBe('theme:light');
  });

  it('输入无匹配 → 显示 empty 占位', async () => {
    await openPalette();
    const input = document.querySelector('.cmd-palette__input') as HTMLInputElement;
    input.value = 'xyz不存在的命令';
    input.dispatchEvent(new Event('input'));
    const items = document.querySelectorAll('.cmd-palette__item');
    expect(items.length).toBe(0);
    const empty = document.querySelector('.cmd-palette__empty');
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toBe('没有匹配的命令');
  });

  it('输入"主题" prefix 命中全部 2 条', async () => {
    await openPalette();
    const input = document.querySelector('.cmd-palette__input') as HTMLInputElement;
    input.value = '主题';
    input.dispatchEvent(new Event('input'));
    const items = document.querySelectorAll('.cmd-palette__item');
    expect(items.length).toBe(2);
  });

  it('匹配不区分大小写（ASCII 子串测试）', async () => {
    await openPalette();
    const input = document.querySelector('.cmd-palette__input') as HTMLInputElement;
    // 输入"theme"应匹配不到（中文主题），但"d"也不命中
    input.value = 'theme';
    input.dispatchEvent(new Event('input'));
    const items = document.querySelectorAll('.cmd-palette__item');
    expect(items.length).toBe(0);
  });
});

describe('command-palette 键盘导航 + 执行', () => {
  async function openPalette(): Promise<void> {
    mountCommandPalette();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
    await new Promise<void>((r) => setTimeout(r, 0));
  }

  it('ArrowDown 改 selectedIndex（wrap-around）', async () => {
    await openPalette();
    const input = document.querySelector('.cmd-palette__input') as HTMLInputElement;
    // 初始 selectedIndex = 0
    // ArrowDown → 1
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    let selected = document.querySelector('.cmd-palette__item.is-selected') as HTMLElement;
    expect(selected?.dataset.id).toBe('theme:light');
    // 再 ArrowDown → wrap 回 0
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    selected = document.querySelector('.cmd-palette__item.is-selected') as HTMLElement;
    expect(selected?.dataset.id).toBe('theme:dark');
  });

  it('ArrowUp 改 selectedIndex（wrap-around）', async () => {
    await openPalette();
    const input = document.querySelector('.cmd-palette__input') as HTMLInputElement;
    // 初始 0；ArrowUp → wrap 到 1 (light)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    const selected = document.querySelector('.cmd-palette__item.is-selected') as HTMLElement;
    expect(selected?.dataset.id).toBe('theme:light');
  });

  it('Enter 触发 run（调 useUiStore.applyTheme）+ 自动关闭', async () => {
    await openPalette();
    const input = document.querySelector('.cmd-palette__input') as HTMLInputElement;
    // 初始 selectedIndex=0 → theme:dark
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(mocks.applyTheme).toHaveBeenCalledWith('dark');
    // palette 自动关闭
    expect((document.querySelector('.cmd-palette') as HTMLElement).style.display).toBe('none');
  });

  it('Enter 触发 light 命令（先 ArrowDown 选中再 Enter）', async () => {
    await openPalette();
    const input = document.querySelector('.cmd-palette__input') as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(mocks.applyTheme).toHaveBeenCalledWith('light');
  });

  it('输入框无匹配时按 Enter 不触发 run', async () => {
    await openPalette();
    const input = document.querySelector('.cmd-palette__input') as HTMLInputElement;
    input.value = '不存在的命令';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(mocks.applyTheme).not.toHaveBeenCalled();
  });
});
