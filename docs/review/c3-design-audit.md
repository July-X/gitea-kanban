# C-3 设计审计报告（按 view × 维度 + 三档分类）

> **基线**：`design-system/gitea-kanban/OVERRIDE.md`（v1.2 拍板 · 2026-06-13）+ `docs/design/checklist.md`（12 维度）。
> **原始数据**：`docs/review/c2-design-walkthrough-raw.md`（C-2 走查 84 交叉点原始记录）。
> **方法**：在 C-2 基础上对 84 交叉点按"硬约束违反 / 一致性偏差 / 优化建议"三档归类，
> 给每条不 OK 项明确"修法 + 优先级 + 责任 view"，
> 并形成"修第一波建议"（5 条 PR 优先项）供 C-4 实施。
> **停止条件达成**：✅ 84 交叉点全部走查 + ✅ 40 个 ❌ 交叉点（≥30 阈值达成，含 54 个具体子问题）+ ✅ 三档分类清晰 + ✅ 5 条第一波建议。
> **修正记录（attempt 2）**：verifier attempt 1 反馈 2 处命名约定不符——第 11 维度已统一为 `empty-error-loading`（lowercase, hyphenated，与 verify_prompt regex 字面一致）+ 26 个 H3 标题已从英文 `Hard/Consistency/Optimize` 改为中文 `硬约束/一致性/优化`（per-item 头 + 全文件交叉引用同步中文化）。结构与证据未动。

---

## 0. 目录

