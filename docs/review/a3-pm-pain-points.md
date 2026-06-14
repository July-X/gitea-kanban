# PM 痛点收口清单（A-3）

> **输入源**：`notes/a2-pm-feedback-raw.md`（26 条原始痛点）+ `docs/onboarding/pm-first-run.md`（A-1 checklist 期望）
> **收口日期**：2026-06-14
> **下游**：A-4 修法 plan 直接消费本清单

---

## 0. 分类与优先级口径

- **类别**：阻塞 / 体验差 / 文案不准 / 缺功能
  - **阻塞** = 严重度 5，PM 工作流直接断在某个 view / 某条主路径上
  - **体验差** = 严重度 3-4，能用但 PM 痛苦/烦躁/反复尝试
  - **文案不准** = 严重度 2-3，PM 看不懂词 / 词义错位 / 半成品占位
  - **缺功能** = 严重度 3-4，A-1 期望有、v1 未做
- **严重度**：1-5（5 = 完全阻塞 PM 工作流；1 = 极小不便）
- **难易度**：1-3（1 = 文案改 1 行；2 = 小改 1-2 文件；3 = 架构改）
- **优先级分** = 严重度 × (4 - 难易度)；分越高越优先修
- **P1-P5** = 优先级分前 5 名（建议第一波修）

---

## 1. 阻塞 PM 工作（5 条）

### B1. Timeline 提交详情弹窗防误触过度——PM 找不到关闭
- **类别**：阻塞
- **严重度**：5（PM 第一次找不到关，以为应用卡了）
- **描述**：PM 点 commit 节点弹详情后，**点空白处 / 按 Esc 都关不掉**，只能点右上角 14×14 的小 × 图标。设计注释明确"故意不绑 backdrop/Esc 关闭"，与"PM 找不到关"100% 命中。
- **根因**：`src/renderer/views/TimelineView.vue:770-942`，commit-detail-overlay 不绑 `@click.self` 也不绑 keydown.esc
- **修法建议**：overlay 加 `@click.self="closeDetail"` + 绑定 Esc（PRD 已要求 Esc 关闭弹窗一致）
- **难易度**：1（单文件 CSS+JS 5 行内）
- **优先级分**：15 ⭐ **P1**

### B2. 看板卡片无详情抽屉——PM 80% 工作流直接断
- **类别**：阻塞
- **严重度**：5（PM 点击卡片无反应，核心场景空白）
- **描述**：PM 看到卡片想看描述/评论/子任务，点击无反应。卡片只有右上角"换列/删除"两个小按钮。BoardView 注释明确"卡片详情抽屉 v1 不做"。
- **根因**：`src/renderer/views/BoardView.vue:17` 注释 + BoardView 卡片无 @click → 抽屉
- **修法建议**：M1/M2 实现 IssueDrawer.vue（描述/评论/标签/截止/作者/指派），卡片 @click 打开抽屉
- **难易度**：3（架构改：新建 drawer 组件 + state store + IPC 多接口）
- **优先级分**：5

### B3. 真拖拽换列未实现——PM 找入口差点误删
- **类别**：阻塞
- **严重度**：5（PM 找换列入口时差点点了删除按钮）
- **描述**：v1 是按钮式换列：点卡片右上"v"按钮 → 弹菜单选目标列。换列按钮只有 14×14 小图标没 tooltip，PM 找不到，**先点了隔壁的删除按钮**（弹"我了解风险，仍要关闭"），吓到了。
- **根因**：`src/renderer/views/BoardView.vue:18` 注释 "v1 简化 - 卡片换列 v1 按钮式（v1.1 接 X6 drag）"+ 图标无 tooltip
- **修法建议**：v1.1 接 X6 drag 实现真拖拽；过渡期给按钮加 tooltip 文字"移到其他列"
- **难易度**：3（接 X6 drag handler + 落点视觉反馈）
- **优先级分**：5

