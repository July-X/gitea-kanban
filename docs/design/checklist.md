# 设计走查 Checklist（C-1 准备）

> **目标**：对照 `design-system/gitea-kanban/OVERRIDE.md` 走查每个 view，记录**硬约束违反 / 一致性偏差 / 优化建议**。
>
> **平台约束（user 2026-06-14 拍板）**：
> - PC-only：**Mac + Windows** 桌面应用
> - **不做**移动端 / 平板 / 触控 / 移动 viewport / mobile-first breakpoint
> - 桌面窗口断点：最小 800×600、推荐 1280×800、可拖拽至 4K（实测 `minWidth: 960, minHeight: 600`）
>
> **走查范围**：7 个 view × 12 个检查维度 = 84 个交叉点。

---

## 0. 准备

- [ ] 启动 dev：`pnpm dev`（或直接看生产构建 `out/.../gitea-kanban`）
- [ ] 准备截图工具（`puppeteer` / `playwright` / macOS `screencapture`）
- [ ] 截每个 view 当前状态：默认大小（1280×800）+ 窄窗口（1024×720）+ 最小（960×600）
- [ ] 准备对照表：当前截图 vs OVERRIDE.md 设计规范

---

## 12 个检查维度

### 1. Spacing（间距）
- [ ] 间距单位统一用 `--space-1` / `--space-2` / `--space-3` / `--space-4`（OVERRIDE.md 定义）
- [ ] 卡片内边距一致（≥12px）
- [ ] 列表项之间间距（≥8px）
- [ ] 弹窗内边距（≥16px）
- [ ] 区块之间间距（≥24px）
- [ ] 没有"看起来很挤"或"看起来很散"的 view

### 2. Typography（排版）
- [ ] 标题字体 Inter，正文 Inter，等宽 JetBrains Mono
- [ ] 字号阶梯：h1 (24-28) / h2 (20-22) / h3 (16-18) / body (14) / small (12)
- [ ] 行高合理（1.4-1.6）
- [ ] 英文 / 数字不折行（中英混排对齐）
- [ ] 标题不换行（单行省略号）
- [ ] 没有用错字体（如正文用 monospace）

### 3. Color（颜色）
- [ ] 主色 `gitea 绿 #609926`（light: `#466B16`、dark: `#74B830`）
- [ ] 强调色 `gitea 橙 #f76707`（警示 / 重操作）
- [ ] 背景 light: `#E8F1F5` / dark: `#0F1115`
- [ ] 文字对比度 ≥ 4.5:1（WCAG AA）
- [ ] 状态色一致：成功（绿）/ 警告（橙）/ 错误（红）/ 信息（蓝）
- [ ] 没有"看起来像另一个状态"的颜色混淆

### 4. State（状态）
- [ ] **Hover**：所有可交互元素有 hover 反馈（背景色 / 边框 / 阴影变化，150-300ms）
- [ ] **Focus**：键盘焦点有可见 outline（≥2px，对比度足够）
- [ ] **Active**：鼠标按下 / 卡片被拖动时有视觉反馈
- [ ] **Disabled**：禁用状态明显（透明度 50% + cursor: not-allowed）
- [ ] **Loading**：所有异步操作有 loading 指示（spinner / skeleton / 进度条）
- [ ] **Empty**：空状态有友好提示 + 引导操作

### 5. Motion（动效）
- [ ] 过渡时长 150-300ms（不慢不急）
- [ ] easing 函数一致（`var(--ease)` 或 cubic-bezier(0.4, 0, 0.2, 1)）
- [ ] 主题切换 0 闪烁（v1.1.2 启动期 0 闪烁硬约束）
- [ ] 拖卡片有实时跟随
- [ ] 列表展开 / 折叠有平滑过渡
- [ ] 尊重 `prefers-reduced-motion`（OVERRIDE.md 采纳）

### 6. Responsive（响应式 — **仅 PC 桌面窗口**）
- [ ] 默认 1280×800 完整显示
- [ ] 拖窄到 1024×720 不破坏布局
- [ ] 拖到最小 960×600 仍可用（关键操作不被遮挡）
- [ ] 长内容（commit hash / branch 名）有省略号 + tooltip
- [ ] 侧边栏可折叠
- [ ] **不做**任何移动端 viewport / 触控适配
- [ ] grid 子项都有 `min-width: 0`（防被压缩截断，bot 8c6c084 / a7a6ea0 已修 MergesView，其他 view 呢？）

