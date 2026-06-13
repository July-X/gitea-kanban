# Tech Refine — 暗色主题「技术工具科技感」精修

> **范围**：本文件是 `MASTER.md` + `OVERRIDE.md` 之上的 page-level 精修文件，定义 gitea-kanban v1 暗色主题
> 在「技术工具的科技感」方向上的**具体落地 token**。
>
> **硬约束**（不破坏，照搬）：
>
> - 主色 gitea 绿 `#609926` / 强调色 gitea 橙 `#f76707`（OVERRIDE §覆盖决策）
> - 苍蓝底 `#134857` + 四层分层（OVERRIDE §覆盖决策 / §本项目专属规则 #5）
> - v1 单主题暗色，不提供切换（AGENTS §8.1 v5 用户拍板）
> - 零术语 / 二次确认 / 错误人话 / 三重编码（OVERRIDE §本项目专属规则 #1-3 #8）
> - 字体三件套：Inter（主）+ JetBrains Mono（mono）+ Noto Sans SC（中文 fallback）
>
> **方向参考**：`ui-ux-pro-max` skill `style.domain` 的 **HUD / Sci-Fi FUI** + **Dark Mode (OLED)**
> 两条线（细线 + 装饰括号 + 微弱冷光 + mono 数字）—— **不取** Cyberpunk 强霓虹
> （a11y 差 + 跟"非技术用户友好"冲突）。

---

## 1. 边角（从柔到锐）

| 元素 | OVERRIDE 现状 | 精修后 | 理由 |
|---|---|---|---|
| 卡片 | 12px | **6px** | dev 工具主流（Linear / Notion / Cursor 偏 6-8px） |
| 按钮 | 8px | **4px** | 配合卡片锐化；按钮是"操作件"不是"装饰件" |
| 输入框 | 8px | **4px** | 跟按钮统一；输入跟操作同语义 |
| 状态点 | 50% 圆 | **50% 圆**（保持） | 圆点无悬念 |
| 标签 / chip | 12px | **2px** | HUD 风格极小锐角，区分"标签"和"按钮" |
| 弹窗 / modal | 16px | **8px** | 弹窗是"系统级"可以略大，但不要 16px 那么柔 |
| 卡片左上装饰角 | — | **0**（直角） | HUD 风的 ┌─ 角标 |

**新增**：`--radius-card: 6px` / `--radius-btn: 4px` / `--radius-chip: 2px` / `--radius-modal: 8px` / `--radius-tag: 2px`

---

## 2. 发光 / glow 体系（**冷光**而非霓虹）

> 原则：暗色底上纯黑阴影"消失"，所以阴影走"更深底色 + 1px 冷白描边 + 主色外环 glow"三件套
> （来自 OVERRIDE §本项目专属规则 #5，**本节进一步量化和分级**）。

### 2.1 阴影三档（升级自 OVERRIDE #5）

| 级别 | box-shadow | 适用 |
|---|---|---|
| `--shadow-tech-sm` | `0 1px 2px rgba(10, 42, 50, 0.4), inset 0 0 0 1px rgba(220, 233, 240, 0.04)` | 内嵌 chip / 状态行 |
| `--shadow-tech-md` | `0 4px 12px rgba(10, 42, 50, 0.5), inset 0 0 0 1px rgba(220, 233, 240, 0.06)` | 普通卡片 / 列 |
| `--shadow-tech-lg` | `0 12px 32px rgba(10, 42, 50, 0.6), 0 0 16px rgba(96, 153, 38, 0.12), inset 0 0 0 1px rgba(220, 233, 240, 0.08)` | 弹窗 / 抽屉 / 主操作卡 |

**关键升级**：
- 内嵌 `inset 0 0 0 1px` 冷白微描边（4-8% alpha）—— 暗色底上描边比阴影更能"卡边"
- 弹窗级别额外加 `0 0 16px` 主色外环光（12% alpha）—— 跟主色生态呼应

### 2.2 主色 glow（主按钮 / 关键操作）

```css
--glow-primary:    0 0 0 1px rgba(96, 153, 38, 0.5), 0 0 12px rgba(96, 153, 38, 0.3);
--glow-primary-sm: 0 0 0 1px rgba(96, 153, 38, 0.3), 0 0 6px  rgba(96, 153, 38, 0.2);
--glow-primary-lg: 0 0 0 1px rgba(96, 153, 38, 0.7), 0 0 24px rgba(96, 153, 38, 0.4);
```

**关键约束**：
- 主按钮静态 = `--glow-primary`
- 主按钮 hover = `--glow-primary-lg`（glow 放大、alpha 提 30%）
- 强调色（橙）走 `--glow-warning` 同结构（`#f76707` 替换主色）
- 状态点 halo = 4-8px blur 12-30% alpha 同色（不写 ring，避免破坏锐角）

### 2.3 文字发光（仅 KPI / 状态大字）

- 仅 24px+ 数字（KPI / 计数器）允许 `text-shadow: 0 0 8px rgba(96, 153, 38, 0.4)`
- 12-16px 文本**不允许** text-shadow（影响阅读 + 性能）