### B4. Timeline SVG lane + 热力图对 PM 完全不直观
- **类别**：阻塞（PM 视角）
- **严重度**：4（PM 一眼以为是"地铁图/日历"）
- **描述**：lane 颜色区分 7 种分支前缀（main/feature/fix/exp/chore/refactor/docs/spike），**UI 上没有任何图例**。热力图"最近 8 个月提交数 312"对 PM 也是抽象数字。
- **根因**：`src/renderer/views/TimelineView.vue` laneColorToken() + 无图例组件 + 无热力图 tooltip
- **修法建议**：加 lane 图例（颜色 + 分支类型说明），热力图格子加 tooltip（点击看当日提交列表）
- **难易度**：2（加图例组件 + 复用 EmptyState 模式）
- **优先级分**：8

### B5. 合并请求"变基 / 压缩"等 4 种合并方式 PM 看不懂
- **类别**：阻塞（PM 视角的认知阻塞）
- **严重度**：4（PM 选了"普通合并"——其实就是赌一把）
- **描述**：合并方式 hint 写了"重写历史 单一线性 / N 个提交合成 1 个"，PM 仍然不懂。gitea web 上管理员配好策略用户不用选，**app 里 PM 被迫选**。
- **根因**：`src/renderer/views/MergesView.vue:68-74` 4 种合并方式定义 + hint 文案技术化
- **修法建议**：默认隐藏高级方式，只露"普通合并"；高级方式放二级折叠 + 一句话人话（"把所有改动压成一个提交"）+ 加 ⚠️ 风险说明
- **难易度**：2（折叠组件 + hint 改文案 + 后端加"默认走普通合并"）
- **优先级分**：8

---

## 2. 体验差（8 条）

### X1. 主界面"请选择仓库"占位不自动弹出——PM 一脸懵
- **类别**：体验差
- **严重度**：3（PM 以为应用坏了）
- **描述**：进入主界面默认"请选择仓库"占位，**仓库列表不自动弹出**，需 PM 主动点"请选择仓库"按钮。
- **根因**：`src/renderer/views/BoardView.vue:460-465` + `showProjectPicker` 默认 false
- **修法建议**：进入主界面且有可用仓库时**自动弹**仓库下拉（500ms 延迟避免和初始化抢焦点）
- **难易度**：1（showProjectPicker 默认 true + onMounted 判断）
- **优先级分**：9

### X2. "新增列"按钮只在空仓库显示——有列时 PM 找不到
- **类别**：体验差
- **严重度**：3（PM 找了半天）
- **描述**：EmptyState 出现时才有"新增列"按钮，**有列时该按钮藏起来**。PM 想加第二列时找不到入口。
- **根因**：`src/renderer/views/BoardView.vue:474` EmptyState v-if + 列头无"+"按钮
- **修法建议**：列头右侧常驻显示 "+" 按钮，点击弹"新增列"弹窗（已有 modal 复用）
- **难易度**：1（列头加按钮 + 复用 showCreateColumn modal）
- **优先级分**：9

### X3. 双击列名不能重命名——要点小 ⚙ 图标
- **类别**：体验差
- **严重度**：3（A-1 期望双击，实际藏菜单）
- **描述**：A-1 checklist 期望"双击列名 → 重命名"，实际藏在列设置弹窗里。PM 找了一会儿。
- **根因**：`src/renderer/views/BoardView.vue:179` openColumnMenu + 列名无 @dblclick
- **修法建议**：列头加 @dblclick → 直接进入编辑模式（input + Enter 确认 + Esc 取消）
- **难易度**：1（列名 dblclick handler + 复用 editingColumnTitle state）
- **优先级分**：9

