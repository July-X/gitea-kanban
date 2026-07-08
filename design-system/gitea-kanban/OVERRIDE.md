# Gitea Kanban — Design System Override

> 本文件**覆盖** `MASTER.md` 的全局规则。本项目有明确的产品定位，MASTER 的默认
> 推荐（Vibrant & Block-based / #22C55E 鲜绿 / Fira Code+Sans / startup 风格）不能直接套用。
>
> **v1.1 更新（2026-06-12）**：本项目暗色主题强化为「技术工具的科技感」方向。具体 token
> 落地到 `design-system/pages/tech-refine.md`（page-level 精修文件，HUD / Sci-Fi FUI 风格）。
> 本文件 §"科技感精修（v1.1）" 章节登记 v1.1 决策摘要 + 链到精修文件。
>
> **v1.2 更新（2026-06-13）**：3 主题收敛为 2 主题。`v1.1.2 推翻 v1 → 3 主题切换` 拍板被
> user 推翻：A 暗（苍蓝）与 C 暗（中性近黑）视觉差异仅在冷暖，非技术用户分不清；3 主题
> 产生认知负担。**v1.2 落地为 dark / light 2 主题**（dark = C 暗基底 #0F1115；light 保留
> #E8F1F5），主色 token 提亮到 #74B830（dark）/ 压暗到 #466B16（light）过 WCAG AA 4.5:1。
> 完整决策摘要见 §"科技感精修（v1.1）" 章节 v1.2 段落，token 矩阵在 `tech-refine.md` §14。
>
> **v1.6 更新（2026-06-22 · 重大方向转换）**：从「技术工具科技感 / HUD 装饰」方向
> 改为 **Minimalism + Functional Density**（Linear / Notion / Vercel Dashboard 风）。
> 详细决策：v1.1 装饰套（装饰角 / 标题前缀条 / 键帽 / KPI 发光 / 角落点阵）全部移除；
> 阴影从「深底+冷白 inset+主色外环」三件套改为 4 档单层柔和（--shadow-xs/-sm/-md/-lg）；
> 边角中等柔化（卡片 8 / 按钮 6 / 标签 4）；KPI 字号 36 → 28（取消强发光超大数字）。
> **v1.1 章节保留为历史记录**，仅作参考，**不**作为当前设计语言；新工作以 §"Minimalism
> 设计原则（v1.6）" 为准。`tech-refine.md` 标注"已废弃 · 切到 v1.6"。

## 适用范围

- 项目：`gitea-kanban`
- 形态：Electron 桌面应用（不是 SaaS Web 也不是 startup landing）
- 用户：gitea 用户群，含**开发者** + **非技术人员**（PM / 设计师 / 市场 / 运营）
- 风格定位：**Minimalism + Functional Density**（v1.6 · 2026-06-22）—— Linear / Notion / Vercel Dashboard 风，
  贴 gitea 风格（让用户感到这是 gitea 的延伸而不是第三方小工具），
  **稳健 / 信息密度合适 / 非技术用户友好**。**v1.1「技术工具科技感 / HUD 装饰」方向已废弃**，见 §"科技感精修（v1.1）" 章节作为历史参考。

## 覆盖决策（采纳 / 拒绝）

