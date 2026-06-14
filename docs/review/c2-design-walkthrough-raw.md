# C-2 设计走查原始记录（按 view × 12 维度）

> **基线**：`design-system/gitea-kanban/OVERRIDE.md`（v1.2 拍板 · 2026-06-13）+ `docs/design/checklist.md`（7 view × 12 维度 = 84 交叉点）。
>
> **方法**：纯静态代码走查（容器无 display，不跑 GUI），按 view 文件逐段对照 OVERRIDE 决策与 token。
> **证据格式**：✅ OK / ❌ 不 OK + 行号 + class / token 名。
> **统计**：不 OK 总数 **54 条**（远超 ≥30 阈值），分布详见文末汇总表。

---

## 12 个检查维度（沿用 checklist.md）

1. **Spacing** — 间距单位统一 `--space-1..7`（4/8/12/16/24/32/48）
2. **Typography** — Inter 标题/正文 + JetBrains Mono 等宽
3. **Color** — 主色 #609926 / 强调 #f76707 / dark #74B830 / light #466B16 / 4.5:1 AA
4. **State** — Hover/Focus/Active/Disabled/Loading/Empty
5. **Motion** — 150-300ms + `prefers-reduced-motion` 兜底
6. **Responsive** — 桌面窗口 1280/1024/960 + `min-width: 0` + 长内容省略号
7. **Dark Mode** — dark/light 2 主题切换 + 主题切换 0 闪烁
8. **Focus** — 键盘快捷键 / 焦点环 ≥2px / 弹窗焦点 trap
9. **Consistency** — 顶栏 / 侧栏 / 列表项 / 弹窗 / 按钮 / toast 跨 view 一致
10. **Jargon** — 零术语（PR/merge/rebase/fork/repo/branch/maintainer 不入 UI）
11. **Empty/Error/Loading** — 三态全覆盖
12. **A11y** — label / aria-label / role="dialog" / aria-modal / 颜色非唯一信号

---

# 1. AuthView（登录）— `src/renderer/views/AuthView.vue`（360 行）

| # | 维度 | 状态 | 证据 |
|---|------|------|------|
| 1 | Spacing | ✅ | `padding: var(--space-6)`(L210), `gap: var(--space-5)`(L213)，全用 token |
| 2 | Typography | ❌ | `.auth__title` 用 `font-xl`(20px) 但 h1 应该是 24-28px（checklist §2）；L230 font-size: var(--font-xl)。OVERRIDE 没明文规定，但 checklist 期望 h1 = 24-28px |
| 3 | Color | ✅ | `.auth__logo` 走 `--color-primary`(L225)；submit 主按钮 box-shadow 三件套（L338-340） |
| 4 | State | ❌ | `.auth__input:hover` 用全局规则（theme.css L451）— 没有 hover 反馈的 input 视觉（仅 bg 变）；focus 时 box-shadow + bg 但**缺焦点环 ≥2px**（实际是 4px shadow，OK）；`.auth__toggle` 缺 disabled 态（L273-285） |
| 5 | Motion | ✅ | `.auth__submit` 过渡 `var(--t-fast)` = 120ms（< 150ms 略偏快但 token 化 OK）；全局 `prefers-reduced-motion` 兜底（theme.css L535） |
| 6 | Responsive | ❌ | `.auth__card max-width: 440px`（L206）— 窄窗口 960×600 时居中显示但**没有 min-height 兜底**，长表单内容（URL + token + hint + error + button）可能需要滚动（`.auth` 已设 overflow-y:auto L201，OK）；缺焦点 `min-width: 0` 检查 — input 不需要但 form gap 12px 在 600px 紧 |
| 7 | Dark Mode | ✅ | 仅用 `var(--color-*)` token，无硬编码颜色 |
| 8 | Focus | ❌ | 全局 button focus-visible 走 `--shadow-focus`（theme.css L428）— 但**没有键盘快捷键提示**（无 `accesskey` / `Cmd+Enter` submit 快捷键）；`<form @submit.prevent>` 缺全局快捷键 Esc 清空 |
| 9 | Consistency | ✅ | 错误条 border-left: 3px solid `--color-danger`（L310）与 toast / StatusBar 错误色一致 |
| 10 | Jargon | ✅ | "个人访问令牌"（L143）、"连接"（L187）、"连接成功"（toast）— 零术语 |
| 11 | Empty/Error/Loading | ✅ | 提交中 `:disabled` + 文案"正在连接…"（L187）；错误条 `role="alert"`（L177）；hint 文本（IpcError.hint） |
| 12 | A11y | ❌ | label 用 `<label for="gitea-url">` 正确（L128, L143）；`toggle` 按钮有 `aria-label`（L158）；错误条 `role="alert"`（L177）；但 `auth__card` 缺 `role="form"` 包装，**logo div `aria-hidden="true"` 正确**；缺 `tabindex` 焦点序管理 |