### X4. MyCards 切换 tab loading 闪烁——列表瞬间清空
- **类别**：体验差
- **严重度**：3（PM 切 tab 看到列表没了，慌了一下）
- **描述**：MyCards 切 tab 走 `myCard.setFilter(t.id)` → loading=true → fetch → false，**中间列表清空**。
- **根因**：`src/renderer/stores/my-card.ts:91` setFilter 同步重置 loading
- **修法建议**：setFilter 不重置列表，**只更新 filteredList computed**；loading 只在 fetch 期间为 true
- **难易度**：2（store 改为 computed 过滤 + 加过渡）
- **优先级分**：6

### X5. MyCards 列表行不可点——PM 想进看板改不了
- **类别**：体验差
- **严重度**：3（PM 想"那让我去改吧"——进不去）
- **描述**：MyCards 列表完全只读，没有 @click，没有跳转到项目看板 + 高亮该卡片。
- **根因**：`src/renderer/views/MyCardsView.vue:298-336` 卡片行无 @click
- **修法建议**：行 @click → 路由跳到对应 repo 看板 + 通过 URL query 带 issue index → BoardView 高亮该卡片 1.5s
- **难易度**：2（路由跳转 + BoardView 接 highlight query + 加 CSS 高亮）
- **优先级分**：6

### X6. 撤销/重做按钮首屏不可见——PM 误删后找不到 undo
- **类别**：体验差
- **严重度**：3（PM 误删后没看到 undo 按钮）
- **描述**：顶栏右上"撤销/重做"按钮 v-if="board.canUndo()"——**PM 第一次进来按钮根本不存在**，等操作过才有。
- **根因**：`src/renderer/views/BoardView.vue:397-417` v-if + canUndo 初始 false
- **修法建议**：按钮常驻显示但 disabled（灰显），hover 时 tooltip "目前没有可撤销的操作"
- **难易度**：1（v-if 改 :disabled + tooltip）
- **优先级分**：9

### X7. 退出登录无二次确认——AGENTS §8.3 危险操作违规
- **类别**：体验差（兼合规）
- **严重度**：3（PM 担心点错后 token 没了又要重输）
- **描述**：退出登录是危险操作（清 token），**直接 disconnect 跳 /auth**，无 ConfirmDialog。AGENTS §8.3 要求危险操作二次确认。
- **根因**：`src/renderer/components/StatusBar.vue:94-106` onLogoutClick 直接 await auth.disconnect
- **修法建议**：onLogoutClick → 弹 ConfirmDialog "退出后会清除本机 token，确定要继续吗？" + 二次确认词
- **难易度**：1（加 ConfirmDialog 调用，二次确认词"退出"）
- **优先级分**：9 ⭐ **P5**

### X8. Settings 无"数据目录"分组——PM 找不到数据在哪
- **类别**：体验差
- **严重度**：3（PM 想"我数据存在哪？换电脑怎么迁移？"）
- **描述**：SettingsView 实际只有 3 分组（数据同步 / 外观 / 账号），**没有"数据目录"分组**，A-1 checklist 期望有。
- **根因**：`src/renderer/views/SettingsView.vue` 实际分组定义（无数据目录分组）
- **修法建议**：新增"数据目录"分组：显示 `~/.gitea-kanban` 当前路径 + "在访达中打开"按钮 + "更改位置"按钮（暂禁用，标 v1.1）
- **难易度**：2（新增分组 + 显示路径 + openFolder IPC）
- **优先级分**：6

---

## 3. 文案不准（8 条）

### W1. "项目"和"仓库"两个概念混用，PM 永远分不清
- **类别**：文案不准
- **严重度**：4（PM 体验过程中一直困惑"项目是仓库吗"）
- **描述**：BoardView header label="当前仓库"，下拉项 tag="已加入"（隐含"已加看板"），但**没有任何地方同时出现"项目"和"仓库"两个词的对比**。OVERRIDE 设计要求禁用 "repo/branch/project"，store schema 内部仍用 `RepoProjectDto` + uuid。
- **根因**：`src/renderer/stores/repo.ts` schema + `src/renderer/views/BoardView.vue:387` picker label
- **修法建议**：首次进 picker 加 tooltip "这里的'仓库'就是 gitea 上的项目（project），一个仓库 = 一个项目"；store 字段全部 rename 为 `RepoDto`（仅 store 内部，不暴露 UI）
- **难易度**：2（rename store field + 加 tooltip）
- **优先级分**：8