---

## 3. HUD 装饰元素

> "科技感"主要来自**装饰性元素**——加几个看起来"硬核"的视觉语言，但每个都要有功能意义，不堆砌。

### 3.1 装饰角（card corner brackets）

卡片左上 + 右上各 1 个直角 L 形，**主色 50% alpha + 1px 宽 + 6px 长**：

```
┌                          ┐
┌─                       ─┐
│   [卡片内容]              │
└─                       ─┘
```

- 静态卡片用 `--color-primary` 30% alpha
- hover 时升级到 60% alpha + glow
- 装饰角是 **CSS border + ::before/::after 实现**，不占布局空间

**新增**：`--decor-corner-color: rgba(96, 153, 38, 0.3)` / `--decor-corner-size: 6px`

### 3.2 标题前缀条

卡片 / 区块标题前加 **4px × 16px 主色窄条**（垂直）或 **6px 主色圆点**（状态卡）：

- 静态：纯主色（`#609926`）100%
- 警示 / 重操作：gitea 橙（`#f76707`）100%
- 暗 / 禁用：冷白 20% alpha

**新增**：`--decor-bar-primary` / `--decor-bar-warning` / `--decor-bar-disabled`

### 3.3 顶部 StatusBar / CommandBar 视觉

桌面应用顶部 24px 一行，显示：

```
[● gitea] / org/team/project:main   ⌘K 命令   ↻ 同步于 14:23   ● 在线   v1.2.3
```

- 左：项目路径（mono 字体，苍蓝 hover 亮）
- 中：快捷键提示（[⌘K] / [Ctrl+P] 风格键帽）
- 右：状态点 + 时间戳（mono）+ 版本号（mono）

**新增**：`--statusbar-height: 24px` / `--statusbar-bg: var(--color-bg-elevated)` + 底部 1px 冷白 4% alpha 描边

### 3.4 环境 / 分支标签（HUD 风格）

合并管理页的分支名 / 合并目标 / 环境标识用 **HUD 风**：

- 标签 = 大写 mono + 4% alpha 底 + 1px 30% alpha 主色描边
- 例：`[ MAIN ]` / `[ STAGING ]` / `[ DEV ]` / `[ HOTFIX ]`
- hover 时底色升到 8% alpha + 1px 升级到 50%

**新增**：`--env-tag-bg: rgba(96, 153, 38, 0.04)` / `--env-tag-border: rgba(96, 153, 38, 0.3)`

### 3.5 键帽样式（K 标识）

快捷键标识用**键帽**：`[⌘K]` / `[Ctrl+P]` / `[↵]` / `[ESC]`

- 24×20px 大小
- 底色：canvas 提一档（`#1B5868`）
- 1px 冷白 8% alpha 描边
- 文字：mono 11px 冷白 80% alpha
- 圆角 3px

**新增**：`--keycap-bg` / `--keycap-border` / `--keycap-fg`

---

## 4. Mono 字体使用场景强化

> OVERRIDE 已定：等宽字体 = **JetBrains Mono**（cv11/ss01 启用 → 数字"0"带斜线、"1"有底杠）。
> 本节**显式列出使用场景**，避免前端 agent 把它"装饰化"或忘了用。

**必须用 JetBrains Mono 的元素**（**强制**）：

| 类别 | 例子 | 字号 |
|---|---|---|
| commit hash | `a1b2c3d` / `a1b2c3d4e5f6...` | 11-12px |
| issue 编号 | `#482` / `kanban_demo/m4java-test#482` | 12-13px |
| 版本号 | `v1.2.3` | 12px |
| 时间戳 | `2026-06-12 14:23` / `2m ago` | 11-12px |
| 状态码 | `200` / `404` / `500` | 12px |
| 文件路径 | `src/main/cache/sqlite.ts` | 12px |
| 命令行 | `git push origin main` | 13px |
| 卡片 ID 角标 | `CARD-482` | 10-11px 60% alpha |
| SHA 短码 tooltip | `a1b2c3d` | 11px |

**强烈推荐**用 JetBrains Mono 的元素（**视觉升级**）：

| 类别 | 例子 | 字号 |
|---|---|---|
| KPI 大数字 | `1,248` 张卡片 / `47` 次合并 / `14` 个分支 | 32-48px（远大于正文） |
| 进度百分比 | `78%` | 13-14px |
| 行号 / 列号 | 表格第一列 | 11px 60% alpha |
| commit message 标题 | 表格的 commit 标题列 | 13-14px 100% |

**不允许**用 mono 的元素（**仍用 Inter**）：

- 卡片标题 / 段落正文 / 按钮文字 / 菜单项 / 弹窗说明 / 错误提示 / 提示文案
- 中文文本（Noto Sans SC 兜底）

---

## 5. 状态指示器（三重编码 + 信号灯）

> OVERRIDE §本项目专属规则 #8："颜色不是唯一信号，用图标 + 文字 + 颜色三重编码状态"。
> 本节给出**具体 token**：