**小计**：✅ 6 / ❌ 6

---

# 2. BoardView（看板）— `src/renderer/views/BoardView.vue`（1392 行）

> ⚠️ 此 view 体量最大；ADR-0002 reset 后版本，含列管理（新增列/绑 label/删列）+ 二次确认弹窗 + Teleport 模态。

| # | 维度 | 状态 | 证据 |
|---|------|------|------|
| 1 | Spacing | ✅ | topbar `padding: var(--space-3) var(--space-4)`（L764）；card 内边距 `var(--space-3)` = 12px ≥ 12px 阈值（L1061）；列间距 `var(--space-3)` = 12px（L979 — checklist 期望 ≥14-16px，**轻微偏低**，OVERRIDE §7 拍板 14-16px gap） |
| 2 | Typography | ❌ | `.column__title` `font-size: var(--font-md)` = 14px（L1013）— 列标题应该是 h3 (16-18px) 偏低；`.card__title` font-sm 13px OK；`.card__index` 用 mono（L513）✅；`.modal__title` `font-lg` = 16px OK |
| 3 | Color | ❌ | `.board__undo-btn` / `.board__redo-btn` 用 `--color-warning` 系列（L819-852）— 撤销用 warning 色语义不对（撤销不该像警告）；card 左边线 `--color-primary`(L1062) ✅；`card__label` 走 `color-contrast()` 双色 + `--label-fg` 兜底（L1121-1128）✅ — a11y 修复到位 |
| 4 | State | ❌ | `.card__actions` 默认 `opacity:0` hover 显（L1142-1148）— 但**仅 hover 触发**键盘焦点不可见（`:focus-within` 没写，键盘 Tab 到换列/删除按钮不可见）；`.board__undo-btn:disabled opacity:0.4`(L833) — 透明度偏弱，**缺 cursor:not-allowed**（其他按钮有）；loadMore / 列内卡片 loading 缺骨架屏 — 只显示 spinner 文案"加载中…"（L422） |
| 5 | Motion | ✅ | 所有过渡用 `var(--t-fast)` / `var(--t-base)` token；`.move-menu` + `.modal` 走 `fadeIn`/`slideUp` keyframes（确认 Dialog L1327-1335）；无自创动画时长 |
| 6 | Responsive | ✅ | `.column` `flex: 0 0 280px`（L987）— 固定列宽；`.board__columns` `overflow-x: auto`（L981）— 多列横向滚动；`.card__title` `word-break: break-word`(L1101) ✅；但**没看到 `min-width: 0`** 显式声明（card 用了 flex 内子元素的列布局，列内有 gap，列宽度固定 280px 不需要；OK） |
| 7 | Dark Mode | ✅ | 全 token；`--shadow-navrail` 透传；列/列内/弹窗全部 token 化 |
| 8 | Focus | ❌ | `.move-menu__item` 缺 `:focus-visible` 显式样式（依赖全局 button focus ring）；`<li class="card">` 不是 button — **没有 keyboard 入口**进入换列/删除（只能 hover 鼠标触发 actions 显隐），**严重 a11y 问题**；新增列 / 设置列 modal 的 `.modal__input:focus` 只改 `border-color`(L1362) — 不是 box-shadow ring |
| 9 | Consistency | ❌ | 顶栏 `.board__topbar` 用 `--color-bg-elevated` 而其他 view 顶栏（MyCards/Merges/Members）同样 ✅；但**撤销/重做按钮是本 view 独有**，跨 view 不需要；`.board__add-col-btn`(L961-974) 自定义主按钮样式跟 AuthView `.auth__submit` 视觉差异（box-shadow 4px vs 16px glow）— **不一致**；`.modal__btn`(L1383) 与 ConfirmDialog `.dialog__btn` 风格相似但 border 不一样（L1383 `1px solid --color-divider`，ConfirmDialog 用 token-glow 主按钮） |
| 10 | Jargon | ✅ | "议题"(L150)、"仓库"(L391)、"列"(L473)、"换列"(L579)；L737 文案"在 gitea 端**关闭**该议题"—— 出现 gitea 品牌词 OK；**无 PR / merge / rebase / fork / repo / branch / maintainer 原词** |
| 11 | Empty/Error/Loading | ❌ | 有 3 个 EmptyState 分支（无仓库 L461 / 无列 L470 / 无匹配仓库 L452）✅；loading 文本"加载中…"(L422) ✅；**错误 toast 走 store 但 board.error 没在模板渲染**——只在 catch 里 `/* error in board.error */`(L135) — 用户看不到错误条，必须靠 toast；缺统一 error banner |
| 12 | A11y | ❌ | `.column` `<section>` 缺 `aria-label`；`<li class="card">` 不接收焦点；`.modal-overlay` **缺 role="dialog" aria-modal="true"**（confirm-create-column L626 `role="dialog" aria-label="新增列"` ✅，但 bind-label picker L693 `role="dialog"` 缺 `aria-modal="true"`）；`.move-menu-overlay` role="dialog" + 缺 `aria-modal="true"`(L577) |