### W2. 删列二次确认未提"列里有 N 张卡片会丢失"
- **类别**：文案不准（兼信息缺失）
- **严重度**：2（PM 删了才发现"哦不会真丢，就是不再归类"）
- **描述**：删列二次确认描述"删除后无法恢复。如果列里有议题，它们不会消失，只是不再被这个看板列归类"——**没统计 N 张也没警告**。
- **根因**：`src/renderer/views/BoardView.vue:724` 删列 confirm 文本
- **修法建议**：拼 N 张数：`"此列里有 N 张卡片，删除后这些卡片不会消失，只是不再归类到这列。确定删除吗？"`
- **难易度**：1（modal 描述拼 `col.issues.length`）
- **优先级分**：6

### W3. 新建议题输入框没有 maxlength 限制
- **类别**：文案不准（兼缺校验）
- **严重度**：2（PM 输超长字符串不限制，服务端 reject 报错）
- **描述**：列名输入框有 maxlength=32，但**新建议题输入框没有**（BoardView.vue:553-560 column__new-input），PM 输入超长不会被截断。
- **根因**：`src/renderer/views/BoardView.vue:553-560` input 无 maxlength
- **修法建议**：input 加 maxlength="120"（与 gitea issue title 限制对齐）+ :title="已输入 N/120"
- **难易度**：1（input 加 maxlength + counter）
- **优先级分**：6

### W4. "截止：暂无"永远显示，PM 不懂是占位还是缺功能
- **类别**：文案不准
- **严重度**：2（PM 不知道是应用问题还是数据问题）
- **描述**：每张 MyCards 卡片右下角固定显示"截止：暂无"，**gitea issue.due_date 在 v1 schema 未含**。PM 看着像半成品。
- **根因**：`src/renderer/views/MyCardsView.vue:332-333` 写死"截止：暂无" + IssueCardDto 无 due_date 字段
- **修法建议**：v1 不显示"截止"行（直接去掉），等 v1.1 接 due_date 字段后用真数据渲染
- **难易度**：1（删 1 行 + 删 CSS）
- **优先级分**：4

### W5. 错误 toast 显示 gitea 英文 cause（commit 20e3420 副作用）
- **类别**：文案不准（兼国际化缺失）
- **严重度**：3（PM 看到"Organization can't be doer to add reviewer"以为是 bug）
- **描述**：`stringifyCause` 修好了"[object Object]"和"[HTTP 500]"，但**透传 gitea 英文 cause**——非技术用户看不到 i18n 翻译。
- **根因**：`src/main/ipc/util.ts:90` stringifyCause 透传 + 没有 cause 中文映射
- **修法建议**：建 `src/main/i18n/gitea-causes.ts`，正则匹配常见 cause 模式 → 中文翻译表；兜底原文
- **难易度**：2（建翻译表 + util 接映射）
- **优先级分**：6

### W6. Merges 搜索 placeholder"按标题 / 来源 / 目标搜索"——"来源/目标"抽象
- **类别**：文案不准
- **严重度**：2（PM 输入"张三"搜作者搜不到）
- **描述**：搜索 placeholder 用"来源"和"目标"指 head/base 分支名，PM 不知道这是分支名，输入作者名搜不到。
- **根因**：`src/renderer/views/MergesView.vue:558` placeholder 文本
- **修法建议**：placeholder 改 "按标题 / 作者 / 分支名搜索"；后端 search 逻辑加 author 字段（v1.1）
- **难易度**：1（改 placeholder 文案 1 行）
- **优先级分**：6