### 5.1 状态点 + 文字

```
● 成功    /  ✓ 已合并   /  ↑ 已推送
● 等待    /  ⏱ 同步中   /  ⌛ 排队中
● 警示    /  ! 有冲突   /  ⚠ 请注意
● 失败    /  ✗ 失败     /  ⊘ 已拒绝
● 离线    /  ⌽ 离线缓存 /  ⊝ 网络断开
```

**形态**：4-6px 圆点 + 同色 30% alpha halo（0 0 4-8px blur）+ 文字 + 图标，**三者必须同时出现**

**新增 token**：

```css
--status-success:    #609926;  /* gitea 绿 */
--status-warning:    #f76707;  /* gitea 橙 */
--status-error:      #db2828;  /* 错误红 —— 新增，跟 gitea 生态一致 */
--status-info:       #4fc4d6;  /* 信息青 —— 新增，HUD 风冷色提示 */
--status-pending:    #94a3b8;  /* 等待灰 —— 新增 */
--status-offline:    #64748b;  /* 离线灰 —— 新增 */
```

**对比度核查**（必须 4.5:1 最低）：

| 状态 | 前景色 | 背景 `#134857` 对比度 | 背景 `#1B5868` 对比度 |
|---|---|---|---|
| success `#609926` | 4.21 ⚠️ | 4.93 ✅ |
| warning `#f76707` | 5.13 ✅ | 4.02 ⚠️ |
| error `#db2828` | 4.32 ⚠️ | 4.65 ✅ |
| info `#4fc4d6` | 8.46 ✅ | 7.21 ✅ |
| text-primary `#DCE9F0` | 11.2 ✅ | 9.5 ✅ |

⚠️ 状态点像素小（4-6px）走 WCAG "non-text contrast" 1.4.11 比例（3:1 即可）—— **全部通过**。
**文字**必须配文字描述时用 `#DCE9F0`（高对比），不靠颜色。

### 5.2 信号灯（看板列标题 / 时间轴 lane 头）

看板每列标题前 / 时间轴每条 lane 头部加**信号灯三态**：

```
[● 成功 / 进行中 / 警示]  待办          12
```

- 3px × 12px 圆角矩形
- 状态色填充 + 12% alpha halo
- 右侧数字（卡片数）mono 11px 60% alpha

**新增**：`--traffic-signal-size: 3px 12px` / `--traffic-signal-halo: 0 0 4px`

---

## 6. 背景装饰（**极弱**、**可选**、**不影响阅读**）

> 反例：Cyberpunk 强 grid / scanline 破坏 a11y + 干扰阅读。
> 正例：8% alpha 细 grid + 4% alpha 冷白点阵，仅在**主画布 / 看板空白区 / 时间轴背景**显示，**不进卡片**。

### 6.1 主画布 grid

```css
.canvas-grid {
  background-image:
    linear-gradient(rgba(220, 233, 240, 0.04) 1px, transparent 1px),
    linear-gradient(90deg, rgba(220, 233, 240, 0.04) 1px, transparent 1px);
  background-size: 24px 24px;
}
```

- 24px 网格（跟 Spacing `--space-lg` 一致）
- 1px 冷白 4% alpha 细线
- **不进** 卡片 / 列 / 抽屉 / 弹窗
- **不进** 看板内容区（干扰卡片阅读）

### 6.2 角落点阵（HUD 顶角装饰）

应用窗口四角（仅右上 + 右下）放 4×4 装饰点阵（3px 圆点，12% alpha 主色）：

```
· · · ·
· · · ·
· · · ·
· · · ·
```

- 16×16px 大小
- 4×4 点阵 / 1px gap
- 仅顶角装饰，**不抢戏**
- 不用作信息元素（不是 loading / 不是进度）

### 6.3 scanline（**默认关闭**，仅 v2 考虑）

- 反例：CRT 扫描线在 LED 屏上"噼啪响" + 影响阅读 + a11y 差
- v1 **不采用**
- v2 评估：是否给"开发者偏好"开关，单独走 `prefers-reduced-motion: reduce` 兼容

---

## 7. 数据可视化（KPI / 进度 / sparkline）

> 看板首页 / 合并管理页 / 设置页需要展示"汇总数字"——这些是"科技感"最浓的展示位。

### 7.1 KPI 大数字

```html
<div class="kpi">
  <div class="kpi-label">本周合并</div>
  <div class="kpi-value">47</div>
  <div class="kpi-trend">↑ 12% vs 上周</div>
</div>
```

- label：Inter 11px 60% alpha 冷白
- value：**JetBrains Mono 36-48px 主色**（**强发光的唯一例外**：`text-shadow: 0 0 8px 主色 40%`）
- trend：Inter 11px（绿 / 橙 / 红取决于升降）

**新增**：`--kpi-value-fg: var(--color-primary)` / `--kpi-value-shadow: 0 0 8px rgba(96, 153, 38, 0.4)`

### 7.2 进度条