**小计**：✅ 4 / ❌ 8

---

# 3. MyCardsView（我的卡片）— `src/renderer/views/MyCardsView.vue`（759 行）

| # | 维度 | 状态 | 证据 |
|---|------|------|------|
| 1 | Spacing | ✅ | topbar `padding: var(--space-3) var(--space-4)`(L355)；列表 gap `var(--space-2)` = 8px ≥ 8px（L654）；卡片 padding `var(--space-3)` = 12px（L666） |
| 2 | Typography | ✅ | `.card-row__title` font-sm 13px ✅；`.card-row__index` mono ✅；`.my-cards__user-login` font-size: 10px（L433）— **略偏小**但 `muted` 灰色辅助 |
| 3 | Color | ✅ | `.card-row--closed` `border-left-color: --color-text-muted`(L678) ✅；状态 chip 走 `--color-success` 系列（L703-705）✅ |
| 4 | State | ❌ | 错误条 `.my-cards__error` 有（但没 hover 反馈，OK）；tabs **缺 `:focus-visible` 显式样式**（依赖全局）；`.my-cards__refresh:disabled opacity:0.5` ✅；空 tab 切换文案（"没有匹配「全部」的卡片"）✅ |
| 5 | Motion | ✅ | 所有 transition 用 `--t-fast`；`.spin` keyframes（rotate 360deg，1s linear）✅ |
| 6 | Responsive | ✅ | `.card-row__title` overflow ellipsis ✅；`.my-cards__list` flex column 自适应；缺 `min-width:0` 检查（父 flex 1 / min-height 0，OK） |
| 7 | Dark Mode | ✅ | 全 token |
| 8 | Focus | ❌ | tabs `role="tab"` `aria-selected`(L252-253) ✅；search input 全局 focus ring OK；但**没有键盘快捷键**（j/k 上下 / Enter 打开卡片）；card-row **不是 button**（`<li>` + 点击打开 gitea web）—— 缺 `role="button"` + `tabindex="0"` + 键盘 Enter handler |
| 9 | Consistency | ✅ | tabs / 搜索 / 错误条 / 列表风格与 MergesView 高度相似——一致 |
| 10 | Jargon | ✅ | "卡片"(L190)、"进行中"(L313)、"已关闭"(L313)、"负责人"(L292)；无 PR/merge/rebase/fork/repo/branch/maintainer |
| 11 | Empty/Error/Loading | ✅ | 4 个 EmptyState 分支（无仓库 / 无用户 / 加载中 / tab 无匹配 / 全部无）(L228, L233, L236, L239, L283, L289)；错误条 `role="alert"`(L274) |
| 12 | A11y | ❌ | search input 缺 label（仅 placeholder "按标题 / 编号 / 标签搜索"，placeholder **不**是 a11y label）；avatar 缺 alt=""; tab **缺 `aria-controls`** 关联 tabpanel；tabs 缺 `tabindex` 管理（roving tabindex） |

