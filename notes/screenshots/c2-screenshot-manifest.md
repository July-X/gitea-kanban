# C-2 截图清单（manifest）

> **范围**：7 view × 3 尺寸 = **21 张**预期截图。
> **生成工具**：`scripts/cdp-capture-views.mjs`（CDP / puppeteer-core · 已有 Electron 调试端口支持）。
> **跑测环境要求**：本机启动 dev（`pnpm dev`）+ 至少一个已连 gitea 账号（否则空状态截图）。
> **当前进度**：❌ **未生成** —— 容器无 display，本 manifest 是给 PM / 设计师后续在本机跑的清单。
> **路径规范**：`notes/screenshots/c2-{view}-{size}.png`（size ∈ default / narrow / min）。
>
> **跑测命令**（PM 在本机执行）：
> ```bash
> # 1) 启动 dev 服务（带 CDP 端口）
> pnpm dev --remote-debugging-port=9222
> # 2) 在另一终端跑截图（脚本约定参数）
> node scripts/cdp-capture-views.mjs --output=notes/screenshots/ --manifest=notes/screenshots/c2-screenshot-manifest.md
> ```

---

## 尺寸约定（来自 checklist.md + OVERRIDE）

| 尺寸代号 | 窗口尺寸 | 用途 | 主区宽度（减 navrail 224 - statusbar 28） |
|---------|---------|------|------------------------------------------|
| `default` | **1280 × 800** | 推荐窗口 | 1280 - 224 - 28 = 1028px |
| `narrow` | **1024 × 720** | 中等窗口 | 1024 - 224 - 28 = 772px |
| `min` | **960 × 600** | 最小窗口 | 960 - 224 - 28 = **708px** ⚠️ TimelineView 880px min-width 会溢出 |

---

## 截图清单（7 view × 3 尺寸）

### 1. AuthView（登录页）

| # | 路径 | 尺寸 | 预期内容 | 备注 |
|---|------|------|---------|------|
| 1 | `notes/screenshots/c2-auth-default.png` | 1280×800 | 居中卡片：ShieldCheck logo + "连接 gitea" 标题 + URL/Token 表单 + 提交按钮 | 截图前**必须清掉已保存账号**（让用户回到登录态），否则 AuthView 不会渲染 |
| 2 | `notes/screenshots/c2-auth-narrow.png` | 1024×720 | 同上（居中卡片宽度 440px 不变） | 验证居中布局在小窗口仍正常 |
| 3 | `notes/screenshots/c2-auth-min.png` | 960×600 | 同上 | 验证 600 高度下卡片完整可见（卡片 ~ 400px） |

**截图条件**：
- 未连接 gitea（已登出）
- 触发错误一次再回到默认（可选：截图 `.auth__error` 红色 error 条样式 → 截第 4 张）

### 2. BoardView（看板）

| # | 路径 | 尺寸 | 预期内容 | 备注 |
|---|------|------|---------|------|
| 4 | `notes/screenshots/c2-board-default.png` | 1280×800 | 仓库选择器 + 撤销/重做 + 3 列（待办/进行中/已完成）+ 每列 ≥2 张议题卡片 + 卡片标签 + 卡片左侧主色边 | 验证横向滚动行为（1280px 主区可显示 3 列 280px + 2 gap 12px = 864px 留余） |
| 5 | `notes/screenshots/c2-board-narrow.png` | 1024×720 | 同上，可能触发 `.board__columns overflow-x:auto` | 验证列横向滚动条出现位置 |
| 6 | `notes/screenshots/c2-board-min.png` | 960×600 | 高度 600px，列内 `.column__cards overflow-y:auto` 出现滚动条 | 验证状态栏 28px 不遮挡底部 "新建议题" 输入框 |

**截图条件**：
- 已选 1 个含 ≥3 列 / ≥6 议题 的仓库（用 `seed-kanban-demo.ts` 灌数据）
- 至少 1 张卡片有 ≥2 个 label（含亮色 label 测试 `color-contrast()` 效果）
- 至少 1 张 closed 议题（验证 `.card--closed` opacity 0.6 + 左边线灰色）

### 3. MyCardsView（我的卡片）

