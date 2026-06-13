# theme-store 任务交付（frontend worker · 2026-06-12）

> **⚠️ 本文件描述的 v1.1.2 store（`Theme = 'A-dark' | 'C-dark' | 'light'`，默认 `A-dark`，cycle 3 步）已被 v1.2 推翻（2026-06-13）。**
> 当前 `Theme = 'dark' | 'light'`，`DEFAULT_THEME = 'dark'`，`THEME_CYCLE_ORDER = ['dark', 'light']`，`THEME_DISPLAY_NAME = { dark: '暗色 · 中性近黑', light: '浅色 · 浅苍蓝' }`。整套数据流（`applyTheme` / `initTheme` / `persistTheme` / `fetchPersistedTheme`）保留不变。详见 `design-system/gitea-kanban/OVERRIDE.md` v1.2 段落。本文件留作 history。

## 落地内容

实现 v1.1.2 主题切换的 **核心 Pinia store**：`src/renderer/stores/ui.ts`（225 行）。

> ⚠️ task prompt 写「新建」，但项目 cycle 1.5 freeze prep 已存在 138 行 stub（untracked），
> 实际是**写**（删 stub + 落 impl + 写注释 + 加 helper）。

## Store API

### State
| 名称 | 类型 | 初始值 | 说明 |
|---|---|---|---|
| `currentTheme` | `Ref<'A-dark' \| 'C-dark' \| 'light'>` | `'A-dark'` | 默认 = `DEFAULT_THEME`（tech-refine §15.3 拍板） |

### Actions

#### `applyTheme(theme: Theme): Promise<void>`
数据流（tech-refine §15.4）：

```
1. currentTheme.value = theme + document.documentElement.dataset.theme = theme
   ↓ (CSS 150ms 过渡由 theme.css * 选择器接管，theme-tokens task 落地)
2. localStorage.setItem('gitea-kanban.theme', theme)  同步
3. persistTheme(theme).catch(() => showToast('主题保存失败，请重试'))  异步不阻塞
```

**关键决策**：IPC set 失败 **不回滚** currentTheme（task 拍板）。
- localStorage + DOM 已改，回滚会让用户觉得"按了按钮没反应"
- 远端 sqlite 写失败，下次启动 initTheme 用 localStorage 值兜底（用户视角无感知）

#### `initTheme(): Promise<void>`
数据流（tech-refine §15.5 启动期）：

```
1. localStorage.getItem('gitea-kanban.theme')  同步 0ms
   ↓ 立即设 currentTheme + dataset.theme  → 避免白屏
2. fetchPersistedTheme()  异步 50-200ms
   ↓ 不一致则 await applyTheme(persisted)
```

**容错**：
- localStorage 无值 / 非法 → 用 `DEFAULT_THEME`
- IPC get 失败 / sqlite 无值 → 静默保留 localStorage 值
- IPC get 拿到值与 localStorage 一致 → noop（不重写 IPC）

### 私有 helper（store 内私有，外部不导出）

```ts
async function fetchPersistedTheme(): Promise<Theme | null>
async function persistTheme(theme: Theme): Promise<void>
```

窄封装 `getIpcClient().invokeNested('preferences', 'theme', 'get'|'set', args)`，
type cast result 为 `ThemeGetResult`。

### Cycle 1.5 保留 exports（不破坏 cycle 1.5 其它 caller）

| 名称 | 类型 | 用途 |
|---|---|---|
| `Theme` | `type` | enum type alias |
| `DEFAULT_THEME` | `Theme` | `'A-dark'` |
| `THEME_CYCLE_ORDER` | `readonly Theme[]` | `['A-dark', 'C-dark', 'light']` |
| `THEME_STORAGE_KEY` | `string` | `'gitea-kanban.theme'` |
| `THEME_DISPLAY_NAME` | `Record<Theme, string>` | 显示名映射（i18n 占位） |
| `nextThemeInCycle(t)` | `(Theme) => Theme` | StatusBar cycle 用 |
| `isValidTheme(s)` | `(unknown) => s is Theme` | 类型守卫，runtime 校验脏数据 |

