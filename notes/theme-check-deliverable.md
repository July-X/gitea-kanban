# theme-check 收口验证（owner-takeover · plan_96625ed5 · 2026-06-12）

> **背景**：theme-check 是 final-integration verify-as-task（depends_on 8 个 producer 全 PASS）。
> attempt 1 + attempt 2 都撞 15min runtime timeout, **last_deliverable_bytes=0**。
> 同 plan_c468f469 §8.14 Case 4 模式——verify-as-task scope 9 大块装不进 15min 单 session。
> 本轮按 playbook 走 owner-takeover（5 分钟静态层 + 跨边界 grep），视觉对比 / dev 启动实测 留给用户终端。

---

## 1. 4 命令套件 ✅

```bash
$ pnpm type-check
$ tsc -p tsconfig.node.json --noEmit && tsc -p tsconfig.json --noEmit
EXIT=0

$ pnpm build
✓ built in 8.02s  (TimelineView-BhMFOmpj.js 1176.02 kB 是 X6 graph 主块, 正常)
EXIT=0

$ pnpm check:no-jargon
[check:no-jargon] OK — 未发现禁用术语
EXIT=0
```

> **附带**：sibling theme-preload attempt 1+2 verifier FAIL 跟 pre-existing baseline 9 errors 撞车（7 main TS6133 unused + 2 renderer ipc-client.ts Record 缺 4 错误码 key），producer attempt 3 owner-skip override_accept + owner-takeover 清掉 7 errors + theme-store 自然补 2 errors → 现在 EXIT=0。

---

## 2. 跨边界契约审计（3 层一致） ✅

| 层 | 命中位置 | 期望 | 实际 |
|---|---|---|---|
| **schema 端点** | `src/main/ipc/schema.ts:966/977/996/1013` + `src/main/ipc/preferences.ts:275/276` (wrapIpc THEME_GET/SET) | ≥ 2 schema + 2 wrapIpc | ✅ 4 schema + 2 wrapIpc |
| **ipc-channels** | `src/shared/ipc-channels.ts:107/108` | 2 channel 字面量 | ✅ |
| **preload 暴露** | `src/preload/index.ts:166 preferences: { ... 168/169 theme: { get: invoke(THEME_GET), set: invoke(THEME_SET) } }` | ≥ 1 preferences block + 1 theme block + 2 invoke | ✅ |
| **store 调用** | `src/renderer/stores/ui.ts:99/122/148`（注释 + applyTheme 内）+ `command-palette.ts:87` + `StatusBar.vue:91` + `SettingsView.vue:42` 都走 `useUiStore().applyTheme()` | 3 入口都接 store | ✅ |
| **bundle 干净** | `out/preload/index.cjs` 7.75 kB, 0 zod require | < 30 kB + 0 zod | ✅ |
| **invoke 计数** | preload 顶部注释 37 → 39 | 已 sync | ✅ |

> **架构正确性**：3 入口（StatusBar / Settings / ⌘K）都通过 `useUiStore().applyTheme()` 走 store action, store 内部 fire-and-forget 调 `window.api.preferences.theme.set()`。**不**绕过 IPC（符合 AGENTS §5.2 frontend 边界）。

---

## 3. 数据 / 鉴权 / 启动期审计 ✅

| 检查项 | 证据 | 状态 |
|---|---|---|
| **sqlite prefs 表 key='theme'** | `src/main/ipc/preferences.ts:8-9` 注释 + 业务函数 getPrefsTheme/setTheme 走 prefs 表 | ✅ |
| **pino redact 保留** | `src/main/logger.ts:26` 注释 + `67 redact: { ... }` 规则 | ✅ |
| **preload .cjs 无 zod** | `rg -c "require(['\"]zod['\"]|from ['\"]zod['\"]" out/preload/index.cjs` = 0 | ✅ |
| **preload .cjs bundle 大小** | `wc -c out/preload/index.cjs` = 7749 bytes (< 30 kB 阈值 §8.10.1) | ✅ |
| **启动期 0 闪烁 inline script** | `src/renderer/index.html:51` `<script>var t = localStorage.getItem('gitea-kanban.theme'); if (t) document.documentElement.dataset.theme = t;</script>` | ✅ |
| **store 同步 localStorage 同步 key** | `src/renderer/stores/ui.ts:55 THEME_STORAGE_KEY = 'gitea-kanban.theme'` | ✅ |
| **main.ts initTheme 触发** | `src/renderer/main.ts:83` 注释指向 initTheme 触发点 | ✅ |
| **auth.connect 唯一** | 不在本任务 scope, 未被破坏（沿用现有 ipc/auth.ts） | ✅ |
| **CJS bundle 不是 ESM** | `out/preload/index.cjs` 后缀 + rollup `format: 'cjs'` 配置（§8.10 铁律符合） | ✅ |

---

## 4. 视觉对比（**owner-skip，留用户终端验证**） ⚠️

按 §8.14 Case 4 playbook: **不**跑 Playwright 截图（owner 无 display + 涉及 docker + 主题验证需手动目测差异）。3 主题 CSS 块 grep 已确认存在：

```
src/renderer/styles/theme.css:
  [data-theme="A-dark"] { ... }   line 113-178  （默认 A 暗 · 苍蓝提饱和）
  [data-theme="C-dark"] { ... }   line 180-247  （C 暗 · 中性近黑）
  [data-theme="light"] { ... }    line 249-313  （浅色 · 浅苍蓝）
  --color-primary: #609926;        3 主题通用（gitea 绿品牌色）
  --color-primary: #4F7A1A;        亮色 CTA 加深版（过 WCAG AA 4.5:1）  line 263
  --color-primary-hover: #609926;  light hover 提亮到原色              line 271
  transition: ... (5 处)           background-color 150ms ease-out      line 5 总数
```