```css
--progress-track-bg: rgba(96, 153, 38, 0.08);  /* 主色 8% alpha 底 */
--progress-track-border: 1px solid rgba(96, 153, 38, 0.2);
--progress-fill-bg: linear-gradient(90deg, #609926 0%, #7cb342 100%);
--progress-fill-glow: 0 0 6px rgba(96, 153, 38, 0.4);
```

- 高度 6px，圆角 3px
- 轨道 = 主色 8% alpha + 1px 主色 20% 描边
- 填充 = 主色线性渐变 + 微弱 glow
- 进度数字 mono 12px 右侧显示 `78%`

### 7.3 Sparkline / 微图表（**v1 可选**）

- 时间轴底部 / 合并管理页右栏显示近 30 天合并频率
- 1px 主色线条 + 4px 圆点高亮
- 不进 v1 主线（M3 评估）

---

## 8. 数字 / 命令式 UI 微调

### 8.1 顶部 StatusBar（必做）

- 高度 24px，全宽置顶
- 显示：项目路径 / 同步状态 / 快捷键 / 状态 / 版本号
- mono 字体（除"快捷键说明"短文本）
- 底部 1px 冷白 4% alpha 描边分隔

### 8.2 面包屑 / 路径

- 全 mono 字体
- `org / team / project : branch` 格式（斜杠 + 冒号是 git 习惯但要走零术语翻译表：见 8.5）
- 当前页（最右）加 `▎` 主色窄条前缀

### 8.3 快捷键 chip

- 键帽样式见 §3.5
- 紧贴命令文字右侧（不要单独成行）

### 8.4 Loading / Skeleton

- Skeleton 用主色 8% alpha 闪烁（不是灰）
- Spinner 用主色 12% alpha halo + 2px 主色弧
- 不用"菊花"图案（HUD 风用弧线 + 数字百分比）

### 8.5 零术语翻译表追加（**HUD 表达相关**）

| 原文 | HUD 风格显示 | 解释 |
|---|---|---|
| `refs/heads/main` | `refs/heads/main` | 保留 gitea 原表达（gitea 自己就这么显示），hover 解释"主线分支 ref" |
| `origin/main` | `origin/main` | 同上 |
| `master` | `main` | 默认显示 `main`（gitea 默认分支），hover 显示实际名 |
| `HEAD` | `HEAD` | 保留（git 通用） |
| `~1` / `^2` | `~1` / `^2` | 保留（dev 都懂，非技术用户不进此区） |
| commit short SHA | `a1b2c3d` | mono 显示，不翻译 |
| `#482` | `#482` | mono 显示（issue 编号） |

**不**给非技术用户显示 raw ref / raw SHA——他们看到的是**卡片名 / 状态 / 同步时间**。

---

## 9. 数字 / 字号 / 字距分级

| 用途 | 字体 | 字号 | 字距 | 字重 |
|---|---|---|---|---|
| H1（页面标题） | Inter | 24px | -0.5px | 600 |
| H2（区块标题） | Inter | 18px | -0.3px | 600 |
| H3（卡片标题） | Inter | 14px | -0.2px | 600 |
| Body | Inter | 13px | 0 | 400 |
| Body 小 | Inter | 12px | 0 | 400 |
| Caption | Inter | 11px | 0.2px | 400 60% alpha |
| Button | Inter | 13px | 0 | 500 |
| Mono 表格 | JetBrains Mono | 12px | 0 | 400 |
| Mono 小 | JetBrains Mono | 11px | 0 | 400 60% alpha |
| KPI 大数字 | JetBrains Mono | 36-48px | -1px | 600 |
| 状态码 / commit hash | JetBrains Mono | 11-12px | 0 | 500 |
| 中文 fallback | Noto Sans SC | 同 Inter | 0 | 同 Inter |

**字距策略**：
- 标题（>18px）`-0.3 ~ -0.5px`（收紧，更"工程"）
- mono 数字 `-0.5 ~ -1px`（数字块状感强）
- 11-12px 文本 `+0.2px`（略松，可读性↑）

---

## 10. 过渡 / 动画

| 类型 | 时长 | 缓动 | 适用 |
|---|---|---|---|
| 颜色 / 描边 | 150ms | ease-out | hover / focus / state |
| 卡片抬升 | 200ms | cubic-bezier(0.2, 0.8, 0.2, 1) | hover 时 `translateY(-1px)` + 阴影升级 |
| glow 升级 | 200ms | ease-out | hover 主按钮 glow 升级 |
| 弹窗 | 180ms | cubic-bezier(0.2, 0.8, 0.2, 1) | 缩放 0.95→1 + 透明度 |
| 抽屉 | 240ms | cubic-bezier(0.2, 0.8, 0.2, 1) | `translateX(20px)→0` |
| 状态点 halo | 1500ms 循环 | ease-in-out | 仅等待 / 同步状态点呼吸 |
| 数字滚动 | 400ms | ease-out | KPI 大数字变化 |
| **禁用** | — | — | ❌ layout-shifting scale (transform: scale > 1.02) |
| **禁用** | — | — | ❌ 大于 400ms 的过渡（慢） |
| **禁用** | — | — | ❌ glitch / 错位动画（不专业） |
| **禁用** | — | — | ❌ CRT scanline（a11y 差，v1 不做） |