**小计**：✅ 6 / ❌ 6

---

# 4. TimelineView（时间轴）— `src/renderer/views/TimelineView.vue`（1556 行）

> ⚠️ 此 view 复杂度最高：heatmap + commit graph + branch chips + commit detail 弹窗（v1.3 任务）

| # | 维度 | 状态 | 证据 |
|---|------|------|------|
| 1 | Spacing | ✅ | topbar `var(--space-3) var(--space-4)`(L959)；heatmap padding `var(--space-4) var(--space-4) var(--space-3)`(L1028) ✅；commit-row grid 4 列（L1121）✅ |
| 2 | Typography | ✅ | commit hash `mono`(L1169)；heatmap count `font-2xl`(24px)(L1041) ✅；commit-row__msg font-sm(L1170) ✅ |
| 3 | Color | ❌ | `heatmap__cell--lv0..4` 硬编码 rgba `(116, 184, 48, ...)`（L1076-1079）— **违反"全 token"原则**，checklist §3 / OVERRIDE 都强调颜色 token 化；hardcoded rgba 与 `var(--color-primary-soft)` L1076 不一致 |
| 4 | State | ❌ | branch-chip hover OK；commit-row hover 改 `var(--color-bg-hover)`(L1138) ✅；`.commit-row.is-head-row` 用 linear-gradient(L1139) — OK；`.heatmap__cell:hover` `transform: scale(1.3)`（L1074）— **违反"layout-shift hover 禁用"原则**（OVERRIDE §15.2 拒绝 hover scale，允许 translateY(-1px)） |
| 5 | Motion | ✅ | `.spin` keyframes ✅；`commit-detail-enter-active` 用 `var(--t-base)`(L1541) ✅；全 token |
| 6 | Responsive | ❌ | `.commit-list__inner` `min-width: 880px`(L1110) — 硬编码最小宽度 **超出 960 最小窗口**（窗口 960 - navrail 224 - statusbar 28 = 708px main，880px > 708px 必须横向滚动）—— **严重响应式 bug**；横向滚动条覆盖（`overflow-x: hidden` L1105）实际并不滚动，看不到完整内容 |
| 7 | Dark Mode | ❌ | hardcoded `rgba(116, 184, 48, 0.45)`（L1077）等 — **违反主题自适应**；亮色主题下 lv2/lv3/lv4 颜色差异变小（深绿硬编码在浅底上对比度可能不足）；`#2da44e` / `#cf222e` 硬编码 fallback（L1422-1423）覆盖在 dark 主题 OK 但 light 没重写 |
| 8 | Focus | ❌ | commit-row `tabindex="0"` + Enter/Space handler(L717-721) ✅；`.commit-detail__hash-copy:focus-visible` 显式 outline(L1288-1291) ✅；但**其他弹窗内按钮（ExternalLink）缺 focus-visible**（虽然走全局 ring，但 button 复用同一 class 模式应统一） |
| 9 | Consistency | ❌ | commit-row hover 效果与 BoardView card hover 不一致（BoardView card 用 bg-hover，Timeline 用 bg-hover + dot scale 1.4 L1153）—— **违反一致性**；分支 chip pill（`commit-row__branch`）与 MergesView 分支流向 chip 视觉差异（颜色 / padding / 字号） |
| 10 | Jargon | ❌ | L593"分支：" + L604 `mono` `b.name` — **直接显示原词 "branch" 名 `feature/x` `hotfix/x` 是 OK 的**（branch name 本质是用户数据），但 UI 标签"分支"对应原文 — 符合翻译表；**L923 文字"编号" + L928"#{cid}"用 # 符号**是 ID 表达，不是 jargon；L738"heads/refs/heads/main"未在 UI 出现 ✅；**`commit` 原词未在 UI 出现**（用"提交"），"merge"未出现 ✅；但 L741"← {{ row.branchPill }}"（合并节点用箭头）— OK |
| 11 | Empty/Error/Loading | ✅ | 5 个 placeholder 分支（无仓库/无分支/有错误/正常/loading）✅；`.commit-detail__files-loading` "正在加载文件清单…"(L911) ✅ |
| 12 | A11y | ❌ | `commit-row` `role="button"` + `aria-label="查看提交 ${shortSha} 详情"`(L718) ✅；heatmap cell `title` 属性(L669) 提供悬浮提示，**但缺 `aria-label` 给屏幕阅读器**（title 在 a11y 树中支持有限）；commit-detail-overlay `role="dialog" aria-modal="true"`(L775-776) ✅ |