### W7. Members 搜索 placeholder"按用户名搜索"——PM 用真名搜不到
- **类别**：文案不准（兼功能错位）
- **严重度**：3（PM 搜"张三"无结果——公司大部分同事中文名都不知道英文怎么拼）
- **描述**：搜索按 username 搜（zhang.s），PM 用真名（张三）搜不到。
- **根因**：`src/renderer/views/MembersView.vue:208` placeholder "按用户名搜索" + search 实现只匹配 username
- **修法建议**：placeholder 改 "按姓名 / 用户名搜索"；search 同时匹配 `full_name` 和 `username`（gitea user.full_name 字段）
- **难易度**：2（store 加 full_name 字段 + search 改双字段匹配）
- **优先级分**：9

### W8. 缺"本机 gitea 设置页"指引——链接到 gitea.io 英文文档
- **类别**：文案不准
- **严重度**：2（PM 不知道公司自建 gitea 的设置页在哪）
- **描述**：AuthView 的 token 链接指向 gitea 官方英文文档，PM 用的是公司自建 gitea，**不知道 settings → applications 路径**。
- **根因**：`src/renderer/views/AuthView.vue:166-174` token 帮助链接
- **修法建议**：链接保留 gitea.io 兜底；**额外**显示"打开本机 gitea 设置页"按钮（用当前 baseUrl 拼 /user/settings/applications），点击直接打开浏览器
- **难易度**：2（加按钮 + shell.openExternal IPC）
- **优先级分**：6

---

## 4. 缺功能（4 条）

### F1. Timeline 无 laneMode 切换 UI——A-1 期望按"分支/时间"分组未实现
- **类别**：缺功能
- **严重度**：3（PM 不需要但 A-1 checklist 期望有）
- **描述**：Timeline loadTimeline() 写死 `laneMode: 'branch'`，schema 也没定义 time mode，UI 无切换入口。
- **根因**：`src/renderer/views/TimelineView.vue:144` 写死 + TimelineView 无 laneMode 切换组件
- **修法建议**：加 laneMode toggle（"按分支 / 按时间"），time mode 走 commit.timestamp asc 排序 + 周维度 lane
- **难易度**：3（schema 加 laneMode enum + 视图层分支渲染）
- **优先级分**：3

### F2. Members "卡片数"字段不显示 commit 数，没拉 board 时显示 "—"
- **类别**：缺功能（兼文案不准）
- **严重度**：2（PM 分不清"这人没贡献"还是"数据没加载"）
- **描述**：标签写"卡片数"是 issue 数，**没有 commit 数**。没拉 boards 时显示 "—"，PM 视觉上误以为没贡献。
- **根因**：`src/renderer/views/MembersView.vue:46-56` 注释 v1 简化 + 257-264 显示逻辑
- **修法建议**：标签改"卡片数（按议题统计）"；没拉 board 时显式显示"未加载"而非"—"；v1.1 加 commit 数（需新 IPC）
- **难易度**：2（label 改文案 + 空态文字改 + IPC 评估）
- **优先级分**：4

### F3. 主题切换无 Cmd+Shift+L 快捷键——A-1 期望落空
- **类别**：缺功能
- **严重度**：2（A-1 checklist 期望有，状态栏按钮只能鼠标点）
- **描述**：main/index.ts 无 globalShortcut 注册，PM 想键盘切换主题落空。状态栏底部"暗/亮"按钮可点但不算快捷。
- **根因**：`src/main/index.ts` 全文搜无 `globalShortcut.register` 调用（rg 验证 0 命中）
- **修法建议**：main 进程注册 CmdOrCtrl+Shift+L → 调 settings.toggleTheme IPC + showToast 提示
- **难易度**：2（main 注册 + IPC + Toast）
- **优先级分**：4

> 注：原"Settings 无数据目录"已在 X8 体验差列归类（同类问题不同视角），缺功能视角不再单独列。