| # | 路径 | 尺寸 | 预期内容 | 备注 |
|---|------|------|---------|------|
| 7 | `notes/screenshots/c2-mycards-default.png` | 1280×800 | 仓库选择器 + 当前用户头像 + tabs（全部/进行中/已关闭）+ 搜索 + 卡片列表 | 验证 tab counter 颜色 / hover 效果 |
| 8 | `notes/screenshots/c2-mycards-narrow.png` | 1024×720 | 同上 | 验证 search input max-width:360px 在窄窗口不被压 |
| 9 | `notes/screenshots/c2-mycards-min.png` | 960×600 | 同上，可能挤压顶部 user info | 验证 `.my-cards__topbar` flex 排版 |

**截图条件**：
- 当前用户在该仓库有 ≥5 张卡片（含 open / closed 混合）
- 切换到"进行中" tab 再截图 1 次（可选 → 截第 10 张单独验证 tab 视觉）

### 4. TimelineView（时间轴）⚠️ **关键问题 view**

| # | 路径 | 尺寸 | 预期内容 | 备注 |
|---|------|------|---------|------|
| 10 | `notes/screenshots/c2-timeline-default.png` | 1280×800 | 顶部分支 chips + heatmap（35 周）+ commit graph（≥20 commits + bridges）+ 侧栏分支列表 | 1280px 主区足够放 880px min-width commit-list |
| 11 | `notes/screenshots/c2-timeline-narrow.png` | 1024×720 | 同上，**开始出现横向滚动**（commit-list min-width 880px > 772px 主区） | **这是 hard constraint 违反的视觉证据** |
| 12 | `notes/screenshots/c2-timeline-min.png` | 960×600 | 同上，**严重横向滚动**（708px 主区远小于 880px min-width） | **必须保留截图作为 C-4 fix 的 blocker 证据** |

**截图条件**：
- 仓库有 ≥3 个分支（main + 1 feature + 1 hotfix，触发 lane 颜色对比）
- ≥30 commits（保证 commit-row 滚动 + heatmap 非空）
- 至少 1 个 isMerge 节点（验证 bridge 颜色处理）
- 至少 1 个 exp 分支（验证 amber bridge 虚线穿越）

**额外**：
- 打开 commit-detail 弹窗截图 1 张：`notes/screenshots/c2-timeline-commit-detail.png`（任意尺寸都行，弹窗 max-width:540px 不依赖主区宽度）

### 5. MergesView（合并请求）

| # | 路径 | 尺寸 | 预期内容 | 备注 |
|---|------|------|---------|------|
| 13 | `notes/screenshots/c2-merges-default.png` | 1280×800 | 顶栏（合并请求标题 + repo 名 + 合并方式下拉 + 刷新）+ tabs + 搜索 + 列表（≥5 条不同状态的合并请求） | 验证 `merge-item--open/merged/closed` 3 种左边线颜色 |
| 14 | `notes/screenshots/c2-merges-narrow.png` | 1024×720 | 同上 | 验证 title / 分支流向不挤压 |
| 15 | `notes/screenshots/c2-merges-min.png` | 960×600 | 同上，**可能触发 `@media (max-width: 600px)` 媒体查询**（这是 mobile breakpoint — 违反 OVERRIDE） | **保留作为 hard constraint 违反证据** |

**截图条件**：
- 仓库有 ≥5 个合并请求（含 open / merged / closed 3 种状态）
- 至少 1 个有 `hasConflicts: true`（验证合并按钮 disabled + 冲突 hint chip）
- 至少 1 个 `draft: true`（验证 draft badge + warning 颜色边框）
- 至少 1 个目标是 main/master（验证主线分支额外警告弹窗文案）

**额外**：
- 合并确认弹窗：`notes/screenshots/c2-merges-confirm-dialog.png`（弹窗宽度 480px）
- 属性编辑弹窗：`notes/screenshots/c2-merges-attr-editor.png`（弹窗内含 label checkbox 网格）

### 6. MembersView（成员）