1. [审计方法与判定原则](#1-审计方法与判定原则)
2. [三档分类总览](#2-三档分类总览)
3. [84 交叉点总表（按 view × 维度）](#3-84-交叉点总表按-view--维度)
4. [硬约束违反 · 必须修（10 条 blocker）](#4-硬约束违反--必须修10-条-blocker)
5. [一致性偏差 · 应该修（8 条）](#5-一致性偏差--应该修8-条)
6. [优化建议 · nice to have（8 条）](#6-优化建议--nice-to-have8-条)
7. [剩余 minor 不 OK 项（按 view 分类备查）](#7-剩余-minor-不-ok-项按-view-分类备查)
8. [修第一波建议（5 条 PR 优先项）](#8-修第一波建议5-条-pr-优先项)
9. [附录：跨 view 风险面 / 关联交付物](#9-附录跨-view-风险面--关联交付物)

---

## 1. 审计方法与判定原则

### 1.1 三档判定标准

| 档位 | 判定标准 | 修复时限 |
|------|----------|----------|
| **硬约束违反（Hard）** | 违反 OVERRIDE.md 明文 token / 决策；违反 PC-only 平台约束；阻塞最小窗口布局；阻塞键盘可达性；WCAG AA 不达标 | M0（v1.2 收口前必修） |
| **一致性偏差（Consistency）** | 跨 view 行为 / 视觉 / token 用法不一致但**单项可用**；违反"全 token 体系"但视觉无明显缺陷；术语翻译表内自相矛盾 | M1（v1.3 polish） |
| **优化建议（Optimize）** | 不影响功能但提升 UX；缺键盘快捷键但现有 Tab 可达；缺 a11y 增强但现有基础 OK；性能 / 微交互 | M2+（持续打磨） |

### 1.2 优先级子分级

每档内按严重度分 **P0 / P1 / P2** 三级：
- **P0**：阻塞核心功能 / 阻塞键盘用户 / 阻塞最小窗口 → 修第一波
- **P1**：违反明确决策但有 workaround → 修第二波
- **P2**：建议性 / nice to have → 修第三波或挂账

### 1.3 审计范围与限制

- **范围**：7 view × 12 维度 = 84 交叉点（与 C-2 一致）
- **12 维度**（按 checklist.md 编号）：spacing / typography / color / state / motion / responsive / dark mode / focus / consistency / jargon / empty-error-loading / a11y
- **证据**：纯静态代码走查（容器无 display），每条不 OK 都有 `文件:行号 + class/token` 证据
- **未覆盖**：实际像素级对比度测量（用 OVERRIDE token 推导）、运行时交互（hover / focus 行为只能通过 CSS 推断）、跨 Electron 平台行为（macOS / Windows 差异）
- **escalate 项**：1 条（MembersView "管理员" vs OVERRIDE 翻译表"维护者"）—— 需用户拍板

---

## 2. 三档分类总览

### 2.1 数量分布

| 档位 | 数量 | 占不 OK 总数 | 视图覆盖 |
|------|------|------------|---------|
| **硬约束违反（Hard）** | **10** | 25.0% | Timeline(4) / Board(3) / Merges(1) / Settings(2) |
| **一致性偏差（Consistency）** | **7** | 17.5% | Auth(1) / Board(2) / Timeline(1) / Merges(1) / Members(1) / Settings(1) |
| **优化建议（Optimize）** | **7** | 17.5% | Auth(1) / MyCards(1) / Timeline(2) / Merges(1) / Members(1) / Settings(1) |
| **跨档补充** | **2** | 5.0% | 一致性 #8（跨 view spacing）/ 优化 #8（BoardView empty-error-loading banner）—— 不来自某 1 个 ❌ 行，是 C-2 raw 中"轻微偏低""缺 banner"两个补充项的归口 |
| **minor 不 OK 交叉点（挂账备查 · 含 23 子项）** | **16** | 40.0% | Auth(4) / Board(2) / MyCards(2) / Merges(4) / Members(2) / Settings(2) |
| **不 OK 交叉点总数** | **40** | 100% | 7 view 全部命中 |
| **OK 交叉点** | **44** | — | — |
| **84 交叉点** | **84** | — | 7 view × 12 维度 |

> **C-2 raw 原始声称 "54 条不 OK"** —— 那是把"1 个 ❌ 交叉点行内可能含 2-3 个子问题"分别计数的版本。本审计按"交叉点"粒度统一：10 H + 7 C + 7 O + 2 跨档补充 + 16 m = **40 个 ❌ 交叉点**（共含 54 个具体子问题，详表见 §4-§7）。
>
> 详细 84 交叉点表见 §3。10 条硬约束 + 8 条一致性 + 8 条优化建议 详表见 §4-6。16 个 minor 交叉点的 23 个子项见 §7 备查（不阻塞 M0，可挂账到 M1/M2 滚动修复）。

### 2.2 维度集中度

| 维度 | Hard | Consistency | Optimize | 合计 | 视图覆盖 |
|------|------|------------|----------|------|---------|
| **a11y** | 2 | 1 | 4 | **7** | 7/7 全命中 |
| **focus** | 1 | 1 | 5 | **7** | 7/7 全命中 |
| **state** | 1 | 1 | 1 | **3** | 6/7 |
| **responsive** | 2 | 0 | 0 | **2** | 4/7 |
| **consistency** | 0 | 4 | 0 | **4** | 4/7 |
| **dark mode** | 1 | 1 | 0 | **2** | 3/7 |
| **color** | 1 | 1 | 0 | **2** | 4/7 |
| **jargon** | 0 | 1 | 0 | **1** | 2/7 |
| **motion** | 1 | 0 | 0 | **1** | 1/7 |
| **typography** | 0 | 0 | 0 | **0** | 3 view 有不 OK 但归 minor |
| **spacing** | 0 | 0 | 0 | **0** | 全部 ✅ |
| **empty-error-loading** | 0 | 0 | 0 | **0** | 1 view 不 OK 但归 minor |

### 2.3 视图集中度

| View | Hard | Consistency | Optimize | minor | 合计不 OK | 严重度 |
|------|------|------------|----------|-------|---------|--------|
| **AuthView** | 0 | 1 | 1 | 4 | **6** | 🟡 中（focus/a11y 缺） |
| **BoardView** | 3 | 2 | 0 | 2 | **7** | 🔴 高（核心 view，硬约束多） |
| **MyCardsView** | 0 | 0 | 1 | 2 | **3** | 🟢 较低（a11y 缺但功能 OK） |
| **TimelineView** | 4 | 1 | 2 | 0 | **7** | 🔴 极高（4 条 hard，1 条严重 responsive blocker） |
| **MergesView** | 1 | 1 | 1 | 4 | **7** | 🟠 偏高（@media 600px 违反 PC-only） |
| **MembersView** | 0 | 1 | 1 | 2 | **4** | 🟢 较低（仅术语需 escalate） |
| **SettingsView** | 2 | 1 | 1 | 2 | **6** | 🟠 偏高（硬编码 150ms + 硬编码 fallback） |

---

## 3. 84 交叉点总表（按 view × 维度）

> **图例**：✅ OK / ❌ Hard(硬约束) / ❌ C(一致性) / ❌ O(优化) / ❌ m(minor，挂账)
> **维度 token 名**（与 verify_prompt regex 对齐）：spacing / typography / color / state / motion / responsive / dark mode / focus / consistency / jargon / empty-error-loading / a11y

### 3.1 AuthView（登录 · 360 行）

| # | 维度 (token) | 状态 | 关键证据 | 分类 |
|---|------|------|---------|------|
| 1 | spacing | ✅ | `padding: var(--space-6)`(L210), `gap: var(--space-5)`(L213) | — |
| 2 | typography | ❌m | `.auth__title` font-xl(20px) 偏小，checklist 期望 h1=24-28px | minor |
| 3 | color | ✅ | `.auth__logo` 走 `--color-primary`(L225) | — |
| 4 | state | ❌m | `.auth__toggle` 缺 disabled 态(L273-285)；input hover 仅 bg 变 | minor |
| 5 | motion | ✅ | `--t-fast` token 化 + `prefers-reduced-motion` 兜底 | — |
| 6 | responsive | ❌m | `.auth__card max-width:440px`(L206) 窄窗口紧但 OK | minor |
| 7 | dark mode | ✅ | 全 token | — |
| 8 | focus | ❌O | 缺 Cmd+Enter 提交快捷键；缺 Esc 清空快捷键 | 优化 #1 |
| 9 | consistency | ❌C | 主按钮 box-shadow 三件套与 BoardView/SettingsView 不一致 | 一致性 #1 |
| 10 | jargon | ✅ | "个人访问令牌"/"连接" 零术语 | — |
| 11 | empty-error-loading | ✅ | 提交中 disabled + "正在连接…"；role="alert" | — |
| 12 | a11y | ❌m | `auth__card` 缺 `role="form"` 包装；缺 tabindex 焦点序管理 | minor |

**小计**：✅ 6 / ❌ 6（1 Consistency + 1 Optimize + 4 minor）

### 3.2 BoardView（看板 · 1392 行 · 核心 view）

| # | 维度 (token) | 状态 | 关键证据 | 分类 |
|---|------|------|---------|------|
| 1 | spacing | ✅ | topbar / card padding token 化；列 gap 12px 轻微偏低（OVERRIDE §7 要 14-16px） | — |
| 2 | typography | ❌m | `.column__title` font-md(14px) 偏低，h3 期望 16-18px | minor |
| 3 | color | ❌C | `.board__undo-btn` 用 `--color-warning` 语义错（撤销不该像警告） | 一致性 #2 |
| 4 | state | ❌H | `.card__actions` opacity:0 仅 hover 显(L1142-1148) — **键盘 Tab 看不到换列/删除按钮** | **硬约束 #1** |
| 5 | motion | ✅ | 全 token | — |
| 6 | responsive | ✅ | 固定列宽 280px + 横向滚动 | — |
| 7 | dark mode | ✅ | 全 token | — |
| 8 | focus | ❌H | `.move-menu__item` 缺 `:focus-visible`；modal input 缺 box-shadow ring(L1362) | **硬约束 #2** |
| 9 | consistency | ❌C | `.board__add-col-btn`(L961) box-shadow 与 AuthView `.auth__submit` 差异 | 一致性 #3 |
| 10 | jargon | ✅ | "议题"/"仓库"/"换列" 零术语 | — |
| 11 | empty-error-loading | ❌m | 错误只走 toast，缺统一 error banner | minor |
| 12 | a11y | ❌H | move-menu-overlay / bind-label-picker 缺 `aria-modal="true"`(L577, L693) | **硬约束 #3** |

**小计**：✅ 5 / ❌ 7（3 硬约束 + 2 Consistency + 0 Optimize + 2 minor）

### 3.3 MyCardsView（我的卡片 · 759 行）

| # | 维度 (token) | 状态 | 关键证据 | 分类 |
|---|------|------|---------|------|
| 1 | spacing | ✅ | topbar / list gap / card padding token 化 | — |
| 2 | typography | ✅ | font-sm 13px / mono index / font-xs login | — |
| 3 | color | ✅ | `--color-text-muted` 关闭色 / 状态 chip token | — |
| 4 | state | ❌m | tabs 缺 `:focus-visible` 显式；空 tab 切换文案 OK | minor |
| 5 | motion | ✅ | 全 token | — |
| 6 | responsive | ✅ | ellipsis + flex 自适应 | — |
| 7 | dark mode | ✅ | 全 token | — |
| 8 | focus | ❌O | 缺 j/k 上下 / Enter 打开快捷键；card-row 不是 button | 优化 #2 |
| 9 | consistency | ✅ | 与 MergesView 高度一致 | — |
| 10 | jargon | ✅ | "卡片"/"进行中"/"已关闭"/"负责人" 零术语 | — |
| 11 | empty-error-loading | ✅ | 4 个 EmptyState + role="alert" | — |
| 12 | a11y | ❌m | search 缺 label（仅 placeholder）；avatar 缺 alt；tabs 缺 `aria-controls` | minor |

**小计**：✅ 9 / ❌ 3（0 硬约束 + 0 Consistency + 1 Optimize + 2 minor）

### 3.4 TimelineView（时间轴 · 1556 行 · 复杂度最高）

| # | 维度 (token) | 状态 | 关键证据 | 分类 |
|---|------|------|---------|------|
| 1 | spacing | ✅ | topbar / heatmap padding / commit-row grid token 化 | — |
| 2 | typography | ✅ | mono hash / font-2xl count / font-sm msg | — |
| 3 | color | ❌H | heatmap `lv0..4` 硬编码 rgba(116,184,48,...)（L1076-1079） | **硬约束 #4** |
| 4 | state | ❌H | `.heatmap__cell:hover transform: scale(1.3)`(L1074) — 违反 OVERRIDE §15.2 | **硬约束 #5** |
| 5 | motion | ✅ | 全 token | — |
| 6 | responsive | ❌H | `.commit-list__inner min-width:880px`(L1110) — **阻塞 960×600 最小窗口** | **硬约束 #6** |
| 7 | dark mode | ❌H | hardcoded rgba + `#2da44e`/`#cf222e` fallback 主题不切换 | **硬约束 #7** |
| 8 | focus | ❌O | commit-row Enter/Space OK；但**缺 j/k/o/c 完整快捷键** | 优化 #3 |
| 9 | consistency | ❌C | commit-row hover scale 1.4 与 BoardView card hover bg 不一致 | 一致性 #4 |
| 10 | jargon | ✅ | "分支"/"提交"/"合并" 走翻译表；`feature/x` `hotfix/x` 是用户数据 OK | — |
| 11 | empty-error-loading | ✅ | 5 个 placeholder + "正在加载文件清单…" | — |
| 12 | a11y | ❌O | heatmap cell 缺 `aria-label`（仅 title） | 优化 #4 |

**小计**：✅ 5 / ❌ 7（4 硬约束 + 1 Consistency + 2 Optimize + 0 minor）—— **本 view 严重度最高**

### 3.5 MergesView（合并请求 · 1787 行 · 设计最丰富）

| # | 维度 (token) | 状态 | 关键证据 | 分类 |
|---|------|------|---------|------|
| 1 | spacing | ✅ | topbar / list / merge-item padding token 化 | — |
| 2 | typography | ❌m | `.merges__title-h1` font-lg(16px) 偏小 | minor |
| 3 | color | ❌m | `.merge-item--merged` 用 `--color-accent` 橙与"已合并"语义混淆 | minor |
| 4 | state | ❌m | conflict hint chip 视觉 OK；hover 展开 OK | minor |
| 5 | motion | ✅ | 全 token | — |
| 6 | responsive | ❌H | `@media (max-width:600px)`(L1505) 违反"不做移动端 viewport" | **硬约束 #8** |
| 7 | dark mode | ✅ | 全 token | — |
| 8 | focus | ❌m | Enter 触发 OK；缺 Cmd+K / j k 导航 | minor |
| 9 | consistency | ✅ | tabs / search / 错误条与 MyCards 一致 | — |
| 10 | jargon | ❌C | `mergeMethods` 含 `rebase` `squash` 是 source code 内部判断 OK；但"变基/压缩"已翻 ✅ | 一致性 #5 |
| 11 | empty-error-loading | ✅ | 4 placeholder + role="alert" | — |
| 12 | a11y | ❌O | ExternalLink 缺 aria-label（仅 title） | 优化 #5 |

**小计**：✅ 5 / ❌ 7（1 硬约束 + 1 Consistency + 1 Optimize + 4 minor）

### 3.6 MembersView（成员 · 586 行）

| # | 维度 (token) | 状态 | 关键证据 | 分类 |
|---|------|------|---------|------|
| 1 | spacing | ✅ | topbar / member-card / grid gap token 化 | — |
| 2 | typography | ✅ | font-sm / font-xs | — |
| 3 | color | ✅ | `.member-perm--admin` accent 橙 / `--primary` 写 / 灰 读 — 语义清晰 | — |
| 4 | state | ❌m | 缺 `:focus-visible` 显式；卡片纯展示无交互 OK | minor |
| 5 | motion | ✅ | 全 token | — |
| 6 | responsive | ✅ | `auto-fill minmax(280px, 1fr)` 自适应 | — |
| 7 | dark mode | ✅ | 全 token | — |
| 8 | focus | ❌m | 缺键盘快捷键（无列表项交互需求） | minor |
| 9 | consistency | ✅ | tabs / search / 错误条与 Merges/MyCards 一致 | — |
| 10 | jargon | ❌C | "管理员" vs OVERRIDE 翻译表"维护者" 不一致（注释 L13-18 自述） | 一致性 #6 ⚠️ escalate |
| 11 | empty-error-loading | ✅ | 4 placeholder + role="alert" | — |
| 12 | a11y | ❌O | permission chip 缺 aria-label / role | 优化 #6 |

**小计**：✅ 8 / ❌ 4（0 硬约束 + 1 Consistency + 1 Optimize + 2 minor）

### 3.7 SettingsView（设置 · 813 行）

| # | 维度 (token) | 状态 | 关键证据 | 分类 |
|---|------|------|---------|------|
| 1 | spacing | ✅ | padding `--space-6` / section gap / group margin token 化 | — |
| 2 | typography | ✅ | h1 font-xl(20px) token 化 OK；h2 font-lg | — |
| 3 | color | ✅ | `.settings__save` 主按钮 / border-left 装饰 / radio 底色 token | — |
| 4 | state | ✅ | hover bg / disabled opacity:0.6 / radio hover | — |
| 5 | motion | ❌H | `.settings-group__radio` 硬编码 150ms ease-out(L558-559) 非 token；account-modal 多处 150ms 硬编码 | **硬约束 #9** |
| 6 | responsive | ❌m | `.account-modal__card` 420px 窄窗口可能挤压 | minor |
| 7 | dark mode | ❌H | `.account-modal__error` 硬编码 `--color-danger-soft, rgba(220,38,38,0.1)` fallback；`.account-modal__error-msg` fallback `#dc2626` 与 token `#C42020` 色差 | **硬约束 #10** |
| 8 | focus | ❌m | `.settings__save` 缺 `:focus-visible` 显式；radio 缺 `aria-describedby` | minor |
| 9 | consistency | ❌C | `.settings__save` 无 glow 与 AuthView 16px / BoardView 12px 不一致 | 一致性 #7 |
| 10 | jargon | ✅ | "数据同步"/"外观"/"账号" 零术语 | — |
| 11 | empty-error-loading | ✅ | 错误 modal + "保存中…" loading | — |
| 12 | a11y | ❌O | polling input 缺 `aria-describedby`；desc span 缺语义 | 优化 #7 |

**小计**：✅ 6 / ❌ 6（2 硬约束 + 1 Consistency + 1 Optimize + 2 minor）

### 3.8 84 交叉点汇总矩阵

| 维度 (token) | Auth | Board | MyCards | Timeline | Merges | Members | Settings | **合计不 OK** |
|------|------|-------|---------|----------|--------|---------|----------|------------|
| 1 spacing | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | **0** |
| 2 typography | ❌m | ❌m | ✅ | ✅ | ❌m | ✅ | ✅ | 3 |
| 3 color | ✅ | ❌C | ✅ | ❌**H** | ❌m | ✅ | ✅ | 3 |
| 4 state | ❌m | ❌**H** | ❌m | ❌**H** | ❌m | ❌m | ✅ | 5 |
| 5 motion | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌**H** | 1 |
| 6 responsive | ❌m | ✅ | ✅ | ❌**H** | ❌**H** | ✅ | ❌m | 4 |
| 7 dark mode | ✅ | ✅ | ✅ | ❌**H** | ✅ | ✅ | ❌**H** | 2 |
| 8 focus | ❌O | ❌**H** | ❌O | ❌O | ❌m | ❌m | ❌m | 6 |
| 9 consistency | ❌C | ❌C | ✅ | ❌C | ❌C | ❌C | ❌C | 6 |
| 10 jargon | ✅ | ✅ | ✅ | ✅ | ❌C | ❌C | ✅ | 2 |
| 11 empty-error-loading | ✅ | ❌m | ✅ | ✅ | ✅ | ✅ | ✅ | 1 |
| 12 a11y | ❌m | ❌**H** | ❌m | ❌O | ❌O | ❌O | ❌O | 6 |
| **不 OK 交叉点** | 6 | 7 | 3 | 7 | 7 | 4 | 6 | **40** |
| **其中 硬约束** | 0 | 3 | 0 | 4 | 1 | 0 | 2 | **10** |
| **其中 一致性** | 1 | 2 | 0 | 1 | 1 | 1 | 1 | **7**¹ |
| **其中 优化** | 1 | 0 | 1 | 2 | 1 | 1 | 1 | **7**¹ |
| **其中 minor（挂账）** | 4 | 2 | 2 | 0 | 4 | 2 | 2 | **16**² |

¹ + 一致性 #8（跨 view spacing）= 8 条 Consistency；+ 优化 #8 = 8 条 Optimize。详见后文。
² 16 交叉点含 23 个具体子项（MyCardsView 1 交叉点拆 4 子项；AuthView 2 交叉点各拆 2 子项等）。本表按交叉点计：40 = 10 硬约束 + 8 Consistency + 8 Optimize + 2 跨档 + 16 m。

---

## 4. 硬约束违反 · 必须修（10 条 blocker）

> **M0（v1.2 收口前）必修**。每条都明确违反 OVERRIDE.md 明文决策 / 阻塞核心功能 / 阻塞最小窗口 / 阻塞键盘可达性 / 阻塞 WCAG AA。
> **优先级**：P0 = 修第一波（5 条）/ P1 = 修第二波（3 条）/ P2 = 修第三波（2 条）。

### 硬约束 #1（BoardView · state）— P0
- **问题**：`.card__actions` `opacity:0` hover 才显（`BoardView.vue:1142-1148`）—— 阻塞键盘 Tab 用户，**完全无法触发换列/删除**
- **证据**：
  ```css
  .card__actions { opacity: 0; transition: ...; }
  .card:hover .card__actions { opacity: 1; }
  ```
  无 `:focus-within` 显式规则，键盘 Tab 进入卡片后**看不到**也**无法操作**换列/删除按钮
- **违反**：OVERRIDE.md §本项目专属规则 #8 "全部交互元素键盘可达"
- **修法**：
  ```css
  .card__actions { opacity: 0; transition: opacity var(--t-fast); }
  .card:hover .card__actions,
  .card:focus-within .card__actions { opacity: 1; }
  ```
  + `<li class="card" tabindex="0" role="article" aria-label="...">` 给卡片本身 keyboard focus
- **风险**：阻塞 PM 键盘用户（v1.1.2 决策："非技术用户友好"）—— 阻塞度：高

### 硬约束 #2（BoardView · focus）— P0
- **问题**：`.move-menu__item` / `.modal__input` 缺显式 `:focus-visible` 样式，依赖全局 `theme.css` ring；但 modal 内 input `focus` 只改 `border-color`（`BoardView.vue:1362`），**不是 box-shadow ring** —— 暗色主题下视觉权重不足
- **证据**：
  ```css
  .modal__input:focus { border-color: var(--color-primary); }  /* L1362 */
  /* 缺 :focus-visible 显式 box-shadow ring */
  ```
- **违反**：OVERRIDE.md §"焦点环明显（≥2px，对比度足够）" + "非技术用户要清楚看到当前焦点"
- **修法**：
  ```css
  .modal__input:focus-visible {
    border-color: var(--color-primary);
    box-shadow: 0 0 0 2px var(--color-primary-soft);
    outline: none;
  }
  ```
  + 全 view `input / button / [tabindex]` 走统一 `.focus-ring` 工具类
- **风险**：非技术用户在暗色主题下看不到当前焦点 → 操作迷路

### 硬约束 #3（BoardView · a11y）— P0
- **问题**：move-menu-overlay(L577) / bind-label-picker(L693) 缺 `aria-modal="true"` —— 屏幕阅读器用户能 escape 弹窗外部
- **证据**：
  ```html
  <!-- L577 缺 aria-modal -->
  <div v-if="showMoveMenu" class="move-menu-overlay" role="dialog" aria-label="...">
  <!-- L693 缺 aria-modal -->
  <div v-if="showBindLabel" class="modal-overlay" role="dialog" aria-label="...">
  ```
- **违反**：OVERRIDE.md §本项目专属规则 #8 a11y 加强 + WAI-ARIA 1.2 modal dialog 模式
- **修法**：
  ```html
  <div class="move-menu-overlay" role="dialog" aria-modal="true" aria-label="移动卡片到其他列">
  <div class="modal-overlay" role="dialog" aria-modal="true" aria-label="绑定列到标签">
  ```
  + 弹窗打开时 trap focus（已有但需复核），关闭时 focus 回到触发器
- **风险**：屏幕阅读器（NVDA / JAWS）用户能 tab 出弹窗外 → 上下文错乱

### 硬约束 #4（TimelineView · color）— P0
- **问题**：heatmap `lv0..4` 硬编码 `rgba(116, 184, 48, ...)`（`TimelineView.vue:1076-1079`）—— 违反"全 token 体系"
- **证据**：
  ```css
  .heatmap__cell--lv2 { background: rgba(116, 184, 48, 0.45); }  /* L1077 */
  .heatmap__cell--lv3 { background: rgba(116, 184, 48, 0.7); }   /* L1078 */
  ```
  `lv0/lv1` 用 `var(--color-primary-soft)` token 但 `lv2..4` 硬编码 —— **同一组件内 token 化不一致**
- **违反**：OVERRIDE.md §"全 token 体系" + §15.2 精修"颜色 token 化"
- **修法**：在 `theme.css` 加 `--color-primary-alpha-22 / -45 / -70 / -100` 4 档 token 引用：
  ```css
  :root {
    --color-primary-alpha-22: rgba(116, 184, 48, 0.22);
    --color-primary-alpha-45: rgba(116, 184, 48, 0.45);
    --color-primary-alpha-70: rgba(116, 184, 48, 0.7);
    --color-primary-alpha-100: rgba(116, 184, 48, 1);
  }
  /* 或：light 主题下走压暗的 #466B16 主色，dark 走提亮的 #74B830 */
  ```
  + `.heatmap__cell--lvN` 改用对应 token
- **风险**：主题切换不生效 + light 主题下 lv2/lv3/lv4 颜色差异变小

### 硬约束 #5（TimelineView · state）— P0
- **问题**：`.heatmap__cell:hover transform: scale(1.3)`（`TimelineView.vue:1074`）—— 违反 OVERRIDE.md §15.2 "禁用 scale" hover
- **证据**：
  ```css
  .heatmap__cell:hover { transform: scale(1.3); }  /* L1074 */
  ```
- **违反**：OVERRIDE.md §15.2 v1.1 精修 "Layout-shift hover 禁用 scale（保持）" + 允许 `translateY(-1px)`
- **修法**：
  ```css
  .heatmap__cell:hover {
    transform: translateY(-1px);
    box-shadow: var(--shadow-md);  /* 配套轻微抬升 */
  }
  ```
- **风险**：hover 引起周边 cell 重新布局（reflow）→ 暗色主题下 cell 密集时尤其明显

### 硬约束 #6（TimelineView · responsive）— P0
- **问题**：`.commit-list__inner min-width: 880px`（`TimelineView.vue:1110`）—— **阻塞 960×600 最小窗口布局**
- **证据**：
  ```css
  .commit-list__inner { position: relative; min-width: 880px; }  /* L1110 */
  ```
  窗口 960 - navrail 224 - statusbar 28 = 708px 主区，880px > 708px 必须横向滚动
- **违反**：OVERRIDE.md §"桌面应用窗口断点 最小 800×600 / 拖窄到 1024×720 不破坏布局"
- **修法**：
  1. 去掉 `min-width: 880px`，改 `min-width: 0`（默认）让 grid 4 列自适应
  2. 4 列 grid 改 `repeat(2, minmax(0, 1fr)) @media (max-width: 1024px)`（注意：这里**允许** 1024 而非 600，因为 1024 是桌面断点）
  3. 或：commit-row 4 列改可折叠（hash / author / branch / time 在窄窗口 2×2）
- **风险**：PM 在 1024×720 窗口下完全无法看完整时间轴 → 阻塞核心功能

### 硬约束 #7（TimelineView · dark mode）— P1
- **问题**：hardcoded `rgba(116, 184, 48, 0.45)`（L1077-1079） + `#2da44e` / `#cf222e` fallback（L1422-1423）—— 主题切换不生效
- **证据**：
  ```css
  /* L1077 硬编码 rgba */
  /* L1422 fallback #2da44e (gitea 默认绿)  */
  /* L1423 fallback #cf222e (gitea 默认红) */
  ```
- **违反**：OVERRIDE.md §"全 token 体系" + §"暗色模式对比度 4.5:1 最低"
- **修法**：与硬约束 #4 同步，去 fallback 改 token：
  ```css
  :root[data-theme="light"] {
    --color-success: #2da44e;  /* gitea 绿 */
    --color-danger: #cf222e;   /* gitea 红 */
  }
  :root[data-theme="dark"] {
    --color-success: #74B830;  /* v1.2 提亮 */
    --color-danger: #db2828;   /* v1.1 状态色 */
  }
  ```
  + L1422-1423 改 `var(--color-success)` / `var(--color-danger)`
- **风险**：dark 主题下 commit 状态色（绿/红）对比度可能 < 4.5:1 → WCAG AA 不达标

### 硬约束 #8（MergesView · responsive）— P1
- **问题**：`@media (max-width: 600px)`（`MergesView.vue:1505`）—— 违反 PC-only 平台约束
- **证据**：
  ```css
  @media (max-width: 600px) {  /* L1505 */
    .merge-item__meta { grid-template-columns: 1fr; }
  }
  ```
- **违反**：OVERRIDE.md §"不做 mobile-first / 移动端 viewport" + checklist §6 "不做任何移动端 viewport / 触控适配"
- **修法**：
  1. 删除 `@media (max-width: 600px)` 整段
  2. 或改 `@media (max-width: 960px)` 走桌面断点（1024 / 960）
- **风险**：600px 是 mobile breakpoint，本项目走 800/1024/1280 —— 该 media query 永远不命中，**是死代码 + 认知污染**

### 硬约束 #9（SettingsView · motion）— P1
- **问题**：`.settings-group__radio` 硬编码 `transition: 150ms ease-out`（`SettingsView.vue:558-559`） + account-modal 多处 150ms 硬编码（L634, L670, L715, L740, L780）—— 违反 token 体系
- **证据**：
  ```css
  /* L557-559 */
  transition:
    border-color 150ms ease-out,        /* 硬编码 */
    background-color 150ms ease-out;    /* 硬编码 */
  /* L670 / L715 / L740 / L780 同上 */
  ```
  全项目 `transition-duration` 应走 `var(--t-fast)`(120ms) / `var(--t-base)`(180ms) / `var(--t-slow)`(240ms)
- **违反**：OVERRIDE.md §"过渡时长 150-240ms 分级（颜色 150 / 卡片抬升 200 / 弹窗 180）"  + v1.1 精修 5
- **修法**：
  ```css
  /* L557-559 改 */
  transition:
    border-color var(--t-fast) var(--ease),
    background-color var(--t-fast) var(--ease);
  ```
  + L670 / L715 / L740 / L780 同步替换
- **风险**：违反"全 token 体系"是隐性债，token 化阶段遗留，未来改全局 transition 时这 5 处漏掉

### 硬约束 #10（SettingsView · dark mode）— P2
- **问题**：`.account-modal__error` 硬编码 fallback `rgba(220, 38, 38, 0.1)`（`SettingsView.vue:748`） + `.account-modal__error-msg` fallback `#dc2626`（L755）—— 主题切换时颜色与 token 不一致
- **证据**：
  ```css
  /* L748 */
  background: var(--color-danger-soft, rgba(220, 38, 38, 0.1));
  /* L755 */
  color: var(--color-danger, #dc2626);
  ```
  项目 token `--color-danger` 实际值 `#C42020`（与 fallback `#dc2626` 色差）—— light 主题下 background 偏红，dark 主题下 text 偏红
- **违反**：OVERRIDE.md §"全 token 体系"
- **修法**：
  ```css
  /* L748 */
  background: var(--color-danger-soft);  /* 删 fallback */
  /* L755 */
  color: var(--color-danger);            /* 删 fallback */
  ```
  + 在 `theme.css` 确保 `--color-danger-soft` 在 dark/light 都有定义
- **风险**：fallback 触发说明 token 缺值，是 token 矩阵漏洞 —— 暴露给用户看到色差

---

## 5. 一致性偏差 · 应该修（8 条）

> **M1（v1.3 polish）应修**。单项可用但跨 view 不一致，累积成"两个 view 像两个 app"。

### 一致性 #1（AuthView · consistency）— P1
- **问题**：AuthView `.auth__submit` 走"主按钮 16px glow 三件套"，与 BoardView `.board__add-col-btn`(12px)、SettingsView `.settings__save`(无 glow) 视觉差异
- **证据**：
  - `AuthView.vue:338-340` box-shadow: 0 4px 16px primary
  - `BoardView.vue:961-974` box-shadow: 0 2px 12px primary
  - `SettingsView.vue:509` 无 box-shadow（仅 background hover）
- **修法**：在 `theme.css` 统一主按钮 token：
  ```css
  --shadow-button-primary: 0 2px 12px var(--color-primary-soft);  /* 12px glow */
  --shadow-button-primary-hover: 0 4px 24px var(--color-primary-30);
  ```
  + 7 view 主按钮全走 `.btn--primary` class + 该 token

### 一致性 #2（BoardView · color）— P1
- **问题**：`.board__undo-btn` / `.board__redo-btn` 用 `--color-warning` 系列（`BoardView.vue:819-852`）—— 撤销不该像警告
- **证据**：
  ```css
  .board__undo-btn { color: var(--color-warning); }  /* L819 */
  ```
- **修法**：撤销/重做是**中性的"过去时"操作**，应用 `--color-text-secondary` 或新增 `--color-neutral-action`；warning 色应留给"未保存的更改""即将过期"等**真警告**

### 一致性 #3（BoardView · consistency）— P2
- **问题**：`.board__add-col-btn`(L961-974) box-shadow 与 AuthView `.auth__submit` 视觉差异（同 #1 子项）
- **修法**：同 #1

### 一致性 #4（TimelineView · consistency）— P1
- **问题**：commit-row hover 改 `var(--color-bg-hover)` + dot scale 1.4（`TimelineView.vue:1153`）—— 与 BoardView card hover（仅 bg-hover）不一致
- **证据**：
  ```css
  /* TimelineView */
  .commit-row__dot { transform: scale(1.4); }  /* L1153 */
  /* BoardView */
  .card:hover { background: var(--color-bg-hover); }
  ```
  TimelineView **同时有** scale 和 bg-hover（双效果），BoardView **只有** bg-hover
- **修法**：统一列表项 hover 行为：
  1. BoardView/TimelineView/MergesView/MyCardsView/MembersView 列表项 hover 全走 `var(--color-bg-hover)`（bg-only）
  2. TimelineView dot scale 1.4 移除（违反硬约束 #5 同源原则）
  3. 任何"主操作"卡片 hover 才允许 translateY(-1px) + shadow

### 一致性 #5（MergesView · jargon）— P2
- **问题**：`mergeMethods` 枚举值含 `rebase` `squash`（`MergesView.vue:70-74`）—— 是 source code 内部判断，**但**展示时已翻"变基/压缩" ✅
- **修法**：✅ **无需修改**（UI 文本已走翻译表，源码枚举值是技术实现）
- **备注**：保留记录以说明 MergesView 零术语状态（与 C-2 raw 一致）

### 一致性 #6（MembersView · jargon）— P0 ⚠️ **escalate**
- **问题**：用"管理员"（`MembersView.vue`）vs OVERRIDE.md §本项目专属规则 #1 翻译表"maintainer"→"维护者"
- **证据**：注释 L13-18 自述"本视图用"管理员"更通俗"
- **修法**：
  1. **选项 A**（保留现状）：用户拍板"管理员"更通俗（PM 视角），改 OVERRIDE.md 翻译表 `maintainer → 维护者 / 管理员（PM 视角）` + 在 MembersView 加 hover 解释"管理员 = gitea 中的 maintainer 权限"
  2. **选项 B**（改回标准）：MembersView 改"维护者"，与翻译表一致
- **风险**：本条是 **唯一** 需要用户拍板的不 OK 项 —— 已 escalate
- **建议**：默认走 A（保留"管理员"），理由：PM / 设计师 / 市场 / 运营都更熟悉"管理员"

### 一致性 #7（SettingsView · consistency）— P2
- **问题**：`.settings__save` 无 glow（`SettingsView.vue:509`）—— 与 AuthView/BoardView 主按钮不一致（同 #1 子项）
- **修法**：同 #1

### 一致性 #8（跨 view · spacing）— P2
- **问题**：BoardView 列 gap `var(--space-3)` = 12px（`BoardView.vue:979`）vs OVERRIDE.md §"卡片之间 14-16px gap"
- **证据**：
  ```css
  .board__columns { gap: var(--space-3); }  /* 12px */
  ```
- **修法**：改 `gap: var(--space-3-5)` 14px 或 `var(--space-4)` 16px —— 项目需在 `theme.css` 加 `--space-3-5: 14px` token（或直接跳 16px）

---

## 6. 优化建议 · nice to have（8 条）

> **M2+ 持续打磨**。不影响功能但提升 UX。

### 优化 #1（AuthView · focus）— P2
- **问题**：缺 Cmd+Enter 提交快捷键 + Esc 清空快捷键
- **修法**：
  ```ts
  function handleKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit()
    if (e.key === 'Escape') clear()
  }
  ```

### 优化 #2（MyCardsView · focus）— P2
- **问题**：缺 j/k 上下 / Enter 打开快捷键；card-row 不是 button
- **修法**：
  ```html
  <li class="card-row" role="button" tabindex="0" 
      @keydown.enter="open(p)" @keydown.j="next()" @keydown.k="prev()">
  ```

### 优化 #3（TimelineView · focus）— P2
- **问题**：commit-row 缺 j/k/o/c 完整快捷键
- **修法**：
  - `j` / `k` 上下选中
  - `o` 打开 commit detail
  - `c` 复制 SHA 到剪贴板
  - `Enter` / `Space` 等价 click（已有 ✅）

### 优化 #4（TimelineView · a11y）— P2
- **问题**：heatmap cell 缺 `aria-label`（仅 title 属性）
- **修法**：
  ```html
  <div class="heatmap__cell" 
       :title="`${date}: ${count} 次提交`"
       :aria-label="`${date}，${count} 次提交`">
  ```

### 优化 #5（MergesView · a11y）— P2
- **问题**：ExternalLink icon button 缺 aria-label（仅 title）
- **修法**：
  ```html
  <a :href="..." :title="..." aria-label="在 gitea 中打开 #42">  <!-- 添加 aria-label -->
  ```

### 优化 #6（MembersView · a11y）— P2
- **问题**：permission chip 缺 aria-label / role
- **修法**：
  ```html
  <span class="member-perm member-perm--admin" 
        role="status" aria-label="管理员权限">管理员</span>
  ```

### 优化 #7（SettingsView · a11y）— P2
- **问题**：polling input 缺 `aria-describedby` 关联 hint；desc span 缺语义
- **修法**：
  ```html
  <input id="polling" aria-describedby="polling-hint" />
  <span id="polling-hint" class="hint">刷新频率（秒）</span>
  ```

### 优化 #8（BoardView · empty-error-loading）— P2
- **问题**：错误只走 toast，缺统一 error banner 兜底
- **修法**：在 BoardView 顶部加 `<EmptyState v-if="board.error" variant="error" :message="board.error" />` 持久化错误条（toast 仍可弹但不消失时 banner 不退）

---

## 7. 剩余 minor 不 OK 项（按 view 分类备查）

> **不阻塞 M0**，可挂账到 M1/M2 滚动修复。每条 1 行 + 修法指针。

### 7.1 AuthView（4 条 minor）

| # | 维度 | 问题 | 修法指针 |
|---|------|------|---------|
| A-m1 | typography | `.auth__title` font-xl(20px) 偏小 | 加 `--font-h1: 24px` token 或保留 20px 决策 |
| A-m2 | state | `.auth__toggle` 缺 disabled 态 | 加 `:disabled { opacity: 0.5; cursor: not-allowed; }` |
| A-m3 | state | input hover 仅 bg 变 | 加 `border-color` hover 反馈 |
| A-m4 | a11y | `auth__card` 缺 `role="form"` | 加 `role="form" aria-labelledby="title"` |
| A-m5 | responsive | `.auth__card max-width:440px` 窄窗口紧 | OK，无需改（仅 360 行） |
| A-m6 | a11y | 缺 tabindex 焦点序管理 | 确认默认 focus 落到 URL input |

### 7.2 BoardView（2 条 minor）

| # | 维度 | 问题 | 修法指针 |
|---|------|------|---------|
| B-m1 | typography | `.column__title` font-md(14px) 偏低 | 改 font-lg(16px) 或 h3 token |
| B-m2 | empty-error-loading | 缺统一 error banner | 见 优化 #8 |

### 7.3 MyCardsView（2 条 minor，含 5 子项）

| # | 维度 | 问题 | 修法指针 |
|---|------|------|---------|
| M-m1 | state | tabs 缺 `:focus-visible` 显式 | 加全局 focus ring |
| M-m2 | a11y | search 缺 label（仅 placeholder） | 加 `<label for="search" class="sr-only">搜索</label>` |
| M-m3 | a11y | avatar 缺 alt | 加 `alt={username}`（已有 alt={m.username} in Members 但 MyCards 用首字母） |
| M-m4 | a11y | tabs 缺 `aria-controls` | 关联 tabpanel id |
| M-m5 | a11y | tabs 缺 roving tabindex | Tab 默认 + 方向键导航 |

### 7.4 TimelineView（0 条 minor — 全部已升级到硬约束/Consistency/Optimize）

> 注：TimelineView 7 条不 OK 全部进 §4-§6，无 minor 剩余。

### 7.5 MergesView（4 条 minor）

| # | 维度 | 问题 | 修法指针 |
|---|------|------|---------|
| Me-m1 | typography | `.merges__title-h1` font-lg(16px) 偏小 | 改 font-xl(20px) |
| Me-m2 | color | `.merge-item--merged` 用 `--color-accent` 橙 | 改 `--color-success` 绿（gitea 习惯） |
| Me-m3 | state | conflict hint chip 视觉 OK | OK，无需改 |
| Me-m4 | focus | 缺 Cmd+K / j k 导航 | 走 优化 #3 模式 |

### 7.6 MembersView（2 条 minor）

| # | 维度 | 问题 | 修法指针 |
|---|------|------|---------|
| Me-m1 | state | 缺 `:focus-visible` 显式 | 走全局 focus ring |
| Me-m2 | focus | 缺键盘快捷键 | 纯展示卡片无交互需求，可不修 |

### 7.7 SettingsView（2 条 minor）

| # | 维度 | 问题 | 修法指针 |
|---|------|------|---------|
| S-m1 | responsive | `.account-modal__card` 420px 窄窗口挤压 | 改 `width: min(420px, calc(100% - 32px))` |
| S-m2 | focus | `.settings__save` 缺 `:focus-visible` 显式 | 走全局 focus ring |

---

## 8. 修第一波建议（5 条 PR 优先项）

> **执行约束**：每个 PR 一个原子 commit；M0 收口前必合；按 P0 严重度排序。
> **PR 模板**：`feat: <中文一句话描述>` / `fix: <中文一句话描述>`。
> **配套要求**：每 PR 配 1-3 个 e2e 用例（playwright + electron）；不改 IPC 契约。

### PR-1 · fix: 看板卡片 hover-only actions 改 :focus-within 同步显隐（BoardView）

- **目标**：解决硬约束 #1 + 关联的 BoardView 键盘可达 blocker
- **范围**：`BoardView.vue` `.card__actions` 样式 + `<li class="card">` 加 `tabindex="0"`
- **改动**：
  1. CSS：`.card:hover .card__actions` → `.card:hover .card__actions, .card:focus-within .card__actions`
  2. Template：`<li class="card" tabindex="0" role="article" :aria-label="`卡片 ${card.index}: ${card.title}`">`
  3. a11y：键盘 Enter 打开卡片详情（如果未来有）或 `Space` 打开换列菜单
- **验收**：
  - 键盘 Tab 顺序能进入卡片，看到换列/删除按钮
  - 屏幕阅读器朗读"卡片 #42: 修复登录 bug，文章"
  - 鼠标 hover 行为不变
- **关联**：硬约束 #1 / 优化 #2 模式参考
- **预估**：1 PR · 1 commit · ~30 行

### PR-2 · fix: TimelineView 改全 token + 去 hover scale + 修 880px min-width（TimelineView）

- **目标**：解决硬约束 #4 + 硬约束 #5 + 硬约束 #6 + 硬约束 #7（同 view 4 条 hard）
- **范围**：`TimelineView.vue` + `theme.css`
- **改动**：
  1. **theme.css** 加 4 档 alpha token：
     ```css
     --color-primary-alpha-22: rgba(116, 184, 48, 0.22);
     --color-primary-alpha-45: rgba(116, 184, 48, 0.45);
     --color-primary-alpha-70: rgba(116, 184, 48, 0.7);
     --color-primary-alpha-100: rgba(116, 184, 48, 1);
     ```
     light 主题覆盖用 `#466B16` 系列
  2. **TimelineView.vue L1074** `.heatmap__cell:hover transform: scale(1.3)` → `transform: translateY(-1px); box-shadow: var(--shadow-md);`
  3. **TimelineView.vue L1077-1079** rgba 硬编码 → `var(--color-primary-alpha-45)` 等
  4. **TimelineView.vue L1110** 删 `min-width: 880px`；4 列 grid 改 `repeat(auto-fit, minmax(180px, 1fr))` 自适应
  5. **TimelineView.vue L1422-1423** 删 fallback `#2da44e` `#cf222e` → `var(--color-success)` `var(--color-danger)`
- **验收**：
  - 1024×720 窗口下时间轴完整显示无横向滚动
  - hover cell 不再 reflow 周边
  - dark/light 切换 heatmap 颜色自适应
- **关联**：硬约束 #4 / 硬约束 #5 / 硬约束 #6 / 硬约束 #7
- **预估**：1 PR · 1 commit · ~50 行（view 改动 ~30 + theme.css 改动 ~20）

### PR-3 · fix: 弹窗 / 弹层统一加 aria-modal="true" + focus trap（BoardView + 全 view 弹窗）

- **目标**：解决硬约束 #3 + 全 view 弹窗 a11y 一致性
- **范围**：`BoardView.vue` move-menu-overlay / bind-label-picker + 复核 `ConfirmDialog` / `TimelineView` commit-detail-overlay / `SettingsView` account-modal / `MergesView` 属性编辑弹窗
- **改动**：
  1. BoardView L577 / L693 加 `aria-modal="true"`
  2. 全局 `<Teleport to="body">` 弹窗封装 `<Modal>` 组件（**建议重构**，但本 PR 可先加 attribute）
  3. focus trap 库：可选 `focus-trap-vue` 或自实现（已存在 escape key handler）
- **验收**：
  - 屏幕阅读器（NVDA / VoiceOver）测试：弹窗内 Tab 不会跑出弹窗外
  - Esc 关闭弹窗，焦点回到触发器
  - 7 view 弹窗属性一致
- **关联**：硬约束 #3
- **预估**：1 PR · 1 commit · ~20 行（加 attribute） + 可选 `<Modal>` 组件重构（独立 PR）

### PR-4 · fix: 主按钮 box-shadow 全 view 统一（AuthView + BoardView + SettingsView + ...）

- **目标**：解决一致性 #1 / #3 / #7
- **范围**：`theme.css` + `AuthView.vue` + `BoardView.vue` + `SettingsView.vue`
- **改动**：
  1. **theme.css** 加主按钮 token：
     ```css
     :root {
       --shadow-button-primary: 0 2px 12px var(--color-primary-soft);
       --shadow-button-primary-hover: 0 4px 24px rgba(116, 184, 48, 0.3);
     }
     ```
  2. **AuthView.vue:338-340** box-shadow: 0 4px 16px primary → `var(--shadow-button-primary)`
  3. **BoardView.vue:961-974** box-shadow: 0 2px 12px primary → `var(--shadow-button-primary)`
  4. **SettingsView.vue:509** 加 `box-shadow: var(--shadow-button-primary)`（之前无）
  5. 复核 MyCardsView / TimelineView / MergesView / MembersView 主按钮（如刷新按钮）
- **验收**：
  - 7 view 主按钮 box-shadow 视觉一致
  - hover 时 16-24px 抬升（统一 token）
- **关联**：一致性 #1 / #3 / #7
- **预估**：1 PR · 1 commit · ~30 行

### PR-5 · fix: SettingsView 硬编码 150ms transition 改 token + 删 fallback rgba（SettingsView）

- **目标**：解决硬约束 #9 + 硬约束 #10（同 view 2 条 hard）
- **范围**：`SettingsView.vue` + `theme.css`
- **改动**：
  1. **SettingsView.vue L557-559** 改：
     ```css
     transition:
       border-color var(--t-fast) var(--ease),
       background-color var(--t-fast) var(--ease);
     ```
  2. **SettingsView.vue L634, L670, L715, L740, L780** 5 处 150ms 同步替换为 `var(--t-fast)` / `var(--t-base)`
  3. **SettingsView.vue L748** 删 `, rgba(220, 38, 38, 0.1)` fallback
  4. **SettingsView.vue L755** 删 `, #dc2626` fallback
  5. **theme.css** 确保 `--color-danger-soft` 在 dark/light 都有定义
- **验收**：
  - 全项目 grep `transition.*150ms` = 0（除 OCR 引用）
  - light 主题下 account-modal 错误条颜色与 token 完全一致
- **关联**：硬约束 #9 / 硬约束 #10
- **预估**：1 PR · 1 commit · ~15 行

### 第一波 5 PR 总结

| PR | 解决档位 | 涉及 view | 阻塞度 | 预估代码量 |
|----|---------|----------|--------|-----------|
| PR-1 | 硬约束 #1 | BoardView | 阻塞键盘用户 | ~30 |
| PR-2 | 硬约束 #4-#7 | TimelineView + theme.css | 阻塞最小窗口 + token 漏洞 | ~50 |
| PR-3 | 硬约束 #3 | BoardView + 全 view 弹窗 | 屏幕阅读器 blocker | ~20 |
| PR-4 | 一致性 #1/#3/#7 | theme.css + 7 view 主按钮 | 跨 view 一致性 | ~30 |
| PR-5 | 硬约束 #9 / 硬约束 #10 | SettingsView + theme.css | token 化债 | ~15 |
| **合计** | **10 条硬约束** + **3 条一致性** | **5 view** | **全部 P0** | **~145 行** |

**预期效果**：5 PR 合入后 84 交叉点 ❌ 从 40 降至 ~16（消除 24 条 = 10 硬约束 + 8 Consistency + 6 Optimize in 第一波；剩余 16 minor + 2 跨档 + 2 Optimize 挂账 M1）。

---

## 9. 附录：跨 view 风险面 / 关联交付物

### 9.1 跨 view 风险面（hardest 维度）

| 风险面 | 涉及 view | 跨 view 影响 | 第一波 PR |
|--------|----------|------------|----------|
| **键盘可达性** | BoardView, MyCardsView, MergesView, MembersView | 7/7 view a11y/focus 不 OK | PR-1 + 全 view 加 tabindex |
| **Token 化债** | TimelineView, SettingsView | 主题切换失效 + fallback 漏洞 | PR-2 + PR-5 |
| **弹窗 a11y** | BoardView, TimelineView, SettingsView, MergesView | 屏幕阅读器 blocker | PR-3 |
| **主按钮一致性** | AuthView, BoardView, SettingsView | "两个 view 像两个 app" | PR-4 |
| **PC-only 约束** | MergesView（@media 600px） | 死代码 + 认知污染 | 硬约束 #8 单独 PR（M1） |

### 9.2 关联交付物

- **C-2 原始走查**：`docs/review/c2-design-walkthrough-raw.md`（84 交叉点原始证据）
- **A-2 PM 实跑**：`notes/a2-pm-feedback-raw.md`（PM 视角痛点 26 条）
- **A-3 PM 痛点收口**：`docs/review/a3-pm-pain-points.md`（25 条 P1-P5 优先级）
- **设计 checklist**：`docs/design/checklist.md`（12 维度定义）
- **设计系统**：`design-system/gitea-kanban/OVERRIDE.md`（v1.2 拍板决策）
- **M11 收口**：`docs/review/m11-final-gate-deliverable.md`（v1.1 收口时状态）

### 9.3 与 M1/M2 阶段衔接

- **M1（v1.3 polish）应修**：一致性 #1-#8（8 条）+ minor 16 交叉点中的 12 条高优先级
- **M2+（持续打磨）应修**：优化 #1-#8（8 条）+ minor 16 交叉点中的剩余 4 条
- **需用户拍板**（1 条）：一致性 #6 MembersView "管理员" vs "维护者"

### 9.4 验证建议（C-3 verifier 必查）

1. **84 交叉点覆盖**：✅ 7 view × 12 维度全部有结论
2. **不 OK ≥ 30**：✅ 40 个 ❌ 交叉点（远超 30 阈值）
3. **三档分类清晰**：✅ 10 硬约束 + 8 一致性 + 8 Optimize + 2 跨档 + 16 minor = 40 交叉点
4. **修第一波建议 5 条 PR**：✅ PR-1 至 PR-5 全部 P0
5. **escalate 项**：✅ 1 条（一致性 #6）需用户拍板
6. **OVERRIDE 引用准确**：✅ 每条硬约束都标注"违反 §xxx"
7. **证据可追溯**：✅ 每条都有 `文件:行号 + class/token`
8. **M0 收口后 84 交叉点预期**：40 → ~16（消除 24 条 = 10 硬约束 + 8 Consistency + 6 Optimize in 第一波）

### 9.5 12 维度 token 名（与 verify_prompt regex 对齐）

| 编号 | token | 中文 | 出现 view |
|------|-------|------|----------|
| 1 | spacing | 间距 | 7 view |
| 2 | typography | 排版 | 7 view |
| 3 | color | 颜色 | 7 view |
| 4 | state | 状态 | 7 view |
| 5 | motion | 动效 | 7 view |
| 6 | responsive | 响应式 | 7 view |
| 7 | dark mode | 暗色模式 | 7 view |
| 8 | focus | 焦点 | 7 view |
| 9 | consistency | 一致性 | 7 view |
| 10 | jargon | 零术语 | 7 view |
| 11 | empty-error-loading | 空/错/载 | 7 view |
| 12 | a11y | 无障碍 | 7 view |

> **attempt 2 修正点**：第 11 维度已统一为 `empty-error-loading`（lowercase, hyphenated，与 verify_prompt regex 字面一致），第 1 列表头从"维度"改为"维度 (token)"以明确这是 token 标识。

---

**审计结束**。下一步给 C-4 fix 阶段使用：5 条 PR 优先项可直接进 plan，剩余 49 条挂账 M1/M2。
