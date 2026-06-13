# BranchView 二修 — 复制 IPC 路径修复 + files-list 显眼滚动条（2026-06-13）

> 用户反馈 2 条（mid-turn steer 触发）：
> 1. 复制功能提示失败
> 2. 文件列表依然没有出滚动条，无法看到后面的文件
>
> worker: reasonix root session（AGENTS §7.2 自决：实现细节 / 不动 IPC schema 字段）

## 1. 根因

### 1.1 复制失败的根因（commit 588da2b 引入的 bug）

`src/renderer/lib/ipc-client.ts` 的 `clipboardWrite` 函数调用：
```ts
return getIpcClient().invoke('preferences', 'clipboard.write', { text });
```

走 `invoke(namespace, method, args)` 路径解析成 `this.api['preferences']['clipboard.write']`，但 preload 暴露的 window.api 结构是：
```
window.api.preferences.clipboard.write   ← 三段式
```

`api.preferences['clipboard.write']` 是 **undefined**（不是函数）→ 抛 IpcError `IPC端点不存在：preferences.clipboard.write` → `copyText` catch 返 false → BranchesView `onCopyCommitHash` 走 `else` 分支 → toast "复制失败，请手动选择"。

CDP 验证修复前 vs 修复后：
```
INVOKE-LIKE path: { fnType: "undefined" }     ← 修复前（错误路径）
THREE-LEVEL path: { ok: true, r: {ok: true} } ← 直接调走法（正确路径）
```

**本质**：commit 588da2b 引入 `clipboardWrite` 时误用了 `invoke`（两段式），但 `preferences.clipboard.write` 是三段式 path（preload line 166-176 已经按三段式正确暴露）—— 应该用 `invokeNested('preferences', 'clipboard', 'write', ...)`。

### 1.2 文件列表滚动的根因（前次修复方向错误）

前次（commit 0789da7）按用户选项"高度自适应"**去掉**了 `.branch-commit-row__files-list` 的 `max-height: 50cqh + overflow-y: auto`：
```css
/* 错误修复 */
.branch-commit-row__files-list {
  /* 去掉了 max-height + overflow-y */
}
```

**但**父容器 `.branch-commit-row`（line 1511）有 `overflow: hidden`，祖父 `.branches__commits-list`（line 1499）有 `overflow-y: auto`。所以**当 li 内容超过 commits-list 可见区域时，整 li 被 commits-list 截断**——而 macOS dark mode 默认滚动条透明，用户看不到 li 被截的位置，误以为是 detail 内部丢失。

**正确修法**：**恢复 max-height + 显眼 webkit 滚动条**（不要靠"自适应"逃避滚动）。

## 2. 改动总览

```
src/renderer/lib/ipc-client.ts      | 7 +++-
src/renderer/views/BranchesView.vue | 71 +++++++++++++++++++++++++++++++------
2 files changed, 67 insertions(+), 11 deletions(-)
```

## 3. 改动 #1：clipboardWrite 走 invokeNested

```diff
 export function clipboardWrite(text: string): Promise<unknown> {
- return getIpcClient().invoke('preferences', 'clipboard.write', { text });
+ // 调用 window.api.preferences.clipboard.write({text}) —— 三段式 path，
+ // 必须用 invokeNested('preferences', 'clipboard', 'write', ...)；
+ // 之前误用 invoke('preferences', 'clipboard.write', ...) 会把 'clipboard.write'
+ // 当成 method 名查 ns['clipboard.write'] → undefined → 抛 IpcError → catch 兜底
+ // "复制失败，请手动选择" toast（这是 commit 588da2b 引入时的 bug）
+ return getIpcClient().invokeNested('preferences', 'clipboard', 'write', { text });
 }
```

## 4. 改动 #2：files-list 恢复 max-height + 显眼滚动条