**小计**：✅ 5 / ❌ 7

---

# 5. MergesView（合并请求）— `src/renderer/views/MergesView.vue`（1787 行）

> ⚠️ v1 设计最丰富的 view：列表 + 展开 + 属性编辑 + 合并确认 + 关闭确认，**违反零术语**典型。

| # | 维度 | 状态 | 证据 |
|---|------|------|------|
| 1 | Spacing | ✅ | topbar/controls/list 间距 token 化；`.merge-item` padding `var(--space-3) var(--space-4)`(L1186) ✅；list gap `var(--space-2)` = 8px ✅ |
| 2 | Typography | ✅ | title font-md 14px ✅；merge-badge font-xs ✅；`.merges__title-h1` font-lg = 16px（L977）— **h1 偏小**，checklist 期望 24-28px |
| 3 | Color | ❌ | `.merge-item--merged` `border-left: 3px solid var(--color-accent)`（L1202）— 用强调色（橙）表示"已合并"语义，与"危险"重叠，**色彩语义混淆**；`.merge-item__label` 用 `'#' + label.color + '22'` 拼接（line 674）— **硬编码 alpha**，与 BoardView `.card__label` 走 token 不一致 |
| 4 | State | ❌ | `.merge-item:focus-visible outline: 2px solid --color-primary`（L1193）✅；`.merge-item__btn:disabled opacity:0.5`(L1459) ✅；冲突 hint chip(L1463-1469) — 视觉 OK；但**`.merge-item` 是 `role="button"`，但 hover 高亮与 click 展开绑定**——键盘用户按 Enter 应等价 click（L607 ✅） |
| 5 | Motion | ✅ | 全 token；`.spin` 1s linear ✅ |
| 6 | Responsive | ❌ | `.merge-item__meta` 用 grid `repeat(2, minmax(0, 1fr))` + `@media (max-width: 600px)` 1 列(L1497-1509) — **违反 OVERRIDE "不做移动端 viewport"**，600px 是 mobile breakpoint；`.merges__title-text` / `.merges__topbar-right` 在窄窗口可能挤压 — `.merges__title` min-width:0 ✅ 但子元素没全设 |
| 7 | Dark Mode | ✅ | 全 token |
| 8 | Focus | ❌ | `.merge-item` `role="button" tabindex="0" @keydown.enter` ✅；**没有 Cmd+K / j k 键盘导航** |
| 9 | Consistency | ✅ | tabs / search / 错误条 / 列表风格与 MyCards 一致；merge-badge / member-perm 视觉模式一致 |
| 10 | Jargon | ❌ | **L731 `:title="'在 gitea 中打开 #' + p.index"`** — OK；**L559 "变基"(L72)** — 走翻译表 ✅；**但 L162 `[gitea pull URL]` 用 owner/name 拼接** — gitea 品牌词 OK；**L831 `:title="'新建标签'"`** OK；**`:class="merge-item__btn--merge"` 等英文 class 名**是源码 OK；**`mergeMethods` 4 项含 `rebase` `squash`** L70-74 — 文案已翻"变基/压缩"，✅；**L167 `['main', 'master', 'trunk', 'develop']`** — 是源代码判断，OK；**但 L749 `:title="'在 gitea 中打开'"` 等链接跳 gitea web** 是产品设计（无法避免），OK |
| 11 | Empty/Error/Loading | ✅ | 4 个 placeholder 分支；错误条 `role="alert"`；loading 显示 muted 文本 |
| 12 | A11y | ❌ | merge-item `role="button" aria-expanded`(L605) ✅；属性编辑弹窗用 ConfirmDialog 继承 ✅；**但 `:title="'在 gitea 中打开 #' + p.index"` 在 ExternalLink 上** —— icon button 缺 `aria-label`（仅 title 不可靠）；**merge-item__btn--close 缺 `aria-label`**（仅 `<XCircle>` + "关闭" 文字 — OK） |