| 维度 | MASTER 推荐 | 本项目决定 | 理由 |
|------|------------|----------|------|
| 主色 | `#22C55E` 鲜绿 | **gitea 绿 `#609926`** | 贴 gitea 生态，可识别度强 |
| 强调色 | （无） | **gitea 橙 `#f76707`** | 贴 gitea 生态，用于警示/重操作 |
| 背景 | `#0F172A` 深色 | **v1.2 推翻 v1.1.2 → 2 主题切换**——dark `#0F1115`（默认，原 C 暗中性近黑基底）/ light `#E8F1F5`（浅色保留）。主色 token 调档：dark `#74B830`（vs #0F1115 4.74:1）/ light `#466B16`（vs #E8F1F5 5.55:1）过 WCAG AA 4.5:1。**v1.1.2 推翻为 history**：3 主题（A 暗 / C 暗 / Light）A 暗与 C 暗视觉差异仅在冷暖，非技术用户分不清、产生认知负担。**v1.1.2 推翻 v1** 同样保留为 history：v1 单主题暗色 `#134857` 苍蓝四层（v1.1.2 理由：① 灰蒙反馈 → A 暗提饱和到 71% 推色相到 201°；② 非技术用户友好不靠浅色过度收口）。完整 token 矩阵见 `tech-refine.md` §14。**3 入口**（v1.1.2 加 · v1.2 沿用）：StatusBar cycle 按钮 / 设置页"外观" radio / 命令面板 ⌘K "主题"命令。 |
| 风格 | Vibrant & Block-based（块状/大色块/活泼） | **Minimalism + Functional Density**（v1.6 · Linear / Notion 风） | 非技术用户要"看得懂"，大色块/活泼风容易显得不专业 |
| Pattern | Feature-Rich Showcase（Hero > Features > CTA） | **不适用**（这不是 landing） | 我们是工具型应用，没有 marketing 页面 |
| 标题字体 | Fira Code | **Inter**（Google Fonts 载入） | 桌面应用要中英文混排，Fira Code 中文不行 |
| 正文字体 | Fira Sans | **Inter**（中文 fallback：Noto Sans SC） | 同上 |
| 等宽字体 | Fira Code | **JetBrains Mono** | commit hash / branch / `#CARD-482` / tooltip SHA 必须用正经 mono，dev 工具标配；`cv11/ss01` 启用 → 数字"0"带斜线、"1"有底杠，可读性↑ |
| 图标 | SVG（Heroicons/Lucide） | **✅ 采纳** | 跟 MASTER 一致，专业规则 |
| `cursor-pointer` | 必须 | **✅ 采纳** | 跟 MASTER 一致 |
| Hover 反馈 | 150-300ms 平滑 | **✅ 采纳** | 跟 MASTER 一致 |
| 暗色模式对比度 | 4.5:1 最低 | **✅ 采纳** | 跟 MASTER 一致 |
| Focus 状态 | 可见 | **✅ 采纳且加强** | 非技术用户要清楚看到当前焦点 |
| `prefers-reduced-motion` | 尊重 | **✅ 采纳** | 跟 MASTER 一致 |
| 响应式断点 | 375/768/1024/1440 | **桌面应用窗口断点**：最小 800×600、推荐 1280×800、可拖拽至 4K | 桌面窗口不是 mobile-first |
| 无 emoji 图标 | 必须 | **⚠️ v1.4 推翻** —— 全局加载动画海豚 `GlobalLoadingOverlay.vue` 用 emoji `🐬`（user 拍板 2026-06-16）。**只**在"装饰性吉祥物"场景豁免，业务图标 / 操作图标 / 状态图标**仍**必须 SVG。跨平台渲染差异（Apple/Google 彩色 · Windows Segoe UI Emoji · Linux Noto Color Emoji）接受，font-family 不强制 → 走系统默认。`pnpm check:no-jargon` 不拦截 emoji 字符（仅拦截禁用术语原词）。 | **仅**"装饰吉祥物"豁免；功能图标不引 emoji |

## 本项目专属规则（在 MASTER 之上**新增**）

1. **零术语**：所有 UI 文本必须经过术语翻译表
   - "PR" → "合并请求"
   - "merge" → "合并"
   - "branch" → "分支"
   - "commit" → "提交"（避免"提交记录"这种半语半英）
   - "fork" → "派生"
   - "issue" → "议题" 或保留 "Issue"（gitea 自己也保留）
   - "repo" → "仓库"
   - "maintainer" → "维护者"
   - "reviewer" → "审阅者"
   - "rebase" → "变基"（hover 解释"重新整理提交顺序"）
   - "squash" → "压缩"（hover 解释"把多个提交合成一个"）
   - "cherry-pick" → "精选"（hover 解释"挑一个提交到另一个分支"）
   - "revert" → "撤销"（hover 解释"生成一个新的反向提交"）
   - "stash" → "暂存"（hover 解释"把未提交的改动收起来"）
   - "force push" → "强制推送"（hover 解释"会覆盖远端历史"）+ 二级红色警告
   - "protected branch" → "受保护分支"（hover 解释"默认禁止直接推送，需走合并请求"）
   - "main" / "refs/heads/main" → "主线分支"
   - "WIP" → "进行中"（gitea 习惯）

