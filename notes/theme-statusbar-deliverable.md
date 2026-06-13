# StatusBar 主题切换按钮 — theme-statusbar task

> **⚠️ 本文件描述的 v1.1.2 3 主题 cycle（A 暗 → C 暗 → Light）已被 v1.2 推翻（2026-06-13）。**
> 当前 `THEME_CYCLE_ORDER = ['dark', 'light']`（A 暗 + C 暗合并为 dark，按 C 暗中性近黑基底），`THEME_SHORT_LABEL = { dark: '暗', light: '亮' }`。详见 `design-system/gitea-kanban/OVERRIDE.md` v1.2 段落。本文件留作 history。

**时间**：2026-06-12 17:18（Asia/Shanghai）
**scope**：1 个文件改 → `src/renderer/components/StatusBar.vue`（+29 / -4 行）
**任务**：v1.1.2 cycle 2 · tech-refine §15.1 入口 1

---

## 按钮位置

`.statusbar__left` **末尾**（刷新按钮之后）—— 左侧布局：

```
[chip:已连接] [url] [repo:xxx] [↻ 刷新] [🎨 A 暗]
```

**不**放 `.statusbar__right`（那里是用户上下文 + 退出登录）。

---

## cycle 顺序

```
A 暗 → C 暗 → 浅色 → A 暗
```

定义在 `src/renderer/stores/ui.ts:48-52`（`THEME_CYCLE_ORDER`）—— **single source of truth**。
StatusBar.vue **不**存 cycle 顺序，直接 `import { nextThemeInCycle } from '@renderer/stores/ui'`，避免散落硬编码。

---

## 视觉

- **图标**：lucide-vue-next `Palette`（通用"主题"概念图标，不绑定某个具体主题）
- **文字**：本地 `THEME_SHORT_LABEL` map 简称 "A 暗" / "C 暗" / "浅色"（避免 28px 高状态栏撑爆布局）
- **title**（hover 才显示）：完整主题描述
  - 例：`当前：A 暗 · 苍蓝提饱和（点切换）`
- **样式**：直接复用现有 `.statusbar__action`（带 hover bg / focus ring / transition）—— `<style scoped>` 块**零改动**

---

## 验证输出（4 命令全绿）

| 命令 | 结果 |
|---|---|
| `pnpm type-check` | EXIT=0 ✓ |
| `pnpm check:no-jargon` | EXIT=0 ✓（手审 .vue 模板无禁用术语） |
| `rg 'useUiStore\|applyTheme' StatusBar.vue` | **4 命中**（要求 ≥2）|
| `pnpm build` | EXIT=0 ✓（9.45s 稳定）|

### isolation baseline

第 1 次 type-check 撞 1 个 transient `main.ts(25,1) TS6133`，怀疑我引入 → stash 验证：

| 状态 | type-check 结果 |
|---|---|
| baseline（sibling 改动 + 我撤回） | EXIT=0 ✓ |
| 完整（sibling 改动 + 我加回） | EXIT=0 ✓ |
| 复跑稳定（两边都干净） | EXIT=0 ✓ |

**结论：transient sibling race condition**，与本任务无关。

---

## 边界（AGENTS §5.2 frontend agent）

- ✅ 只改 `src/renderer/components/StatusBar.vue`（1 文件）
- ✅ 不碰 `src/main/**`
- ✅ 不改 `src/shared/ipc-types.ts`
- ✅ 不动 `src/preload/**`
- ✅ 不动 `src/renderer/styles/theme.css`
- ✅ 不动 ui store（theme-store task 已完成）
- ✅ 调 IPC 通过 `useUiStore().applyTheme()`（不直接调 ipc-client）

---

## 未做

- ❌ SettingsView 主题入口（theme-settings task 单独 scope）
- ❌ 命令面板 ⌘K 主题入口（theme-cmd task 单独 scope）
- ❌ e2e 测试（M3 收口统一补）
- ❌ git commit（AGENTS §7.3 worker 不准 commit）