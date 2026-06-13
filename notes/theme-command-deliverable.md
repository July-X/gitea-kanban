# theme-command 任务交付（frontend worker · 2026-06-12）

> **⚠️ 本文件描述的 v1.1.2 3 主题命令面板（⌘K：A 暗 / C 暗 / 浅色）已被 v1.2 推翻（2026-06-13）。**
> 当前 `THEME_COMMANDS` 数组为 `['dark', 'light']`（A 暗与 C 暗合并为 dark），命令标题更新为「暗色 · 中性近黑」「浅色 · 浅苍蓝」。详见 `design-system/gitea-kanban/OVERRIDE.md` v1.2 段落。本文件留作 history。

## 落地内容

落地 v1.1.2 主题切换的 **入口 3**：全局命令面板（⌘K / Ctrl+K）。

**新建 1 文件 + 改 1 文件**：
- `src/renderer/lib/command-palette.ts`（599 行）—— 命令面板核心
- `src/renderer/main.ts`（+3 行）—— 注册 mountCommandPalette + 补 useUiStore import

## 命令列表（v1 唯一一组：主题）

| id | title | hint | run |
|---|---|---|---|
| `theme:A-dark` | 主题: A 暗 · 苍蓝提饱和 | 默认 | `useUiStore().applyTheme('A-dark')` |
| `theme:C-dark` | 主题: C 暗 · 中性近黑 | — | `useUiStore().applyTheme('C-dark')` |
| `theme:light` | 主题: 浅色 · 浅苍蓝 | — | `useUiStore().applyTheme('light')` |

**title 跟 `src/renderer/stores/ui.ts` 的 `THEME_DISPLAY_NAME` 1:1 对齐** —— single source of truth。

## 快捷键

| 键 | 行为 |
|---|---|
| **⌘K (mac)** / **Ctrl+K (其他)** | 切换 dialog（关 ↔ 开） |
| **Esc** | 关闭（input 内 + window 全局双绑） |
| **↑ / ↓** | 移动选中（环形 cycle） |
| **Enter** | 触发当前选中命令 |
| 鼠标点击 backdrop | 关闭 |
| 鼠标点击 item | 触发该命令 |
| 鼠标 hover item | 移动选中（不触发） |

## 验证输出

### 1. `pnpm type-check`

```
$ tsc -p tsconfig.node.json --noEmit && tsc -p tsconfig.json --noEmit
（无输出，EXIT=0）
```

**隔离验证**（防 sibling race）：

| 实验 | 状态 | 结果 |
|---|---|---|
| HEAD baseline (stash main.ts 我的改动) | — | EXIT=0 ✓ |
| 含我的 main.ts 改动（不动 initTheme 那段） | — | **1 error** `main.ts(94,6): useUiStore is not defined`（sibling theme-init 残留） |
| 含我的 main.ts 改动（**补** useUiStore import） | — | EXIT=0 ✓ |

**结论**：1 个 TS error 来自 sibling theme-init 任务 worktree 残留（initTheme 调用 + 缺 import），**不**是我引入。补 1 行 import 修好。

### 2. `pnpm check:no-jargon`

```
[check:no-jargon] OK — 未发现禁用术语
```

**手审**（脚本只扫 .ts 不扫 .vue，但我也没改 .vue）：
- placeholder: "输入命令或主题名称..." ✓ 中文
- 空状态: "没有匹配的命令" ✓
- 底栏: "选择 / 执行 / 关闭" ✓
- 命令 title: "主题: X · Y"（3 条全中文）✓

### 3. 关键符号 grep

```
$ rg -c 'useUiStore|applyTheme' src/renderer/lib/command-palette.ts
10
```

10 命中（要求 ≥ 2）：import 1 + 注释 4 + 实际调用 2 + 文档 3 ✓

### 4. `pnpm build`

```
✓ 2787 modules transformed.
✓ built in 7.53s
```

renderer 357.20 kB → 356.93 kB（**-0.27 kB**；动态 import 改静态 import 微减）。

**Vite warning 消除**：之前 dynamic `void import('@renderer/lib/toast')` 触发 "dynamic import will not move module into another chunk"（toast 已被 main.ts 静态 import，dynamic import 浪费运行时开销）—— 改成静态 `import { showToast }` 解决。

### 5. `pnpm dev`（25s 测启）

```
out/main/index.js  160.00 kB
✓ built in 526ms
out/preload/index.cjs  7.75 kB
✓ built in 19ms
dev server running for the electron renderer process at:
  ➜  Local:   http://localhost:5173/
starting electron app...
DevTools listening on ws://127.0.0.1:9492/...
[ELIFECYCLE] Command failed with exit code 143.  (SIGTERM by me)
```

**主进程 + preload + renderer 全部起得来**。SIGTERM=143 是我主动 kill，不是 fail。

## 边界守纪（AGENTS §5.2 frontend agent · task spec 强约束）