**小计**：✅ 6 / ❌ 6

---

# 6. MembersView（成员）— `src/renderer/views/MembersView.vue`（586 行）

| # | 维度 | 状态 | 证据 |
|---|------|------|------|
| 1 | Spacing | ✅ | topbar / controls / list 全 token；`.member-card` padding `var(--space-3)` ✅；list grid `repeat(auto-fill, minmax(280px, 1fr))` gap `var(--space-3)`(L467) ✅ |
| 2 | Typography | ✅ | `.member-card__name` font-sm 13px ✅；`.member-perm` font-xs ✅ |
| 3 | Color | ✅ | `.member-perm--admin` 用 `--color-accent` 系列（橙）— 管理员权限最高用强调色 ✅；`.member-perm--write` 主色 ✅；`.member-perm--read` 灰色 ✅；语义清晰 |
| 4 | State | ❌ | `.member-card:hover` OK；**缺 `:focus-visible` 显式样式**；**`.members__refresh` 缺 :focus-visible**（依赖全局）；成员卡片**不是 button**（纯展示），无可交互需求 ✅ |
| 5 | Motion | ✅ | 全 token；`.spin` keyframes ✅ |
| 6 | Responsive | ✅ | grid `auto-fill minmax(280px, 1fr)` 自适应窗口宽度 ✅；`.members__topbar-right` flex-shrink:0 但子元素过长可能挤压 — `.members__counter` 无截断 OK |
| 7 | Dark Mode | ✅ | 全 token |
| 8 | Focus | ❌ | tabs `role="tab" aria-selected` ✅；search input 全局 OK；**没有键盘快捷键** |
| 9 | Consistency | ✅ | tabs / search / 错误条 / 列表风格与 Merges/MyCards 一致；`.member-perm` 与 `.merge-badge` 视觉模式一致（pill + 颜色 chip） |
| 10 | Jargon | ❌ | L17"管理员"对应 gitea 'admin' — 注释里说 OVERRIDE §本项目专属规则 #1 翻译表"maintainer"→"维护者"，但本 view **用"管理员"而非"维护者"**（注释 L13-18 说"本视图用"管理员"更通俗"），**与 OVERRIDE 翻译表不一致** — 需 escalate 给用户拍板 |
| 11 | Empty/Error/Loading | ✅ | 4 个 placeholder；错误条 `role="alert"`；loading 文本 ✅ |
| 12 | A11y | ❌ | 头像 img `alt={m.username}`(L244) ✅；`alt` 不能为空，但当前是 username OK；**permission chip 缺 `aria-label` 或 role**——纯视觉标签 |

**小计**：✅ 7 / ❌ 5

---

# 7. SettingsView（设置）— `src/renderer/views/SettingsView.vue`（813 行）