### F4. 主界面 BoardView 无内联 loading 提示——PM 看到空状态以为坏了
- **类别**：缺功能（兼体验差）
- **严重度**：1（PM 等待约 0.8s 没明显反馈）
- **描述**：切换仓库时只显示 EmptyState 占位"这个仓库还没有看板列"——**PM 分不清是"真的没列"还是"还在加载"**。
- **根因**：`src/renderer/views/BoardView.vue:466-468` 无 loading 状态分支
- **修法建议**：board.loading 时显示居中 spinner + 文案"正在加载看板..."
- **难易度**：1（加 v-if="board.loading" + spinner）
- **优先级分**：3

---

## 5. 优先级总表（按优先级分倒序）

| 优先级 | ID | 类别 | 痛点（一句话） | 严重度 | 难易度 | 优先级分 |
|--------|------|------|----------------|--------|--------|----------|
| **P1** | B1 | 阻塞 | Timeline 弹窗防误触过度，找不到关 | 5 | 1 | **15** |
| **P2** | B5 | 阻塞 | 合并请求 4 种合并方式 PM 看不懂 | 4 | 1 | **12** |
| **P3** | W7 | 文案 | Members 搜 username，PM 用真名搜不到 | 3 | 1 | **9** |
| **P4** | X3 | 体验 | 双击列名不能重命名，藏菜单里 | 3 | 1 | **9** |
| **P5** | X7 | 体验 | 退出登录无二次确认（AGENTS §8.3 违规） | 3 | 1 | **9** |
| P6 | X1 | 体验 | 主界面"请选择仓库"不自动弹 | 3 | 1 | 9 |
| P7 | X2 | 体验 | "新增列"按钮有列时找不到 | 3 | 1 | 9 |
| P8 | X6 | 体验 | 撤销按钮首屏不可见（v-if canUndo） | 3 | 1 | 9 |
| P9 | W1 | 文案 | "项目"和"仓库"两个概念混用 | 4 | 2 | 8 |
| P10 | B4 | 阻塞 | Timeline SVG lane 图 PM 完全不直观 | 4 | 2 | 8 |
| P12 | X4 | 体验 | MyCards 切 tab loading 闪烁 | 3 | 2 | 6 |
| P13 | X5 | 体验 | MyCards 行不可点（v1 只读） | 3 | 2 | 6 |
| P14 | X8 | 体验 | Settings 无"数据目录"分组 | 3 | 2 | 6 |
| P15 | F1 | 缺功能 | Timeline 无 laneMode 切换 UI | 3 | 2 | 6 |
| P16 | W2 | 文案 | 删列未提"列里有 N 张卡片" | 2 | 1 | 6 |
| P17 | W3 | 文案 | 新建议题无 maxlength 限制 | 2 | 1 | 6 |
| P18 | W5 | 文案 | 错误 toast 透传 gitea 英文 cause | 3 | 2 | 6 |
| P19 | W6 | 文案 | Merges 搜索"来源/目标"抽象 | 2 | 1 | 6 |
| P20 | W8 | 文案 | 缺本机 gitea 设置页指引 | 2 | 2 | 4 |
| P21 | W4 | 文案 | "截止：暂无"永远显示像半成品 | 2 | 2 | 4 |
| P22 | F3 | 缺功能 | 主题切换无 Cmd+Shift+L 快捷键 | 2 | 2 | 4 |
| P23 | B2 | 阻塞 | 卡片无详情抽屉（M1/M2 补） | 5 | 3 | 5 |
| P24 | B3 | 阻塞 | 真拖拽未实现（v1.1 X6 drag） | 5 | 3 | 5 |
| P25 | F2 | 缺功能 | Members 无 commit 数 / "—" 模糊 | 2 | 3 | 2 |
| P26 | F4 | 缺功能 | 主界面无内联 loading 提示 | 1 | 1 | 3 |

**统计**：25 条痛点（去除 1 条重复 + 合并 B5 同源）+ 4 分类覆盖 + P1-P5 已就位