### 7. Dark Mode（暗色模式）
- [ ] dark / light 主题切换实时生效
- [ ] 切换按钮容易找到（设置页 / 状态栏 / Cmd+Shift+L）
- [ ] 主题切换无白屏闪烁
- [ ] 暗色主题下文字清晰可读
- [ ] 暗色主题下图片 / 图标清晰
- [ ] 没有"暗色看不清"的 view

### 8. Focus（焦点 / 键盘）
- [ ] **键盘快捷键**完整（至少：Cmd+K 命令面板 / Esc 关闭弹窗 / Tab 切换视图 / Cmd+R 刷新）
- [ ] 焦点环明显（≥2px，对比度足够）
- [ ] Tab 顺序合理（从左到右、从上到下）
- [ ] 弹窗打开时焦点 trap
- [ ] Esc 关闭弹窗
- [ ] Enter 触发主操作（按钮）
- [ ] 拖卡片有键盘替代（↑↓ 移动）

### 9. Consistency（一致性）
- [ ] 所有 view 顶部状态栏一致
- [ ] 所有 view 侧边栏一致
- [ ] 所有 view 列表项样式一致
- [ ] 所有弹窗样式一致
- [ ] 所有按钮样式一致（主按钮 / 次按钮 / 危险按钮）
- [ ] 所有 toast 通知样式一致
- [ ] 没有"两个 view 看起来像两个 app"

### 10. Non-tech Jargon（零术语）
- [ ] UI 文本没有原词：`PR` / `merge` / `rebase` / `fork` / `repo` / `branch` / `maintainer`
- [ ] 翻译覆盖："合并请求" / "合并" / "变基" / "复刻仓库" / "仓库" / "分支" / "维护者"
- [ ] 错误提示人话化（"网络断了" → "连不上 gitea，请检查网络或 token 是否过期"）
- [ ] 不出现技术缩写（HTTP 500 / SQL / API / JSON 等）
- [ ] 不出现 `developer` / `engineer` / `committer` 等英文术语

### 11. Empty / Error / Loading（边界状态）
- [ ] 所有列表有空状态（"还没有 X，点这里创建"）
- [ ] 所有异步操作有 loading 态
- [ ] 所有失败操作有错误提示（人话，不只是"出错了"）
- [ ] 没有"白屏卡死"的 view
- [ ] 没有"按钮点了没反应"的情况（要么 loading 要么错误提示）

### 12. Accessibility（无障碍）
- [ ] 按钮 / 输入框有 label
- [ ] 图标按钮有 aria-label
- [ ] 弹窗 role="dialog" aria-modal="true"
- [ ] 焦点管理正确（弹窗关闭后焦点回到触发器）
- [ ] 颜色不是唯一信息载体（图标 + 颜色双重表达）
- [ ] 键盘能完成所有核心操作

---

## 7 个 view 走查表

| View | 截默认 (1280) | 截窄 (1024) | 截最小 (960) | 走查 12 维度 | 痛点 |
|---|---|---|---|---|---|
| **AuthView**（登录） | | | | 1-12 | |
| **BoardView**（看板） | | | | 1-12 | |
| **MyCardsView**（我的卡片） | | | | 1-12 | |
| **TimelineView**（时间轴） | | | | 1-12 | |
| **MergesView**（合并请求） | | | | 1-12 | |
| **MembersView**（成员） | | | | 1-12 | |
| **SettingsView**（设置） | | | | 1-12 | |

---

## 走查记录模板

每个 view 走查后填：

```markdown
### [View Name]
**截图**：
- 默认：`notes/screenshots/c1-{view}-default.png`
- 窄窗口：`notes/screenshots/c1-{view}-narrow.png`
- 最小：`notes/screenshots/c1-{view}-min.png`

**12 维度走查结果**：
1. Spacing: ✅/❌ [具体问题]
2. Typography: ✅/❌ [具体问题]
...

**整体评价**：[1-5 分]（1=丑，5=完美）

**硬约束违反**（必须修）：
- [list]

**一致性偏差**（应该修）：
- [list]

**优化建议**（nice to have）：
- [list]
```

---

## 走查完成后整理

`docs/review/c3-design-audit.md`：
- 按 7 view × 12 维度 整理所有发现
- 按"硬约束 / 一致性 / 优化"分类
- 严重度排序
- 形成 C-4 修第一波 plan

---

## 注意事项

- **不要**只在默认 1280×800 截（窄窗口和最小窗口是 PM 实际会用到的尺寸）
- **不要**只看主流程（异常状态：loading / empty / error 同样重要）
- **不要**忽略键盘操作（PC 用户大量使用键盘）
- **不要**对"小瑕疵"睁一只眼闭一只眼（一致性偏差累积成大毛病）