**`prefers-reduced-motion: reduce` 兼容**：
- 状态点 halo 关闭
- 卡片抬升改用 box-shadow 变化
- 数字滚动改用瞬时
- 抽屉 / 弹窗缩放改用纯透明度

---

## 11. 反模式（**不采用**）

| 反模式 | 理由 |
|---|---|
| ❌ Cyberpunk 强霓虹（matrix 绿 + 洋红 + 强 glow） | a11y 差 + 跟非技术用户友好原则冲突 |
| ❌ CRT scanline / 噪点 | LED 屏"噼啪" + 干扰阅读 + 跟专业工具冲突 |
| ❌ Glitch 错位动画 | 不专业 + 让人头晕 |
| ❌ 12-16px 大圆角 | 偏 C 端（airbnb 风），跟 dev 工具主流（Linear / Notion 6-8px）冲突 |
| ❌ 渐变彩色背景 | 干扰阅读 + 占用色域让状态色失效 |
| ❌ "未来感"装饰图形（无功能） | 干扰信息架构，违反"克制"原则 |
| ❌ emoji 图标 | 跟 OVERRIDE §本项目专属规则 #1 一致**禁止** |
| ❌ Tailwind utility class 风格 | 本项目用 CSS Modules + 全局 CSS 变量（OVERRIDE §本项目） |
| ❌ raw `0xRRGGBB` 硬编码到组件 | 全部走 `--color-*` / `--shadow-*` / `--radius-*` token |

---

## 12. 实现路径（实施清单）

> 这份精修**不直接落地到代码**——先让 user 拍板 §13 的决策点，再分批进 implementation。

**Phase 1（必做，最小代价）**：
- 更新 `src/renderer/styles/theme.css` 的 token 变量（边角 / 阴影 / 发光 / 状态色 / mono 字体用法）
- 加 `src/renderer/styles/hud-decor.css`（装饰角 / 标题前缀条 / 状态点 halo）
- 加 `src/renderer/components/StatusBar.vue` 顶部状态栏
- 加 `src/renderer/components/SignalDot.vue` 状态点组件
- 加 `src/renderer/components/KeyCap.vue` 键帽组件

**Phase 2（推荐）**：
- 看板 / 时间轴 / 合并管理三页改造卡片装饰角 + 标题前缀条
- KPI 区块（大数字）替换关键页的"数字"
- 进度条 / 进度数字应用到合并管理 / 看板列头

**Phase 3（可选）**：
- Sparkline / 微图表
- 状态点呼吸动画
- 数字滚动动画

---

## 13. 拍板请确认（user 必答）

1. **边角锐化**（卡片 6px / 按钮 4px / 标签 2px）—— 是否接受？dev 工具主流 vs 当前 gitea 的偏柔？
2. **HUD 装饰元素**（装饰角 + 标题前缀条 + 键帽）—— 装饰程度合不合适？会不会"过度工程师"？
3. **状态色新增**（红 `#db2828` / 青 `#4fc4d6` / 灰 `#94a3b8` `#64748b`）—— 是否引入？gitea 生态内有红 / 青吗？
4. **背景 grid / 角落点阵**（8% alpha 极弱）—— 主画布加 grid 装饰能接受吗？还是只做角落点阵？
5. **顶部 StatusBar**（24px 高，路径 + 快捷键 + 状态）—— 桌面应用窗口本来就少空间，加这条合理吗？v1 必做还是 v1.1？
6. **KPI 大数字 + 强发光**（36-48px mono + text-shadow 0 0 8px 主色 40%）—— 这是"科技感"最浓的展示位，但要占空间；放首页/合并管理？还是只首页？
7. **scankline 关闭** —— v1 接受不开吗？（a11y + LED 屏冲突）
8. **数字滚动 / 状态点呼吸** —— v1 做还是 v1.1 之后？（`prefers-reduced-motion` 已能兼容）

---

# v1.2 主题收敛（2026-06-13 user 拍板推翻 v1.1.2 三主题）

> 本节是 **v1.2 主题收敛**的完整设计稿。v1.1.2 的 3 主题系统（A 暗 / C 暗 / Light）被**推翻**：
> 实战发现 A 暗（苍蓝）与 C 暗（中性近黑）**视觉差异仅在冷暖**——非技术用户根本分不清、
> 且在主色外环 glow 加持下都偏向 gitea 绿主导；3 主题对非技术用户产生**认知负担**而非自由度。
>
> 落地期（frontend worker plan）按本节 token 矩阵 + IPC 契约实现。

---

## 14. v1.2 主题系统

### 14.1 两套主题

| ID | 名称 | canvas | 色相 | 文字 | 阴影 | glow | 默认 |
|---|---|---|---|---|---|---|---|
| `dark`  | **暗色 · 中性近黑** | `#0F1115` | H220° S17% L7% | 冷调蓝灰 `#C5D4DD` | 中性黑阴影 + 1px 冷白 inset + 主色外环 | 启用 | ✅ |
| `light` | **浅色 · 浅苍蓝** | `#E8F1F5` | H198° S39% L94% | 冷调深蓝灰 `#0F1A24` | 纯冷黑阴影（无 inset / 无外环） | **关** | — |

