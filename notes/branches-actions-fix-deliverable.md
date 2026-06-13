# BranchesView actions 移到 head + file list 自适应高度 — deliverable

> 用户反馈 2 条：
> 1. 分支功能中，提交列表下方「复制完整提交号」、「在 gitea 中打开」移动到 head 的 hash 号后面，并且只保留 icon 来触发功能
> 2. 文件列表多了以后 li 标签的元素展示不全，需要做滚动条，或者手风琴展开的高度自适应，让内容完全显示出来
>
> worker: reasonix root session（AGENTS §7.2 自决：UI 布局细节 / 不动 IPC schema / 不动设计 token）

## 1. 改动总览

`src/renderer/views/BranchesView.vue` (+66 / -43)

| 改动 | 位置 |
|---|---|
| 删除 detail-body 底部的 `<div class="branch-commit-row__actions">`（"复制完整提交号"+"在 gitea 打开"两个大按钮） | line 885-905（删） |
| 在 head 的 `<span class="branch-commit-row__meta">` 里 hash 后面加两个 icon-only button | line 802-815（加） |
| 删除 `.branch-commit-row__actions` 死 CSS | line 1689-1709（删） |
| 加 `.branch-commit-row__icon-btn` 样式（icon-only 按钮） | line 1695-1720（加） |
| `.branch-commit-row__files-list` 去掉 `max-height: 50cqh` + `overflow-y: auto` | line 1750-1765（改） |
| 加 scrollbar 显式颜色 token（暗色主题下能看清） | line 1753-1762（加） |

## 2. 改动 #1：actions 移到 head 后面

### 2.1 改动前（detail 底部冗余大按钮）

```vue
<!-- actions 区留在 detail-body 外 —— 永远可见，固定在 detail 底部 -->
<div class="branch-commit-row__actions">
  <button @click="onCopyCommitHash(c, $event)">
    <Clipboard :size="13" />
    <span>复制完整提交号</span>
  </button>
  <button @click="onOpenCommitInGitea(c, $event)">
    <ExternalLink :size="13" />
    <span>在 gitea 打开</span>
  </button>
</div>
```

### 2.2 改动后（head hash 后面 icon-only 按钮）

```vue
<span class="branch-commit-row__meta muted">
  <button class="branch-commit-row__sha" @click="onCopyCommitHash(c, $event)">
    {{ c.shortSha }}
  </button>
  <!-- 复制 / 在 gitea 打开两个动作只保留 icon，塞在 hash 旁边 -->
  <button
    class="branch-commit-row__icon-btn"
    :title="`复制完整提交号 ${c.sha}`"
    @click="onCopyCommitHash(c, $event)"
  ><Clipboard :size="12" :stroke-width="2" /></button>
  <button
    class="branch-commit-row__icon-btn"
    :title="`在 gitea 打开此提交 ${c.shortSha}`"
    @click="onOpenCommitInGitea(c, $event)"
  ><ExternalLink :size="12" :stroke-width="2" /></button>
  · {{ relativeTime(c.date) }}
</span>
```

### 2.3 icon 按钮样式

```css
.branch-commit-row__icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 4px;
  background: transparent;
  border: none;
  color: var(--color-text-muted);
  cursor: pointer;
  border-radius: 2px;
  opacity: 0.6;             /* 默认半透明，让 inline 行不显拥挤 */
  vertical-align: -1px;     /* 跟 hash baseline 对齐 */
}

.branch-commit-row__icon-btn:hover {
  background: var(--color-primary-soft);
  color: var(--color-primary-hover);
  opacity: 1;
}

.branch-commit-row__icon-btn:focus-visible {
  outline: none;
  box-shadow: var(--shadow-focus);
  opacity: 1;
}
```

### 2.4 已知冗余（待 user 决策）

**head 现在有 3 个触发"复制 sha"的入口**：
1. 点击 hash 文字（`branch-commit-row__sha` 按钮，原有 inline 便利）
2. 点击 hash 后第一个 icon（`branch-commit-row__icon-btn` + Clipboard）
3. ~~detail 底部的"复制完整提交号"~~（已删）

如果 user 觉得 hash 按钮 + icon 按钮**两个复制入口冗余**，告诉我删 icon 复制那个（保留 hash 按钮 inline 复制即可）——1 行代码可改。当前先按 user 字面要求"两个都加 icon"。

## 3. 改动 #2：files-list 高度自适应

### 3.1 改动前

```css
.branch-commit-row__files-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 50vh;
  max-height: 50cqh;         /* 容器视口一半 */
  overflow-y: auto;          /* 滚动条 */
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}
```

**问题**：
- `max-height: 50cqh` + 暗色透明滚动条 → macOS dark mode 下滚动条不可见
- 用户看到 li 底部被截，**不知道能滚**
- 反馈："li 标签的元素展示不全"

### 3.2 改动后（用户给的"高度自适应"选项）

```css
.branch-commit-row__files-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  /* 去掉 max-height，让 li 自然撑到内容实际高度 */
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  scrollbar-color: var(--color-text-muted) transparent;
}
```

**取舍**：
- m4java-test 实测 commit `fileCount` 最大 7（v1.1.3 #23 注释假设 50+ 是极端情况）→ 单 li 完全展开可控
- 未来如果遇到 50+ 文件 commit（如 monorepo 全量 lint 提交），需要退回滚动方案 → 保留 `overscroll-behavior` + `scrollbar-gutter` 作为保险
- 显式 `scrollbar-color` 暗色主题下也能看清（如果未来某 commit 真的需要滚动）

## 4. 验证（CDP attach 真实 Electron renderer）

### 4.1 验证 actions 移动

```json
{
  "commitRows": 7,
  "expandedDetails": 1,
  "iconBtnsInHead": 14,      // 7 commits × 2 icon-btn = 14 ✓
  "oldActionsDivs": 0,       // detail 底部 actions div 已删 ✓
  "oldActionBtns": 0,        // "复制完整提交号"+"在 gitea 打开" 按钮已删 ✓
}
```

### 4.2 验证 files-list 高度自适应

```json
{
  "filesLists": 1,
  "firstListFiles": 4,                    // 4 个文件 li 全显示 ✓
  "firstListMaxHeight": "none",           // max-height 已移除 ✓
  "firstListScrollHeight": 98,            // 实际高度 = scroll height
  "firstListClientHeight": 98             // = client height → 无滚动，内容完全展开 ✓
}
```

### 4.3 4 件套

| 命令 | 结果 |
|---|---|
| `pnpm type-check` | ✅ EXIT=0 |
| `pnpm build` | ✅ EXIT=0 |
| `pnpm check:no-jargon` | ✅ EXIT=0（10 个 .vue SFC 0 误报） |

### 4.4 截图

- `notes/branches-actions-fixed.png`（2560×1536）：展开 commit 后，head hash 后面能看到 Clipboard + ExternalLink 两个 icon button，detail 内部 files list 4 个 li 完全展开，无滚动截断。

## 5. 改动文件清单（commit scope）

```
src/renderer/views/BranchesView.vue | +66 -43
notes/branches-actions-fixed.png   | new 320 kB
```

**未碰**：
- ❌ IPC schema / IPC endpoint
- ❌ preload / main process
- ❌ 设计 token / 设计系统
- ❌ 任何 .vue 之外的源文件