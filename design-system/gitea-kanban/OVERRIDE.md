# Gitea Kanban — Design System Override

> 本文件**覆盖** `MASTER.md` 的全局规则。本项目有明确的产品定位，MASTER 的默认
> 推荐（Vibrant & Block-based / #22C55E 鲜绿 / Fira Code+Sans / startup 风格）不能直接套用。

## 适用范围

- 项目：`gitea-kanban`
- 形态：Electron 桌面应用（不是 SaaS Web 也不是 startup landing）
- 用户：gitea 用户群，含**开发者** + **非技术人员**（PM / 设计师 / 市场 / 运营）
- 风格定位：**贴 gitea 风格**（让用户感到这是 gitea 的延伸而不是第三方小工具），
  **稳健 / 信息密度合适 / 非技术用户友好**

## 覆盖决策（采纳 / 拒绝）

| 维度 | MASTER 推荐 | 本项目决定 | 理由 |
|------|------------|----------|------|
| 主色 | `#22C55E` 鲜绿 | **gitea 绿 `#609926`** | 贴 gitea 生态，可识别度强 |
| 强调色 | （无） | **gitea 橙 `#f76707`** | 贴 gitea 生态，用于警示/重操作 |
| 背景 | `#0F172A` 深色 | **默认浅色 + 暗色模式可切换** | 桌面应用默认浅色更稳健；暗色模式给开发者 |
| 风格 | Vibrant & Block-based（块状/大色块/活泼） | **克制 / 信息密度优先** | 非技术用户要"看得懂"，大色块/活泼风容易显得不专业 |
| Pattern | Feature-Rich Showcase（Hero > Features > CTA） | **不适用**（这不是 landing） | 我们是工具型应用，没有 marketing 页面 |
| 标题字体 | Fira Code | **Inter** 或系统默认 sans | 桌面应用要中英文混排，Fira Code 中文不行 |
| 正文字体 | Fira Sans | **Inter** 或系统默认 sans | 同上 |
| 图标 | SVG（Heroicons/Lucide） | **✅ 采纳** | 跟 MASTER 一致，专业规则 |
| `cursor-pointer` | 必须 | **✅ 采纳** | 跟 MASTER 一致 |
| Hover 反馈 | 150-300ms 平滑 | **✅ 采纳** | 跟 MASTER 一致 |
| 暗色模式对比度 | 4.5:1 最低 | **✅ 采纳** | 跟 MASTER 一致 |
| Focus 状态 | 可见 | **✅ 采纳且加强** | 非技术用户要清楚看到当前焦点 |
| `prefers-reduced-motion` | 尊重 | **✅ 采纳** | 跟 MASTER 一致 |
| 响应式断点 | 375/768/1024/1440 | **桌面应用窗口断点**：最小 800×600、推荐 1280×800、可拖拽至 4K | 桌面窗口不是 mobile-first |
| 无 emoji 图标 | 必须 | **✅ 采纳** | 跟 MASTER 一致 |

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
   - 窗口可缩放、最小尺寸 800×600、暗色模式跟系统

5. **a11y 加强**（非技术用户友好）
   - 全部交互元素键盘可达（Tab 顺序符合阅读顺序）
   - 关键操作（合并、删除）除了二次确认还要声音/震动反馈
   - 颜色不是唯一信号（用图标 + 文字 + 颜色三重编码状态）

## Skill 来源声明

本项目的 UI/UX 决策参考了：
- `.codex/skills/ui-ux-pro-max/SKILL.md` — 全套设计系统 + UX 规则（取其通用专业规则）
- gitea 官方 UI 色板（#609926 / #f76707）—— 项目生态一致性
- 用户明确决策（2026-06-10）：Electron + TS，对非技术用户友好

## 何时回看本文件

- 任何前端开发任务开工前 → 必读本 OVERRIDE
- 任何 UI 风格 / 配色 / 字体变更 → 必须先改本文件再改实现
- 任何术语翻译表变更 → 必须同步本文件