### Cycle 1.5 删除的 exports

| 名称 | 删除原因 |
|---|---|
| `ApplyThemeOpts` interface | task 简化 applyTheme 签名（不需要 opts） |
| `ApplyTheme` type alias | impl 已落地，不需要 type-only stub |
| `HydrateTheme` type alias | 改名 `initTheme`，type alias 不再需要 |

**安全性**：rg 验证 0 个外部文件 import 这些 type alias，删除无 ripple。

## 边界守纪（AGENTS §5.2）

- ✅ **不**碰 src/main/**
- ✅ **不**改 src/shared/ipc-types.ts
- ✅ **不**动 src/preload/**
- ✅ **不**动 src/renderer/styles/theme.css
- ✅ **不**动 src/renderer/lib/ipc-client.ts（**不**新增 preferencesThemeGet/Set helper，避免越权边界）
- ✅ **不**改 App.vue / main.ts（调 `useUiStore().initTheme()` 是 theme-init task 的活）
- ✅ **不**改 StatusBar.vue / SettingsView.vue / command-palette.ts（调 applyTheme 是 theme-statusbar / theme-settings / theme-command task 的活）

## 验证输出

### 1. `pnpm type-check` 关键段
```
src/renderer/lib/ipc-client.ts(76,7): error TS2739: ... missing: theme_not_found, invalid_theme, database_unavailable, database_write_failed
src/renderer/lib/ipc-client.ts(92,7): error TS2739: ... missing: theme_not_found, invalid_theme, database_unavailable, database_write_failed
```

**与本任务无关**：2 个 error 都在 `src/renderer/lib/ipc-client.ts`，是 sibling theme-ipc task 加 4 个新 IpcErrorCode 后**未同步更新** renderer 端 map 的下游副作用。

**隔离验证**：git stash sibling backend 5 文件（src/main/ipc/index.ts + schema.ts + src/preload/index.ts + src/shared/errors.ts + src/shared/ipc-channels.ts）后 `pnpm type-check` 0 error，确认 0 个由本任务引入。

**修复建议**（不属于本任务，留 final-integration 收口）：
```ts
// src/renderer/lib/ipc-client.ts 同步加：
CODE_CATEGORY 加：
'theme_not_found': '主题未设置',
'invalid_theme': '主题无效',
'database_unavailable': '数据库不可用',
'database_write_failed': '数据库写入失败',
RECOVERABLE 加：true / false / true / true
```

### 2. `pnpm check:no-jargon`
```
[check:no-jargon] OK — 未发现禁用术语
```

### 3. 关键符号 grep
```
$ rg -n 'useUiStore|currentTheme|applyTheme|initTheme' src/renderer/stores/ui.ts
... 21 matches across state / actions / comments ...
```
4 关键词全部命中 ✓

### 4. `pnpm build`
```
✓ 2785 modules transformed.
✓ built in 6.28s
```

### 5. `pnpm dev`（15s）
```
✓ main 160 kB / preload 7.75 kB / renderer http://localhost:5174/
```

## 后续 task 依赖关系

| 后续 task | 依赖本 store 的 API | 状态 |
|---|---|---|
| theme-statusbar | `useUiStore().applyTheme(nextThemeInCycle(currentTheme))` | 待办 |
| theme-settings | `useUiStore().applyTheme(newTheme)` | 待办 |
| theme-command | `useUiStore().applyTheme(newTheme)` | 待办 |
| theme-init | `useUiStore().initTheme()` 在 App.vue mount | 待办 |

## 未做的事（按 task spec 边界）

- ❌ 不集成进 App.vue / main.ts（theme-init 任务）
- ❌ 不集成进 StatusBar / SettingsView / command-palette（theme-statusbar/settings/command 任务）
- ❌ 不改 ipc-client.ts 加 helper（避免"碰 IPC"边界）
- ❌ 不动 theme.css（theme-tokens 已落）
- ❌ 不动 settings store（polling interval 与主题无关）
- ❌ 不 git commit（AGENTS §7.3 worker 不自决）