2. **危险操作二次确认**（与 02-architecture.md 第 7 节一致）
   - 删分支 / 强推 / 合并冲突解决 / 关闭合并请求 → 必须弹窗二次确认
   - 确认弹窗必须用"人话"说明后果，不用术语
   - 撤销期内允许回退

3. **错误提示"人话"**
   - 错误码 → 类别前缀（"网络问题" / "权限不足" / "服务器开小差"）+ 具体原因 + 建议下一步
   - 不暴露内部 stack trace 给最终用户

4. **desktop 窗口专属**
   - 应用图标 = gitea 主题（#609926 圆角方块）
   - 顶栏原生（macOS traffic light / Windows title bar）
   - 菜单栏（Menu Bar）走 Electron 原生 + 平台惯例（macOS = 应用名 / Win = File/Edit/...）
   - 窗口可缩放、最小尺寸 800×600、**v1.1.2 推翻 v1 → 3 主题切换**（A 暗 / C 暗 / Light，用户主动选；**不**跟随 OS 系统设置——避免用户切桌面主题时 app 也跟着切，引起认知负担）

5. **暗色模式阴影原则（v1.6 推翻 v1.1）**
   - v1.1 三件套（深底色阴影 + 1px 冷白微描边 + 主色外环 glow）**已废弃** —— glow 在内容密集的工具类应用里是噪音
   - **v1.6 单层柔和 4 档**（暗色底走中性黑阴影，亮色走冷黑阴影，无 inset 无 glow）：
     - `--shadow-xs`：1px 浅阴影（控件内嵌 / 按钮按下）
     - `--shadow-sm`：1-3px 浅双层（卡片 / 列 / chip，**最常用**）
     - `--shadow-md`：4-8px 双层（浮层 / 抽屉）
     - `--shadow-lg`：12-24px 双层（模态对话框 / 强浮层）
   - 2 主题都走 `--shadow-rgb`（dark `0,0,0` / light `15,26,36`），alpha 4-10%（克制不抢戏）
   - 主按钮**不**带阴影（视觉权重靠 background color + 实色描边，不靠 glow）

6. **滚动条**（v1.6 简化 · 跟 Minimalism 对齐）
   - 全部用 `scrollbar-color` + `::-webkit-scrollbar` 主题化
   - 8px 细滚动条 + 4px 圆角，track 透明
   - thumb 默认态：主色 22-25% alpha 软底
   - thumb hover 态：主色 50-55% alpha（**去掉 v1.2 的 dark glow / light 1px 描边**，v1.6 走纯色变化）
   - thumb active 态：主色实色（`--scrollbar-thumb-active` token）
   - 避免 WebKit 默认白底撞色；Firefox 兼容走 `scrollbar-width: thin`

7. **Minimalism 设计原则（v1.6 新增 · 当前生效）**
   - **无装饰元素**：装饰角 / 标题前缀条 / 键帽 / 角落点阵 全部移除（v1.1 装饰套废弃）
   - **阴影单层柔和**：4 档（xs/sm/md/lg），无 inset 无 glow
   - **边角中等柔化**：卡片 8 / 按钮 6 / 标签 4（不走 v1.1 锐化 6/4/2，也不走 MASTER 12/8/4）
   - **区域靠 1px 边界线分区**：NavRail 右 / 状态栏上 / view topbar 下都走 `--color-divider-region` / `--color-divider` token
   - **KPI 数字 ≤28px**：取消 v1.1 36-48px 强发光超大数字（业务 UI 走"专业克制"路线）
   - **主按钮走 background color + 实色描边，不靠 glow**（v1.1 主色外环 glow 移除）
   - 状态点 halo 走实色描边或 4-6px 软扩散（**不**用 v1.1 12px primary-glow）
   - 视觉锚：主色 token 用于"激活 / 选中 / 强调"；非激活态全走中性色（不滥用主色）