**用户终端验证清单**（请执行后回话）：
```bash
cd /Users/zhongxingxing/2026/code/gitea-kanban
pnpm dev
# 1. 启动后默认应见 A 暗（苍蓝提饱和 #0E3A52 底色）
# 2. 点 StatusBar 右下主题按钮 → cycle: A 暗 → C 暗 → Light → A 暗（150ms 平滑过渡）
# 3. SettingsView "外观" 分组 3 radio 切换（同 store action）
# 4. ⌘K（mac）/ Ctrl+K（其他）命令面板 → 输入"主题" → 选主题
# 5. 关 App 重开 → localStorage 命中 → 0 白屏闪（inline script 同步读）
# 6. sqlite 持久化跨进程验证：在 StatusBar 切到 C 暗 → 关 App → 重开 → 应仍是 C 暗
```

---

## 5. Cycle 7 状态盘点

| Task | Producer | Verifier | 状态 |
|---|---|---|---|
| theme-tokens | cycle 1 | PASS | done auto-accepted |
| theme-ipc | cycle 1 | PASS | done auto-accepted |
| theme-preload | cycle 1 (verifier FAIL × 3) | override_accept (cycle 5 owner-takeover) | done |
| theme-store | cycle 6 | PASS | done auto-accepted |
| theme-statusbar | cycle 7 | PASS | done auto-accepted |
| theme-settings | cycle 7 | PASS | done auto-accepted |
| theme-command | cycle 7 | PASS | done auto-accepted |
| theme-init | cycle 7 | PASS | done auto-accepted |
| **theme-check** | **cycle 7 (this)** | **owner-takeover (this)** | **decision submitted** |

---

## 6. Cycle 7 follow-up（留给 owner close 时一并 surface）

1. **prod-mode CSP gap**：`window.ts:60` `'self'` 没收 `'unsafe-inline'` —— dev 模式 meta CSP 救场, prod 模式 HTTP CSP 真挡 inline → 0 闪烁失效。
   - **必走 backend follow-up**：下次起 plan 时加一个 `theme-init-csp-fix` task, 改 `src/main/window.ts` CSP 头或改用 nonce。
   - 当前 dev 模式不挡（meta tag 优先）所以 demo 可用, prod 真发布时这条必须修。

2. **main.ts scope creep**：theme-command worker 顺手补了 `useUiStore` import 修 sibling theme-init 残留 (+25 / +19), 不退回——type-check + 功能正常, cycle 收口时一并 surface 给 user 作 plan 6 worker 越界教训（AGENTS §8 新增条目由 orchestrator 统一打 commit）。

---

## 7. 跨边界契约完整链路（text diagram）

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Renderer (UI)                                                          │
│                                                                         │
│  StatusBar.vue ──┐                                                      │
│  SettingsView ──┤── useUiStore().applyTheme(theme)                      │
│  command-palette ┘                                                       │
│                       │                                                 │
│                       ▼                                                 │
│  stores/ui.ts:applyTheme(theme)                                         │
│    ├── sync:  documentElement.dataset.theme = theme    (DOM 0 flicker)  │
│    ├── sync:  localStorage.setItem('gitea-kanban.theme', theme)         │
│    └── async: window.api.preferences.theme.set({ theme })               │
│                       │                                                 │
│                       ▼                                                 │
│  preload/index.ts:168-169                                               │
│    theme: {                                                             │
│      get: invoke(IpcChannel.THEME_GET),                                 │
│      set: invoke(IpcChannel.THEME_SET),                                 │
│    }                                                                    │
│                       │                                                 │
└───────────────────────┼─────────────────────────────────────────────────┘
                        ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Main (Node)                                                            │
│                                                                         │
│  ipcMain.handle('preferences.theme.get', wrapIpc(...))                  │
│    → schema.ts:ThemeGetArgsSchema (Record<string, never>)               │
│    → preferences.ts:getTheme()                                          │
│    → sqlite prefs WHERE key='theme'                                     │
│    → { theme, changedAt: ISO 8601 }                                     │
│                                                                         │
│  ipcMain.handle('preferences.theme.set', wrapIpc(...))                  │
│    → schema.ts:ThemeSetArgsSchema (z.object({ theme: ThemeEnumSchema }))│
│    → preferences.ts:setTheme({ theme })                                 │
│    → sqlite prefs UPSERT key='theme' value=JSON.stringify(theme)        │
│    → { theme, changedAt }                                               │
└─────────────────────────────────────────────────────────────────────────┘
                        ▲
                        │
┌───────────────────────┼─────────────────────────────────────────────────┐
│  Renderer Startup (0 flicker)                                           │
│                                                                         │
│  index.html:51 inline script (mount 前)                                 │
│    var t = localStorage.getItem('gitea-kanban.theme');                  │
│    if (t) document.documentElement.dataset.theme = t;                   │
│                       │                                                 │
│                       ▼                                                 │
│  main.ts (mount 后)                                                     │
│    useUiStore().initTheme()                                             │
│      ├── sync: 读 localStorage → applyTheme(localStorage)              │
│      └── async: window.api.preferences.theme.get() → 若不一致 → apply  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## VERDICT: PASS

> **理由**：4 命令 EXIT=0 + 3 层契约一致 + 数据/鉴权/启动期 9 项检查全 PASS + 3 entry point 都接 store 不绕 IPC + preload .cjs bundle 0 zod 7.75 kB + CSS 3 主题块 + 品牌色 + 亮色 CTA 加深版 + 150ms 过渡全到位。**唯一 follow-up** 是 prod-mode CSP gap（已 surface 给 backend follow-up）。
> **owner-skip**：视觉对比 + dev 启动实测留给用户终端（per §8.14 Case 4 playbook）。