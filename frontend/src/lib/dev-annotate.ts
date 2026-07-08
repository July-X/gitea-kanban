/**
 * Dev 模式注解插件 —— 仅 import.meta.env.DEV 时挂载
 *
 * 用途（v1.1.3 落地）：
 *   - dev 启动时，给所有带 `v-dev-annotate` 指令的按钮/菜单/导航条目注入一个
 *     右上的小 `!` 图标；点击后弹出 popover 说明"这个 UI 元素对应 gitea 网页
 *     哪个功能 / gitea API 哪个端点 / 本地 IPC 哪个方法"
 *   - 主要目的：开发期验证数据来源的正确性（user 2026-06-13 提的诉求）
 *   - 生产构建：**完全不可见**——Vite 把 `import.meta.env.DEV` 编译成字面量
 *     `false`，main.ts 里 `if (import.meta.env.DEV) app.use(devAnnotate)` 整段
 *     变死代码，rollup 摇掉；指令的 mounted 钩子不挂、! 按钮不注入、popover
 *     不渲染
 *
 * 使用：
 *   ```vue
 *   <button v-dev-annotate="{
 *     web: '/<owner>/<repo>/branches',
 *     api: 'GET /api/v1/repos/<owner>/<repo>/branches',
 *     ipc: 'branches.list'
 *   }">分支</button>
 *   ```
 *   （占位用 <owner>/<repo>/<ref>，跟 gitea API 文档风格一致；<ref> 是 git ref
 *     概念——分支名 / tag / sha 都行）
 *
 *   简写（单字符串）：`<button v-dev-annotate="'对应 gitea /branches 页'">…</button>`
 *
 * 架构（跟 toast.ts / command-palette.ts 同模式）：
 *   - 状态（annotation / annotationAnchor）放本 .ts，单例 ref
 *   - DevAnnotatePopover.vue 订阅 annotation 自动渲染
 *   - 指令直接操作 DOM 注入 ! 按钮（不走 Vue 组件，性能 + 体积都更好）
 *   - main.ts 顶层 `if (import.meta.env.DEV) app.use(devAnnotate)` —— Vite
 *     静态替换 + rollup DCE，生产包零侵入
 *
 * 边界（AGENTS §5.2 frontend agent）：
 *   - ✅ 不碰 app 目录
 *   - ✅ 不改 frontend/wailsjs/wailsjs/go/main/App.d.ts
 *   - ✅ 不动 frontend/src/styles/theme.css（popover 样式走 DevAnnotatePopover.vue scoped）
 *   - ✅ 不引第三方库（用原生 alert/console 都不需要，popover 自渲染）
 *
 * v0.3.0 注：v1 Electron 时代的 src/main/ / src/preload/ / src/renderer/ 边界已废弃。
 */

import type { App, DirectiveBinding } from 'vue';
import { ref, type Ref } from 'vue';

// =============================================================
// 注解数据结构
// =============================================================

/**
 * 结构化注解（推荐用法）
 * - web：gitea 网页 URL 模板（用 <owner>/<repo>/<ref> 等占位）
 * - api：gitea REST API 端点（含 method + path + query）
 * - ipc：本地 IPC 方法名（renderer 调主进程那个）
 * - notes：自由补充（如数据来源、缓存策略、特殊处理等）
 */
export interface DevAnnotation {
  web?: string;
  api?: string;
  ipc?: string;
  notes?: string;
}

/** 指令 binding.value 接受 DevAnnotation 或纯字符串 */
export type DevAnnotationValue = DevAnnotation | string;

// =============================================================
// 全局 popover 状态（单例 ref，popover 组件订阅）
// =============================================================

/** 当前打开的注解（null = 没打开） */
export const annotation: Ref<DevAnnotation | null> = ref(null);

/** 当前注解的 anchor 元素（! 按钮本身，用于定位 popover） */
export const annotationAnchor: Ref<HTMLElement | null> = ref(null);

/** 关闭 popover */
export function dismissAnnotation(): void {
  annotation.value = null;
  annotationAnchor.value = null;
}

// =============================================================
// 内部 helpers
// =============================================================

/** 把 binding.value（结构化对象或字符串）规范成对象（popover 渲染用） */
function normalize(value: DevAnnotationValue | undefined): DevAnnotation | null {
  if (value == null) return null;
  if (typeof value === 'string') return { notes: value };
  return value;
}

// =============================================================
// 指令实现
// =============================================================