8. **lane / 列卡片化原则**（v1.1 沿用 · v1.6 调整投影）
   - 时间轴的每条 lane / 看板的每列 / 合并管理的每张 PR 卡，**都是独立 elevated 卡片**
   - 卡片特征：bg = `--color-bg-elevated`（比 canvas 提一档）+ 8px 圆角（`--radius-card`）+ 1px 描边 / `--shadow-sm` 柔和阴影
   - 卡片之间 **14-16px gap**（gap 区域显出 canvas 色作为"分隔"）
   - v1.1 三件套投影（base + inset + glow）**已废弃** —— 卡片只用 `--shadow-sm` 1 层柔和阴影
   - 这条覆盖"全局去描边"原则——卡片边界例外允许 1px 描边

9. **a11y 加强**（非技术用户友好）
   - 全部交互元素键盘可达（Tab 顺序符合阅读顺序）
   - 关键操作（合并、删除）除了二次确认还要声音/震动反馈
   - 颜色不是唯一信号（用图标 + 文字 + 颜色三重编码状态）

## 科技感精修（v1.1，2026-06-12）· ⚠️ 已废弃 · 2026-06-22 切到 v1.6 Minimalism

> ⚠️ **本节是历史快照，仅作参考**。v1.1「技术工具科技感 / HUD 装饰」方向在 v1.6（2026-06-22）
> 被 user 拍板推翻，改为 Minimalism + Functional Density。v1.1 装饰套（装饰角 / 标题前缀条 /
> 键帽 / KPI 发光 / 角落点阵）**全部移除**。新设计语言以 §"Minimalism 设计原则（v1.6）" 为准。
> `tech-refine.md` 已标注"已废弃"。
>
> 本节是 v1.1 主题精修的**决策摘要 + 索引**。完整 token 落地在
> **`design-system/pages/tech-refine.md`**（page-level 精修文件，~280 行），
> 可视化 demo 在 **`docs/design/wireframe/theme-tech.html`**。

### v1.1 决策摘要

| 维度 | v1 OVERRIDE | v1.1 精修 | 理由 |
|---|---|---|---|
| 卡片边角 | 12px | **6px** | dev 工具主流（Linear / Notion / Cursor），与 gitea 桌面端调性一致 |
| 按钮边角 | 8px | **4px** | 配合卡片锐化；按钮是"操作件"不是"装饰件" |
| 标签 / chip | 12px | **2px** | HUD 极小锐角，区分"标签"和"按钮" |
| 阴影 | 4-12px 单层 | **三件套**：`深底色阴影 + 1px 冷白内描边 + 主色外环 glow` | 暗色底纯黑阴影"消失"，v1 #5 已奠基，v1.1 量化分级 |
| 状态色 | 仅绿 / 橙 | **新增 4 色**：红 `#db2828` / 青 `#4fc4d6` / 等待灰 `#94a3b8` / 离线灰 `#64748b` | 三重编码（颜色 + 图标 + 文字）需要更细的语义；红 / 青跟 gitea 生态一致 |
| 主按钮 glow | （无） | **`0 0 0 1px 主色 50% + 0 0 12px 主色 30%`** | 静态 / hover / 错误三档分级，hover 升级到 24px |
| HUD 装饰 | （无） | **装饰角**（卡片左上 / 右上 L 形）+ **标题前缀条**（4×16 主色窄条）+ **键帽**（24×20 mono） | 来自 ui-ux-pro-max skill style.domain "HUD / Sci-Fi FUI" 方向 |
| mono 字体场景 | 等宽字体 | **强制 9 类**（commit hash / issue id / 版本号 / 时间戳 / 状态码 / 路径 / 命令 / 卡片 ID / SHA 短码）**+ 推荐 6 类**（KPI 大数字 / 百分比 / 行号 / commit 标题 / 状态大字 / 数字标签） | v1 已定 JetBrains Mono，v1.1 显式列场景避免装饰化 / 漏用 |
| 顶部 StatusBar | （无） | **24px 高，路径 + 快捷键 + 同步状态 + 版本号** | 桌面应用窗口本来就少空间，状态条把"现在在哪 / 在干啥"压顶 |
| 背景装饰 | （无） | **主画布 8% alpha 24px grid**（不进卡片 / 列 / 弹窗）+ 窗口顶角 4×4 装饰点阵 | HUD 风装饰，**不进阅读区**；可关 |
| scanline / glitch | （无） | **v1 不采用** | a11y 差 + 干扰阅读 + LED 屏"噼啪" |
| KPI 大数字 | （无） | **JetBrains Mono 36-48px 主色 + text-shadow 0 0 8px 主色 40%** | "科技感"最浓的展示位，强发光的唯一例外 |
| 进度条 | （无） | **主色 8% 底 + 1px 20% 描边 + 渐变填充 + 微弱 glow + 12px 数字百分比** | 合并管理 / 看板列头 / 设置页通用 |
| 过渡时长 | 200ms | **150-240ms 分级**（颜色 150 / 卡片抬升 200 / 弹窗 180 / 抽屉 240 / KPI 数字滚动 400） | 颜色快、动效慢，更"工程" |
| 状态点呼吸 | （无） | **1500ms 循环 ease-in-out** | 仅等待 / 同步状态点，**接受** `prefers-reduced-motion: reduce` 关闭 |
| Layout-shift hover | 禁用 scale | **禁用**（保持） | OVERRIDE 已有；v1.1 补充：允许 `translateY(-1px)` |