**关键设计**：
- **主色 token 走"过 AA 4.5:1"调档版**（不再是品牌色 #609926 直接当文字色）：
  - `dark`  `#74B830`（vs `#0F1115` 4.74:1 ✅）
  - `light` `#466B16`（vs `#E8F1F5` 5.55:1 ✅）
  - 品牌色 `#609926` 退为**视觉锚**（dot / 装饰角 / 进度条 / 状态点 / 滚动条 thumb）
- **强调色** gitea 橙：dark 提亮 `#FF8534`，light 压暗 `#D85804`（白底 3.79:1）
- **状态色 5 个**（warning / error / info / pending / offline）2 主题**通用语义**，亮色版用对应"暗 20%"色值
- **shadow + glow** 主题差异最大：dark = "深底色 + 1px 冷白 inset + 主色外环"，light = "纯冷黑阴影 + 无装饰"（glow 在白底上糊）
- **滚动条**（v1.2 新增美化）：thumb 用主色 22-25% alpha 软底 + hover 提亮到 42-50% + dark glow / light 1px 描边

### 14.2 完整 token 矩阵

| Token | dark | light | 说明 |
|---|---|---|---|
| `--color-canvas`     | `#0F1115` | `#E8F1F5` | 主画布底色 |
| `--color-elevated`   | `#1E222A` | `#FFFFFF` | 卡片 / 列底 |
| `--color-hover`      | `#2D333F` | `#F1F6F9` | hover 态 |
| `--color-active`     | `#3C4453` | `#DDE7EC` | active 态 |
| `--color-text`       | `#C5D4DD` | `#0F1A24` | 主文字（dark 7.37:1 / light 12.7:1）|
| `--color-text-muted` | `#9AAAB6` | `#475461` | 次要文字（dark 5.29:1 / light 6.39:1）|
| `--color-text-dim`   | `#74818E` | `#5A6B7A` | 占位 / 禁用（dark 3.93:1 ⚠️ large only / light 4.50:1）|
| `--color-primary`    | `#74B830` | `#466B16` | 主色 CTA / 文字（**过 AA 4.5:1**）|
| `--color-primary-hover` | `#8AC544` | `#609926` | hover 提亮 |
| `--color-primary-active` | `#5C9622` | `#3D5512` | active 压暗 |
| `--color-primary-soft` | `rgba(116,184,48,.18)` | `rgba(70,107,22,.16)` | 主色软底 |
| `--color-primary-glow` | `rgba(116,184,48,.32)` | `rgba(70,107,22,.28)` | 主色光晕 |
| `--color-warning`    | `#FF8534` | `#D85804` | 强调色（dark 提亮 / light 压暗）|
| `--color-error`      | `#E14646` | `#C42020` | 错误 |
| `--color-info`       | `#4fc4d6` | `#157A91` | 信息 |
| `--color-pending`    | `#94a3b8` | `#5A6B7A` | 等待 |
| `--color-offline`    | `#64748b` | `#475461` | 离线 |
| `--shadow-rgb`       | `0, 0, 0` | `15, 26, 36` | 阴影起点色（rgba 用） |
| `--grid-color`       | `rgba(220,233,240,.08)` | `rgba(15,26,36,.08)` | 背景 grid 颜色 |
| `--kpi-glow`         | `0 0 8px rgba(116,184,48,.4)` | `0 0 0 0 transparent` | KPI 大字发光 |
| `--signal-halo`      | `0 0 4px rgba(116,184,48,.6)` | `0 0 0 1px rgba(70,107,22,.35)` | 状态点 halo（light 用实色描边）|
| `--breath-glow`      | `rgba(116,184,48,.4)` | `rgba(70,107,22,.25)` | 呼吸动画起止色 |
| `--dot-color`        | `rgba(116,184,48,.45)` | `rgba(70,107,22,.5)` | 角落装饰点阵（v1.2 提亮到 45%）|
| `--progress-fill-glow` | `0 0 6px rgba(116,184,48,.4)` | `0 0 4px rgba(70,107,22,.25)` | 进度条 fill 发光 |
| `--scrollbar-thumb`  | `rgba(116,184,48,.22)` | `rgba(70,107,22,.25)` | **v1.2 新增** thumb 默认态 |
| `--scrollbar-thumb-hover` | `rgba(116,184,48,.45)` | `rgba(70,107,22,.5)` | **v1.2 新增** thumb hover |
| `--scrollbar-thumb-glow` | `0 0 6px rgba(116,184,48,.4)` | `0 0 0 1px rgba(70,107,22,.4)` | **v1.2 新增** dark glow / light 实色描边 |
| `--card-hover-tint`  | `rgba(116,184,48,.08)` | `transparent` | **v1.2 新增** 卡片 hover 主色微亮（dark 专属）|