/**
 * 给元素附加一个 `!` 触发按钮 + click 监听
 *
 * 关键点：
 *   - 元素 position 不是 relative/absolute 时强设为 relative（让 ! 能绝对定位）
 *   - ! 按钮用 absolute 定位在元素内部右上角（top: 2px, right: 2px），避免被父容器裁剪
 *   - 已有 position 时不覆盖
 */
function attachTrigger(el: HTMLElement, value: DevAnnotationValue): void {
  // 记录原 position 以便 unmounted 还原（避免污染元素自身的样式）
  const prevPosition = el.style.position;
  if (prevPosition === '' || prevPosition === 'static') {
    el.style.position = 'relative';
  } else {
    // 已经有 relative/absolute 就不动 —— 但记个标记让 unmounted 别去清
    el.dataset.devAnnotateKeptPosition = '1';
  }

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'dev-annotate__trigger';
  trigger.setAttribute('aria-label', '查看数据来源（仅开发模式）');
  trigger.title = '查看数据来源（仅开发模式）';
  trigger.textContent = '!';
  // 阻止冒泡避免触发外层 button / router-link 的 click
  trigger.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const normalized = normalize(value);
    if (!normalized) return;
    annotation.value = normalized;
    annotationAnchor.value = trigger;
  });
  // 阻止 mousedown 冒泡（一些组件用 mousedown 触发 toggle，如手风琴 head）
  trigger.addEventListener('mousedown', (e) => {
    e.stopPropagation();
  });
  el.appendChild(trigger);
  // 标记：让 unmounted 知道是这个指令加的
  trigger.dataset.devAnnotateTrigger = '1';
}

function detachTrigger(el: HTMLElement): void {
  const trigger = el.querySelector<HTMLElement>('[data-dev-annotate-trigger="1"]');
  if (trigger) trigger.remove();
  if (!el.dataset.devAnnotateKeptPosition) {
    el.style.position = '';
  }
  delete el.dataset.devAnnotateKeptPosition;
}

// =============================================================
// Vue 插件
// =============================================================

const STYLE_ID = 'dev-annotate-styles';

/**
 * 触发器样式
 *
 * 注意：触发器是 directive 直接用 document.createElement 注入的 DOM，
 * 不在 Vue SFC 树里，scoped 样式碰不到它。必须在 install 时把样式
 * 注入 <head>，确保 dev 启动后 ! 按钮视觉正确；生产 plugin 不挂，
 * 这段 CSS 也不进 bundle（被 dead-code elimination 摇掉）。
 */
const TRIGGER_CSS = `
.dev-annotate__trigger {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 14px;
  height: 14px;
  padding: 0;
  border-radius: 50%;
  background: var(--color-warning, #f59e0b);
  color: #1a1a1a;
  font-size: 9px;
  font-weight: 700;
  font-family: var(--font-mono-stack, monospace);
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: help;
  z-index: 10;
  opacity: 0.85;
  border: 1px solid var(--color-bg-elevated, #fff);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
  transition: opacity 120ms ease, transform 120ms ease;
}
.dev-annotate__trigger:hover,
.dev-annotate__trigger:focus-visible {
  opacity: 1;
  transform: scale(1.1);
  outline: none;
  box-shadow: 0 0 0 2px var(--color-bg-elevated, #fff), 0 0 0 4px var(--color-warning, #f59e0b);
}
`;

/** 注入 trigger 样式到 <head>，幂等 */
function injectTriggerStyles(): void {
  if (typeof document === 'undefined') return; // SSR 防御（v1 不走 SSR 但写上）
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = TRIGGER_CSS;
  document.head.appendChild(style);
}

/**
 * 装入 Vue app 后：
 *   1. 注入触发器样式
 *   2. 注册全局指令 `v-dev-annotate`
 *
 * main.ts 用法（条件挂载，Vite 编译期消除）：
 *   ```ts
 *   if (import.meta.env.DEV) {
 *     const { devAnnotate } = await import('./lib/dev-annotate');
 *     app.use(devAnnotate);
 *   }
 *   ```
 */
export const devAnnotate = {
  install(app: App): void {
    injectTriggerStyles();
    app.directive<HTMLElement, DevAnnotationValue>('dev-annotate', {
      mounted(el, binding: DirectiveBinding<DevAnnotationValue>) {
        attachTrigger(el, binding.value);
      },
      updated(el, binding: DirectiveBinding<DevAnnotationValue>) {
        // value 变了就更新 click handler —— 但 trigger 是新对象引用时重建更稳
        // 简单做法：先 detach 再 attach（覆盖式）
        if (binding.value !== binding.oldValue) {
          detachTrigger(el);
          attachTrigger(el, binding.value);
        }
      },
      unmounted(el) {
        detachTrigger(el);
      },
    });
  },
};