### 不破坏的硬约束（重申 · v1.1.2 更新）

- ✅ 主色仍是 gitea 绿 `#609926`（2 主题通用品牌色锚，不换矩阵绿 `#00FF41`）—— 亮色 CTA 文字用 `#466B16` 加深版（v1.2 收紧，v1.1.2 的 `#4F7A1A` 不到 4.5:1 已替换）
- ✅ 强调色仍是 gitea 橙 `#f76707`（品牌锚）—— 主色 token 走 `#FF8534`（dark 提亮）/ `#D85804`（light 压暗）过 AA
- ✅ 4 层底色决策保留为 dark 主题（`#0F1115` / `#1E222A` / `#2D333F` / `#3C4453`）+ light 4 层（`#E8F1F5` / `#FFFFFF` / `#F1F6F9` / `#DDE7EC`）
- ⚠️ **v1.1.2 → v1.2 推翻**：3 主题收敛为 2 主题（dark 默认 / light），用户主动选；不跟随 OS 系统设置
- ✅ 零术语 / 二次确认 / 错误人话（v1 OVERRIDE §本项目专属规则 #1-3）
- ✅ 不引 Cyberpunk 强霓虹（a11y 差 + 跟非技术用户友好冲突）
- ✅ 不引 CRT scanline / glitch 错位动画
- ✅ 不引 Tailwind utility class（本项目走 CSS Modules + 全局 CSS 变量）

### 拍板（待 user 确认，详见 `tech-refine.md` §13）

1. 边角锐化（卡片 6 / 按钮 4 / 标签 2）是否接受？
2. HUD 装饰（装饰角 + 标题前缀条 + 键帽）装饰程度合不合适？
3. 状态色新增（红 / 青 / 灰 x2）是否引入？
4. 背景 grid（8% alpha 24px）做不做？or 只做顶角点阵？
5. 顶部 StatusBar（24px 高）v1.1 必做还是 v1.2？
6. KPI 大数字 + 强发光放首页 / 合并管理 / 两者？
7. scanline 关闭（v1 接受不开）？
8. 数字滚动 / 状态点呼吸 v1.1 做还是 v1.2？

### 拍板后的落地路径

- ✅ 通过 → 写 `docs/design/wireframe/theme-tech.html` 验证（已包含）→ Phase 1 改 `src/renderer/styles/theme.css` + `hud-decor.css`
- ⏸ 暂缓 → `tech-refine.md` 留作 reference，落地推迟到 v1.2
- ❌ 拒绝 → 回 v1 现状（卡片 12px / 按钮 8px / 标签 12px），OVERRIDE 本节标注"已撤回"

### v1.6 推翻对账（2026-06-22 · 当前生效）

> 本表对照 v1.1 决策，标记每个 v1.1 项在 v1.6 里的最终处理（保留 / 废弃 / 调整）。