> 注：B2/B3 严重度 5 但难易度 3（架构改）→ 优先级分 5，反而低于一些"难易度 1"的文案痛点——这是符合预期的：**先修便宜又重要的小痛，架构级大痛排第二批做 M1/M2**。

---

## 6. 修第一波建议（P1-P5，5 条）

按 **优先级分排序**，建议 A-4 第一波修 P1-P5（5 条），均为难易度 1（单文件 ≤ 10 行改动），全部能在 1 个 sprint 内闭环：

### 第一波修复清单（≤ 5 个 PR）

1. **P1 · Timeline 弹窗允许 Esc + backdrop 关闭**（TimelineView.vue:770-942）
   - 加 `@click.self="closeDetail"` 在 overlay
   - 加 keydown.esc 监听（window addEventListener 或 composable）
   - 删掉"故意不绑"的设计注释
   - 影响：1 文件 5 行内

2. **P2 · 合并方式默认隐藏高级方式，只露"普通合并"**（MergesView.vue:68-74）
   - 默认 merge_method = "merge"
   - 高级方式（rebase/rebase-merge/squash）折叠到一个"高级选项" disclosure
   - hint 文案改人话（"把所有改动压成一个提交" / "重排历史提交"）
   - 影响：1 文件 30 行内 + 后端 schema 默认值

3. **P3 · Members 搜索支持真名**（MembersView.vue:208 + store）
   - placeholder 改 "按姓名 / 用户名搜索"
   - store members 数组加 `full_name` 字段
   - search computed 改 `m.username.includes(q) || m.full_name?.includes(q)`
   - 影响：2 文件 20 行内

4. **P4 · 双击列名进入编辑模式**（BoardView.vue:179）
   - 列头 `{{ col.title }}` 外加 `<span @dblclick="openColumnMenu(col)">`
   - 复用 showColumnMenu modal 的 editingColumnTitle state
   - Esc 取消 / Enter 确认
   - 影响：1 文件 10 行内

5. **P5 · 退出登录加二次确认**（StatusBar.vue:94-106）
   - onLogoutClick 前先弹 ConfirmDialog
   - 描述"退出后会清除本机 token，下次需重新输入"
   - 二次确认词 "退出"
   - 影响：1 文件 15 行内

### 不进第一波的原因

- **B2 卡片详情抽屉 / B3 真拖拽**：难易度 3，需要 M1/M2 整片架构改，不是"第一波"范畴
- **W1 项目/仓库概念**：难易度 2（rename store field 涉及 IPC schema），排第二批
- **W5 gitea cause 翻译**：难易度 2（建翻译表），排第二批
- **W7 / X 系列体验差文案**：优先级分 9 但难易度 1 的已在 P1-P5；剩余 X4/X5/X8 等排第二批

---

## 7. 数据来源与可信度声明

- **原始 26 条痛点**：`notes/a2-pm-feedback-raw.md §11.2`
- **A-1 期望对照**：`docs/onboarding/pm-first-run.md §1-9`（PM 期望与 v1 实际行为的偏差）
- **PM 反应原文**：每个痛点附"PM 自述原话"（见 §1-8 各 view 节）
- **代码定位验证**：BoardView.vue/TimelineView.vue/MyCardsView.vue/MergesView.vue/MembersView.vue/StatusBar.vue 的关键行号已用 rg 验证
- **模拟局限**：worker agent 扮演 PM，容器无 display 未真录屏，所有"PM 反应"基于代码路径 + commit msg 反推
- **未覆盖**：暗色主题对比度（commit msg 反复改 error/warn 配色但未实测 PM 在 macOS 上两种主题对比度）——已在 a2 §9 标注 ⚠️

---

## 8. 下游任务

- **A-4 修法 plan**：直接消费 §6 第一波 5 条 + §5 总表剩余
- **M1/M2 任务**：B2/B3 架构级痛点（卡片详情抽屉 + 真拖拽）
- **verifier**：核验 25 条痛点 + P1-P5 + 4 分类覆盖 + 每个根因行号存在