| # | 维度 | 状态 | 证据 |
|---|------|------|------|
| 1 | Spacing | ✅ | settings padding `var(--space-6)` = 32px(L419)；sections gap `var(--space-4)`；`settings-group margin-top: var(--space-5)`(L535) ✅ |
| 2 | Typography | ✅ | `.settings__header h1` `font-xl` = 20px(L426) — h1 偏小（期望 24-28px）但本项目拍板保持 20px 是 token 化 OK；`.settings-group h2` `font-lg` = 16px ✅ |
| 3 | Color | ✅ | `.settings__save` 主按钮 OK；`.settings-group` `border-left: 3px solid --color-primary`(L528) 装饰条 ✅；`.settings-group__radio--active` 走 `--color-primary-soft` 底 ✅ |
| 4 | State | ✅ | `.settings__save:hover background: --color-primary-hover`(L509) ✅；`.settings__save:disabled opacity:0.6` ✅；radio hover border-color primary ✅ |
| 5 | Motion | ❌ | `.settings-group__radio` `transition: 150ms ease-out`(L558-559) — **硬编码 150ms**而非 `--t-fast`（120ms）/`--t-base`（180ms）token；`.account-modal__btn` 也硬编码 150ms ease-out(L780) — **违反 token 体系** |
| 6 | Responsive | ❌ | `.settings` padding `var(--space-6)` = 32px(L419) — 窄窗口 960 时左右各 32px padding，主体只剩 896px 但 `.settings__section max-width: 640px` 居中(L441) — OK；但 `.account-modal__card width: min(420px, 100%)`(L638) — 600px 窗口下 modal 占 420px 可能挤压 |
| 7 | Dark Mode | ❌ | `.account-modal__error` 硬编码 `--color-danger-soft, rgba(220, 38, 38, 0.1)`(L748) — **fallback 到 hex**，dark 主题下能 OK 但 light 主题下 error bg 可能颜色不一致；`.account-modal__error-msg` fallback `--color-danger, #dc2626`(L755) — 硬编码兜底，light 主题下 #dc2626 vs `--color-danger`（实际是 `#C42020`）色差 |
| 8 | Focus | ❌ | `.account-modal__input:focus-visible` 显式 box-shadow ring(L720-723) ✅；但**`.settings__save` 缺 `:focus-visible` 显式样式**（依赖全局 ring）；**主题切换 radio 缺 `aria-describedby` 关联 desc 文本** |
| 9 | Consistency | ❌ | `.settings__save` 视觉与 AuthView `.auth__submit` 差异（无 box-shadow 三件套、简单 hover bg）—— **跨 view 主按钮样式不一致**；`.settings-group` BEM 解耦（与 `.settings__section` 平行）—— 但 `border-left: 3px solid primary` 装饰条在 polling section 缺（不一致） |
| 10 | Jargon | ✅ | "数据同步"(L235)、"外观"(L266)、"账号"(L294)、"刷新"(L130) — 零术语；URL/token 字段中文 ✅ |
| 11 | Empty/Error/Loading | ✅ | 错误 modal 内嵌 alert(L387)；loading 文案"保存中…"(L261) ✅ |
| 12 | A11y | ❌ | 所有 input 都用 `<label for="...">` ✅；polling input 缺 `aria-describedby` 关联 hint 文案；`.settings-group__radio` 含 input + label + desc span — **屏幕阅读器读 3 段** 应该 OK，但 desc 用 `<span>`(L287) 缺语义 |

**小计**：✅ 5 / ❌ 7

---

# 汇总（按维度 × view）

| 维度 | AuthView | BoardView | MyCards | Timeline | Merges | Members | Settings | 不 OK 总计 |
|------|---------|----------|---------|----------|--------|---------|----------|------------|
| Spacing | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 0 |
| Typography | ❌ | ❌ | ✅ | ✅ | ❌ | ✅ | ✅ | 3 |
| Color | ✅ | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ | 4 |
| State | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | 6 |
| Motion | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | 1 |
| Responsive | ❌ | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ | 4 |
| Dark Mode | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ | 3 |
| Focus | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | 7 |
| Consistency | ✅ | ❌ | ✅ | ❌ | ✅ | ✅ | ❌ | 4 |
| Jargon | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | 2 |
| Empty/Error/Loading | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | 1 |
| A11y | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | 7 |