| v1.1 决策 | v1.6 处理 | 原因 |
|---|---|---|
| 卡片 6 / 按钮 4 / 标签 2（锐化） | **调整为 8 / 6 / 4**（中等柔化） | v1.6 走 Linear / Notion 6-8px 主流，不跟 MASTER 12px 也不跟 v1.1 锐化 2-4px |
| 阴影三件套（base + inset + glow） | **改为 4 档单层柔和**（xs/sm/md/lg） | glow 在内容密集工具里是噪音；单层柔和更克制 |
| 主按钮 glow（1px 主色 + 12-16px 主色光） | **去掉 glow**，主按钮 = background + `--shadow-sm` | 视觉权重靠 background，不靠 glow |
| 装饰角 / 标题前缀条 / 键帽 | **全部移除** | 装饰元素跟 Minimalism 冲突 |
| 主画布 24px grid + 角落点阵 | **全部移除**（v1.5 + v1.6 分两步删） | 工具类应用背景装饰是噪音 |
| KPI 大数字 36-48px + 主色 text-shadow | **降到 28px**，**去掉 text-shadow** | 业务 UI 走专业克制路线 |
| 进度条渐变填充 + glow | **去渐变去 glow**，走主色实色 | 进度条用实色足够表达 |
| 状态点呼吸（1500ms） | **保留** | 等待 / 同步状态点的呼吸是功能性视觉 |
| mono 字体强制 9 + 推荐 6 | **保留** | 跟 Minimalism 不冲突（mono 是信息层级） |
| 顶部 StatusBar | **保留**（v1.4 高度从 24 → 33） | 业务需要 |
| 状态色新增 4 色（红 / 青 / 等待灰 / 离线灰） | **保留** | 三重编码（颜色 + 图标 + 文字）需要 |
| 过渡时长 150-240ms 分级 | **保留** | 跟 Minimalism 不冲突 |

---

## Skill 来源声明

本项目的 UI/UX 决策参考了：
- `.codex/skills/ui-ux-pro-max/SKILL.md` — 全套设计系统 + UX 规则（取其通用专业规则）
- gitea 官方 UI 色板（#609926 / #f76707）—— 项目生态一致性
- ui-ux-pro-max `style.domain` 的 **HUD / Sci-Fi FUI** + **Dark Mode (OLED)** 两条线（v1.1 科技感精修）
- 用户明确决策（2026-06-10）：Electron + TS，对非技术用户友好，**v1 单主题暗色**（**v1.1.2 2026-06-12 推翻为 3 主题切换**；**v1.2 2026-06-13 收敛为 2 主题**）
- 用户明确决策（2026-06-12）：暗色主题强化"技术工具的科技感"——v1.1 拍板 ✅（A 暗提饱和 + 主文字 #C5D4DD + HUD 装饰 + mono 字体场景化）
- 用户明确决策（2026-06-12）：**v1.1.2 推翻 v1 单主题暗色 → 3 主题切换**（A 暗默认 / C 暗 / Light），持久化走 sqlite，IPC 端点扩 2 个（`preferences.theme.get` / `set`）
- 用户明确决策（2026-06-13）：**v1.2 推翻 v1.1.2 → 2 主题切换**（dark 默认 / light，dark = C 暗基底中性近黑）+ 主色提亮到 `#74B830`（dark）/ 压暗到 `#466B16`（light）过 WCAG AA 4.5:1 + 滚动条 thumb 主色软底 + hover 提亮 + glow（dark）/ 实色描边（light）；端点路径不变，enum 收紧为 2 选 1

## 何时回看本文件

- 任何前端开发任务开工前 → 必读本 OVERRIDE
- 任何 UI 风格 / 配色 / 字体变更 → 必须先改本文件再改实现
- 任何术语翻译表变更 → 必须同步本文件
- 任何主题精修 / HUD 装饰 / 科技感 token 变更 → 必读 `design-system/pages/tech-refine.md`
- 字体三件套（Inter + JetBrains Mono + Noto Sans SC）默认从 Google Fonts CDN 载入；wireframe 用 `<link rel="stylesheet" href="...Inter:wght@400;500;600;700&family=JetBrains+Mono...&family=Noto+Sans+SC...">`；实现期（Electron）需考虑离线场景 → v1 把三套字体内置到 `resources/fonts/`，不走 CDN；启动期异步加载，渲染进程阻塞 < 200ms