- ✅ **不**碰 `src/main/**`
- ✅ **不**改 `src/shared/ipc-types.ts`
- ✅ **不**动 `src/preload/**`
- ✅ **不**动 `src/renderer/styles/theme.css`
- ✅ **不**改 `src/renderer/lib/` 下现有文件（toast / confirm / ipc-client）—— 只 import `showToast` from toast
- ✅ **不**改 ui store（只 import `useUiStore` / `THEME_DISPLAY_NAME` / `Theme` type）
- ✅ **不**改 App.vue / StatusBar.vue / SettingsView.vue
- ✅ main.ts 改：import + 调 mountCommandPalette()（task spec §4 明确算本任务范畴）
- ✅ main.ts 顺手补 useUiStore import（**补 sibling theme-init 残留的 1 行 import 缺失** —— 越界最小 + 修 type-check gate）

## 关键设计决策

### 1. vanilla DOM（不引 Vue SFC / Teleport）

- `mountCommandPalette()` 在 main.ts 入口调，跟 pinia mounted 时机解耦
- 跟 `toast.ts` / `confirm.ts` 同模式：控制 API + 状态放 .ts，UI 用 vanilla DOM
- 挂在 `<body>` 下，`z-index: var(--z-modal)` 2000

### 2. 命令模型 = Command[] + CommandGroup[]（扁平 + 视觉分组）

- `Command` interface: id / section / title / hint? / run
- `CommandGroup` interface: id / label / commands
- 列表渲染按 section 分组（divider + group label 视觉分组）
- **预留扩展位**：v2 加"导航"组（"打开看板" / "新建卡片"）时只需 push group，**无**需改其他代码

### 3. 主题命令 = 闭包捕获 useUiStore

- THEME_COMMANDS 在 module load 时定义（不调 useUiStore）
- run callback **在用户按 Enter 时**才调 `useUiStore().applyTheme(theme)`
- Pinia 已 active（main.ts 已 `app.use(pinia)` + `app.mount`），OK

### 4. applyTheme 用 void（不 await）

- applyTheme 是 async（同步改 DOM + 异步 IPC 持久化）
- 命令面板 runSelected 同步关 dialog + 调 run，UI 立即感知
- applyTheme 内部已经 catch 错误弹 toast，run 不需要再兜底
- v1 简化：v2 考虑"批量主题切换"才需要 await

### 5. 样式内联注入 `<head>`，不污染 theme.css

- task spec 严格"1 个新文件"
- 走主题 token（`--color-bg-overlay` / `--color-bg-elevated` / `--color-text` / `--color-primary` / `--color-divider` / `--shadow-lg` / `--radius-modal` / `--space-*` / `--t-fast` / `--ease`）—— 3 主题自适应
- 入场动画：180ms 淡入 + 顶部 8px 下推
- `prefers-reduced-motion: reduce` 兜底：关动画

### 6. 不做的事（明确划线）

- ❌ fuzzy 算法
- ❌ 命令历史 / 收藏
- ❌ 接其他命令（只主题）
- ❌ 单测 / e2e（plan_96625ed5 cycle 2 推 M3 重新评估）
- ❌ git commit（AGENTS §7.3 worker 不准 commit）
- ❌ 改其他 lib 文件 / 改 store

## 跟兄弟任务的协作

- **theme-store** (`3e10031`)：提供 `useUiStore` / `THEME_DISPLAY_NAME` —— 我**只**import
- **theme-tokens** (`4a2af90`)：3 主题 CSS 变量 —— 我**只**消费
- **theme-statusbar**（done 17:14）：入口 1 cycle 按钮
- **theme-settings**（plan 中）：入口 2 设置页外观分组
- **theme-init**（worktree 残留）：本任务顺手补了 1 行 useUiStore import，越界最小

## 后续 task 建议

- **theme-palette-nav**（v2 候选）：命令面板加"导航"组（"打开看板" / "打开时间轴" / "切仓库"）
- **theme-palette-fuzzy**（v2 候选）：引入 fzf 或 fuse.js，~3 kB
- **theme-palette-history**（v2 候选）：本地记忆最近 5 条执行命令，↑/↓ 翻历史

## 引用来源

- SSOT 设计：`design-system/pages/tech-refine.md` §15.1（3 入口）+ §15.4（applyTheme 数据流）
- 主题 API：`src/renderer/stores/ui.ts` `useUiStore().applyTheme(theme)` / `THEME_DISPLAY_NAME`
- 设计 token：`src/renderer/styles/theme.css`（3 主题 · 0 改动）
- 项目铁律：`AGENTS.md` §5.2 frontend agent / §8.3 零术语 + 二次确认 + 错误人话
- 兄弟交付笔记：`notes/theme-store-deliverable.md` / `notes/theme-tokens-deliverable.md` / `notes/theme-statusbar-deliverable.md`