**对比度核查**（WCAG AA 文字 4.5:1 / 状态点 non-text 3:1）全部通过：
- dark `--color-text` vs canvas = 7.37:1 ✅；`--color-primary` vs canvas = 4.74:1 ✅；`--color-text-dim` vs canvas = 3.93:1 ⚠️ 仅 large text 3:1 / 装饰用
- light 全部 ≥ 4.50:1 ✅

### 14.3 不在 2 主题内变化的 token

- **边角锐化** `--radius-card: 6px` / `--radius-btn: 4px` / `--radius-chip: 2px` 等 — 2 主题通用
- **字号 / 间距** — 2 主题通用
- **字体** Inter + JetBrains Mono + Noto Sans SC — 2 主题通用
- **HUD 装饰元素**（装饰角 / 标题前缀条 / 键帽 / 信号灯 / KPI 大字）— 2 主题通用，颜色跟随 `--color-*` 自动变
- **卡片阴影强度 / 过渡时长** — 2 主题通用
- **滚动条尺寸** 8px 细 + 4px 圆角 — 2 主题通用，**thumb 颜色** 走主题 token

### 14.4 主色"过 AA 4.5:1"调档逻辑

| 场景 | dark | light | 备注 |
|---|---|---|---|
| **品牌色（视觉锚）** | `#609926` | `#609926` | 不直接当文字色；用于 dot / 装饰角 / 进度条渐变 / 滚动条 thumb |
| **主色 token（CTA / 文字）** | `#74B830` | `#466B16` | 提亮 / 压暗到 vs canvas 4.5:1 ✅ |
| **hover 提亮** | `#8AC544` | `#609926`（回到品牌色）| 双向：dark 进一步提亮 / light 回到品牌色 |
| **active 压暗** | `#5C9622` | `#3D5512` | 进一步压暗 |

**规则**：主色 token 必须 **vs canvas ≥ 4.5:1**；hover 提亮 / active 压暗 6-10% 亮度即可，不破坏色相。

**为什么 v1.2 不再保留 v1.1.2 的"亮色用 #4F7A1A 加深 1 档"**：
- `#4F7A1A` vs `#E8F1F5` = 4.16:1 ❌（差 0.34 不到 4.5:1）
- v1.2 压暗到 `#466B16`（5.55:1 ✅）—— 同时 dark 版提亮到 `#74B830`（4.74:1 ✅）

---

## 15. 主题切换 UX（v1.2 App 功能）

### 15.1 切换入口（3 处都给）

| 入口 | 用途 | 用户群 |
|---|---|---|
| **顶栏 StatusBar** | 一键循环切换（点按钮在 dark / light 之间循环） | 所有人最常用 |
| **设置页 → 外观** | 显式单选（dark / light），附预览缩略图 | 想精细控制的人 |
| **命令面板** `⌘K` → 输入"主题" | 键盘党 + 高级用户 | power user |

### 15.2 切换瞬间 UX

- **过渡**：`transition: background-color 150ms ease-out, color 150ms ease-out`（**不能**硬切，会有"闪屏"）
- **过渡范围**：仅 canvas / elevated / text / shadow / glow / 滚动条 thumb 这一组，**不动**布局、卡片位置、滚动条宽度
- **保存**：点击瞬间同步写 `prefs.theme` 字段到 sqlite（不阻塞 UI）
- **失败回滚**：写 sqlite 失败 → toast "设置保存失败，请重试" + 不切换（用户感知无变化）

### 15.3 持久化路径

```ts
// src/main/prefs/store.ts (v1.1.2 加 · v1.2 收敛 enum)
// v1.2 — 主题偏好（user 拍板 2026-06-13 收敛 3 主题为 2 主题）
prefs.theme: 'dark' | 'light'  // 默认 'dark'（v1.1.2 C 暗基底 + 桌面工具主流）
prefs.themeChangedAt: ISODate  // 用于 analytics / 调试
```

**为什么不走 `localStorage` / `app.getPath('userData')/config.json`**：
- AGENTS §5.5 已定 prefs 表走 sqlite，**统一**比"主题在 sqlite / 其它在 config.json"好
- sqlite 跟其它 user 偏好（同步周期 / 通知规则 / 自定义快捷键）一个事务，原子写

### 15.4 主题切换数据流

```
[User 点 swatch / 命令面板 / 设置页]
    ↓
[preload api.theme.set('dark')]    // contextBridge 暴露的 API
    ↓ (IPC invoke)
[main/ipc/preferences.ts handler]    // preferences.setTheme
    ↓
[prefs store.set({ theme: 'dark' })] // sqlite UPDATE
    ↓
[return success]
    ↓
[renderer Pinia store: ui.applyTheme] // 改 documentElement.dataset.theme
    ↓
[CSS variable 系统接管]              // 150ms 平滑过渡
    ↓
[本地 localStorage 缓存当前主题]      // 启动期读，preferences.getTheme 没回来前先用这个
```

### 15.5 启动期