| # | 路径 | 尺寸 | 预期内容 | 备注 |
|---|------|------|---------|------|
| 16 | `notes/screenshots/c2-members-default.png` | 1280×800 | 顶栏 + tabs + 搜索 + 成员卡片 grid（≥6 个成员） | 验证 auto-fill grid 在 1280px 主区下显示 3 列（280px × 3 + gap） |
| 17 | `notes/screenshots/c2-members-narrow.png` | 1024×720 | 同上 | 验证 1024px 主区显示 2-3 列 |
| 18 | `notes/screenshots/c2-members-min.png` | 960×600 | 同上，可能降为 2 列 | 验证 600px 高度下卡片不被切 |

**截图条件**：
- 仓库有 ≥6 个成员（含 admin / write / read 3 种权限覆盖）
- 至少 1 个成员有 `avatarUrl`（验证 img 渲染），至少 1 个没有（验证 fallback 字母头像）
- 至少 2 个成员在看板中有卡片（验证 `.member-card__count` 显示数字而非 `—`）

### 7. SettingsView（设置）

| # | 路径 | 尺寸 | 预期内容 | 备注 |
|---|------|------|---------|------|
| 19 | `notes/screenshots/c2-settings-default.png` | 1280×800 | 设置标题 + 数据同步 section + 外观 section（2 主题 radio）+ 账号 section | 验证 radio `--active` 态 border-color + bg-soft |
| 20 | `notes/screenshots/c2-settings-narrow.png` | 1024×720 | 同上 | 验证 sections 居中 max-width:640px |
| 21 | `notes/screenshots/c2-settings-min.png` | 960×600 | 同上 | 验证 settings padding var(--space-6)=32px + section 居中后两侧留白 |

**截图条件**：
- 已连接 gitea（账号 section 才有内容）
- 默认 dark 主题（appearance radio 显示"暗色"选中）
- 打开"更新连接" modal 截图 1 张（可选：`notes/screenshots/c2-settings-account-modal.png`）

---

## 跑测脚本约束（PM/设计师在本机跑时确认）

1. **环境前置**：
   - `pnpm install` 完成
   - gitea demo 已起（`bash scripts/e2e.sh` 或 `pnpm dev:seed`）
   - 已通过 AuthView 至少连接 1 个账号

2. **窗口启动**：
   ```bash
   pnpm dev --remote-debugging-port=9222 --window-size=1280,800
   ```
   或分别测 3 尺寸：每个尺寸启动一次 dev 跑截图。

3. **截图脚本（占位）**：
   - 当前 `scripts/cdp-capture-views.mjs` 是 PM 跑的入口
   - 需要支持 `--size=default|narrow|min` 参数
   - 需要支持 `--route=/board|/timeline|/merges|/members|/my-cards|/settings|/auth`
   - 当前**没有 size 参数**，需要 PM 改脚本或写 wrapper

4. **截图保存**：
   - PNG 格式
   - fullPage: false（仅 viewport）
   - deviceScaleFactor: 1（避免 retina 像素）

5. **截图完成后**：
   - 把 21 张 PNG 路径填入 `docs/review/c2-design-walkthrough-raw.md` 顶部截图清单
   - 在 board.md 报告 "截图就位"

---

## 已知无法截图项（透明声明）

- **AuthView 错误态**：触发错误（如输错 token）需要 dev 主动操作，CDP 脚本需要 `await page.click('#gitea-token')` + `await page.fill(...)` + `await page.click('.auth__submit')` + `await page.waitForSelector('.auth__error')`，已记为可选截图
- **TimelineView 弹窗**：commit-detail 弹窗需要在 CDP 中 `await page.click('.commit-row')` 触发
- **SettingsView 更新连接 modal**：需要 `await page.click('.settings-group__account .settings__save')` 触发
- **BoardView 换列菜单**：需要 hover `.card` + click `.card__action` 触发

这些"需要交互才能触发的状态"在本 manifest 中标注为"可选截图"，**C-4 fix 阶段需要覆盖**（PM 跑截图时建议补齐）。

---

**清单结束**。本 manifest 给本机 designer / PM 后续在 `pnpm dev` + 真实窗口下产出真实截图，对照 `docs/review/c2-design-walkthrough-raw.md` 的 84 交叉点逐一核对。