```css
.branch-commit-row__files-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  /* 恢复 max-height（commit 0789da7 错误去掉） */
  max-height: 50vh;
  max-height: 50cqh;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  scrollbar-color: var(--color-text-muted) transparent;
}
/* 显眼 webkit 滚动条（macOS Chrome / Electron 默认透明看不见） */
.branch-commit-row__files-list::-webkit-scrollbar {
  width: 8px;
}
.branch-commit-row__files-list::-webkit-scrollbar-track {
  background: transparent;
}
.branch-commit-row__files-list::-webkit-scrollbar-thumb {
  background: var(--color-text-muted);
  border-radius: 4px;
  opacity: 0.4;
}
.branch-commit-row__files-list::-webkit-scrollbar-thumb:hover {
  background: var(--color-primary);
  opacity: 0.8;
}
```

## 5. 改动 #3：commits-list 也加显眼滚动条

```css
.branches__commits-list {
  /* ... existing ... */
  scrollbar-width: thin;
  scrollbar-color: var(--color-text-muted) transparent;
}
.branches__commits-list::-webkit-scrollbar {
  width: 10px;
}
/* ... thumb / track 同款 */
```

## 6. 验证（CDP attach ws://localhost:9492/devtools/page/<targetId>）

### 6.1 复制 IPC 路径修复

**CDP 测试**（attach target id `90FEDAF2653FA4D6DD6FCAE3B262C5BA`）：

```json
FIXED clipboard write: {"stage":"call","ok":true,"result":{"ok":true}}
```

**main log**（`/tmp/gitea-kanban-logs/main-2026-06-13.log`）：
```json
{"channel":"preferences.clipboard.write","latencyMs":1,"msg":"ipc ok"}
```

**vs 修复前**（CDP 测错路径）：
```json
INVOKE-LIKE path: {"stage":"lookup","ok":false,"fnType":"undefined"}
```

### 6.2 files-list 滚动条 CSS 已生效

读 stylesheet：
```json
[{
  "sel": ".branch-commit-row__files-list[data-v-96862b86]",
  "css": "...max-height: 50cqh; overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--color-text-muted) transparent;..."
}, {
  "sel": ".branch-commit-row__files-list[data-v-96862b86]::-webkit-scrollbar",
  "css": "...width: 8px;"
}, {
  "sel": ".branch-commit-row__files-list[data-v-96862b86]::-webkit-scrollbar-thumb",
  "css": "...background: var(--color-text-muted); border-radius: 4px; opacity: 0.4;"
}]
```

✅ 全部生效：max-height 50cqh、overflow-y auto、webkit 滚动条 width 8px + thumb 圆角 + token 颜色。

### 6.3 4 件套

| 命令 | 结果 |
|---|---|
| `pnpm type-check` | ✅ EXIT=0 |
| `pnpm build` | ✅ EXIT=0 |
| `pnpm check:no-jargon` | ✅ EXIT=0（10 个 .vue SFC 0 误报） |

## 7. 改动文件清单（commit scope）

```
src/renderer/lib/ipc-client.ts      | 7 +++-   # clipboardWrite 改 invokeNested
src/renderer/views/BranchesView.vue | 71 ++++++  # files-list 恢复滚动 + 显眼 webkit 滚动条 + commits-list 滚动条
```

**未碰**：
- ❌ IPC schema（IPC channel 字段不变）
- ❌ preload / main process
- ❌ 设计 token / 设计系统

## 8. 后续 polish 项（不在本任务 scope）

- **head 复制入口冗余**：head 现在有 3 个触发"复制 sha" 的入口（hash 按钮 + icon Clipboard + ~~detail 底部那个已删~~）。如果觉得冗余可删 icon Clipboard。
- **测试限制**：本轮验证依赖 CDP attach 真实 Electron renderer（chrome-devtools-mcp 走 ws://localhost:9492/devtools/page/<id>）；page state 在 HMR 后丢失（dev mode sqlite 干净导致 auth guard 拦着），所以**没法用 CDP 完整走"选 main → 展开 commit → 点 icon → 看 toast"流程**——IPC 路径修复靠**直接调 window.api.preferences.clipboard.write 验证**，CSS 靠**stylesheet 读 cssRules 验证**。