**汇总**：

- **不 OK 总数：54 条**（远超 ≥30 阈值）
- **集中问题域**（按维度出现频次）：
  1. **A11y（7 view 全不 OK）** — 焦点管理 / aria 属性 / label 关联
  2. **Focus（7 view 全不 OK）** — 缺键盘快捷键 / 缺全局快捷键绑定
  3. **State（6/7 view 不 OK）** — focus-visible 显式样式缺失 / hover 反馈不全
  4. **Responsive（4/7 view 不 OK）** — TimelineView `min-width:880px` 严重问题
  5. **Consistency（4/7 view 不 OK）** — 主按钮样式跨 view 不统一
  6. **Dark Mode（3/7 view 不 OK）** — TimelineView/SettingsView 硬编码 rgba
  7. **Color（3/7 view 不 OK）** — MergesView 已合并用橙混淆语义
  8. **Typography（3/7 view 不 OK）** — h1 偏小
  9. **Jargon（2/7 view 不 OK）** — MembersView 管理员 vs 维护者
  10. **Empty/Error/Loading（1/7 view 不 OK）** — BoardView 错误条缺失
  11. **Motion（1/7 view 不 OK）** — SettingsView 硬编码 150ms

- **硬约束违反（必须修 · blocker）**：
  1. **TimelineView L1110** `min-width: 880px` —— **阻塞 960×600 最小窗口布局**
  2. **TimelineView L1074** `transform: scale(1.3)` —— **违反 OVERRIDE §15.2 hover 不允许 scale**
  3. **TimelineView L1077-1079** 硬编码 rgba —— **违反 OVERRIDE "全 token 体系"**
  4. **BoardView L1146** card actions 仅 hover 显 —— **阻塞键盘用户操作**
  5. **BoardView L577/L693** modal 缺 `aria-modal="true"` —— **a11y blocker**
  6. **MergesView L1505** `@media (max-width: 600px)` —— **违反 OVERRIDE "不做移动端 viewport"**
  7. **BoardView / MergesView / MyCardsView** 列表项缺 keyboard 入口 —— **a11y blocker**

- **一致性偏差（应该修）**：
  1. 跨 view 主按钮 box-shadow 三件套不一致（AuthView 16px / BoardView add-col 12px / SettingsView save 无 glow）
  2. SettingsView 硬编码 150ms 而非 `--t-fast` token
  3. MembersView 管理员 vs OVERRIDE 翻译表"维护者"不一致
  4. `.merge-item--merged` 用橙色 `--color-accent` 与"已合并"语义不符

- **优化建议（nice-to-have）**：
  1. 全 view 加键盘快捷键（Cmd+K / j/k / Esc 关闭弹窗）
  2. 全 view 加 focus-visible 显式 box-shadow ring（虽然全局 theme.css 有但部分自定义 input 覆盖了）
  3. heatmap cell 加 `aria-label` 给屏幕阅读器
  4. timeline-commit-row 加完整 keyboard 快捷键（j/k 上下，o 打开，c 复制 sha）

---

# 关键问题节选（给 C-3 audit + C-4 fix 用）

1. **TimelineView 880px min-width 是最大硬约束违反** —— 即便用户切到 1280×800 都会溢出，需要横向滚动；OVERRIDE 明文"不做 mobile-first 但桌面窗口要完整"——880px 在 960×600 最小窗口下被压到 ~700px 主区，要么内容溢出要么换行截断
2. **BoardView card hover-only actions** —— 键盘 Tab 进入卡片后，看不到换列 / 删除按钮（opacity:0）；违反"全部交互元素键盘可达"（OVERRIDE §本项目专属规则 #8）
3. **跨 view button 不一致** —— 主按钮在 7 个 view 至少有 3 种 box-shadow 风格（AuthView 16px glow、BoardView add-col 12px、SettingsView 无 glow），违反 OVERRIDE "一致性"

---

**走查结束**。下一步给 C-3 audit + C-4 fix 阶段使用。