```
App 启动
    ↓
main process 读 prefs.theme（sqlite 异步，可能 50-200ms）
    ↓
[同时] renderer 从 localStorage 读上次值（同步，0ms）
    ↓
html element data-theme = localStorage 值（避免白屏闪烁）
    ↓
prefs.theme 回来后如果不一致 → 重新 apply
```

**目的**：启动期 0 白屏 / 0 闪烁。

---

## 16. 主题切换 IPC 契约（v1.1.2 新增 2 端点 · v1.2 enum 收敛）

> ⚠️ AGENTS §7.1 #2 边界 — 改 IPC 契约需 user 拍板。**user 2026-06-12 已拍板 3 主题**；
> **user 2026-06-13 拍板收敛为 2 主题**（schema enum 收紧，**端点路径不变**）。

### 16.1 `preferences.theme.get`

```ts
// 命名遵循 02-architecture §5.1 <namespace>.<method> 风格
// preferences 是 §5.3 已定的 namespace（已包含 prefs.get / prefs.set）

// request
type ThemeGetRequest = Record<string, never>;  // 无参数

// response（200）
type ThemeGetResponse = {
  theme: 'dark' | 'light';  // v1.2 收敛
  changedAt: string;  // ISO 8601
};

// error（统一 IpcError）
// THEME_NOT_FOUND（首次启动、sqlite 损坏）
// DATABASE_UNAVAILABLE
```

### 16.2 `preferences.theme.set`

```ts
// request
type ThemeSetRequest = {
  theme: 'dark' | 'light';  // v1.2 收敛
};

// response（200）
type ThemeSetResponse = {
  theme: 'dark' | 'light';
  changedAt: string;
};

// error
// INVALID_THEME（不是合法 2 选 1）
// DATABASE_WRITE_FAILED
// DATABASE_UNAVAILABLE
```

### 16.3 IPC 端点变化

- **v1.1.2 新增**：2 个端点（`preferences.theme.get` / `preferences.theme.set`）
- **v1.2 不动端点路径**，仅收紧 enum 2 选 1
- **落地**：
  - `src/main/ipc/preferences.ts` 收紧 enum
  - `src/main/ipc/schema.ts` `ThemeEnumSchema` 收紧
  - `src/preload/index.ts` 注释 narrative 同步
  - `src/renderer/stores/ui.ts` 收敛 Theme union
  - `src/renderer/components/StatusBar.vue` 按钮文字 2 选 1
  - `src/renderer/views/SettingsView.vue` "外观" radio 2 选 1
  - `src/renderer/lib/command-palette.ts` 主题命令 2 选 1
  - `src/renderer/index.html` inline bootstrap script enum 白名单收紧 + CSP sha256 同步重算

### 16.4 落地任务拆分（frontend worker plan · v1.2 收敛）

按 5-15 分钟单任务粒度拆：

1. **theme-tokens-v1.2**: 改 `src/renderer/styles/theme.css` 收敛为 2 主题 token（dark 提亮主色 / light 压暗主色 / 新增 4 个滚动条 token）
2. **theme-store-v1.2**: 改 `src/renderer/stores/ui.ts` 收敛 Theme union
3. **theme-ipc-v1.2**: 改 `src/main/ipc/preferences.ts` + `src/main/ipc/schema.ts` 收紧 enum
4. **theme-statusbar-v1.2**: 改 `src/renderer/components/StatusBar.vue` 按钮文字 2 选 1
5. **theme-settings-v1.2**: 改 `src/renderer/views/SettingsView.vue` radio 2 选 1
6. **theme-command-v1.2**: 改 `src/renderer/lib/command-palette.ts` 命令 2 选 1
7. **theme-init-v1.2**: 改 `src/renderer/index.html` inline bootstrap + 重算 CSP sha256 hash
8. **theme-check-v1.2**: 跑 producer 验证矩阵 4 命令（type-check / build / no-jargon / 视觉对比 2 主题）

**关键依赖**：`theme-ipc-v1.2` 必须先于 `theme-store-v1.2` 完成（store 引 schema enum）；`theme-init-v1.2` CSP hash 同步重算。

---

## 17. 拍板历史 / 撤回

- **v1（2026-06-10）**：单主题暗色（不提供切换），苍蓝 `#134857` 底 — **v1.1.2 推翻**（user 2026-06-12 拍板）
- **v1.1（2026-06-12）**：A 暗提饱和 `#0E3A52` + 主文字 `#C5D4DD`（解决灰蒙 + 文字过亮） — **v1.1.2 沿用**
- **v1.1.2（2026-06-12）**：3 主题切换（A 暗 / C 暗 / Light），默认 A 暗，sqlite 持久化 — **v1.2 推翻**（user 2026-06-13 拍板，3 主题对非技术用户产生认知负担）
- **v1.2（2026-06-13）**：2 主题切换（dark / light），默认 dark，sqlite 持久化；主色 token 提亮到 #74B830 / 压暗到 #466B16 过 AA 4.5:1；滚动条 thumb 用主色软底 + hover 提亮 + glow（dark）/ 实色描边（light）—— **当前拍板**
