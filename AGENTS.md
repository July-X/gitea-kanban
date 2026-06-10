# AGENTS.md — gitea-kanban

> **本文件给所有 agent 和开发者读**。OpenCode / Codex / Cursor / Aider / Devin / Gemini CLI 等
> 主流 agent 都会消费这个 spec。如果本文件与仓库里其它文档冲突，**以本文件为准**——它是
> 实现期 `mavis team plan` 启动时的入口。

> 最后更新：2026-06-10 17:24（v3 拍板 Vue 3；实现阶段开始后由后端/前端 agent 维护）

---

## 1. 项目概述

**gitea-kanban** 是一个**基于 gitea 的桌面端看板 + 时间轴工具**（Electron + TypeScript），专注于**强 git 集成**（多分支 commit 节点 / PR 合并边 / 分支管理）和**轻量自托管体验**（gitea 是 source of truth，本地只存用户偏好和缓存）。

**解决什么问题**：gitea 自带的 issue 看板 + Project 板子只能按 label 维护状态，没有 commit / 分支 / PR 维度的可视化；市面通用 PM 工具（Plane / Leantime / OpenProject）感知不到 git 数据；GitKraken 闭源且要订阅。我们用桌面端单二进制 + 零术语界面 + git graph 风格时间轴填这个空缺。

**目标用户**（用户决策 #2，2026-06-10）：gitea 自托管团队成员，**含非技术人员**（PM、设计师、市场、运营）—— UI 必须零术语、危险操作二次确认、错误提示"人话"，让一个没碰过 git 命令行的产品经理能照着界面走完"建卡片 → 拖到已合并列 → 看到这次合并对应 commit 高亮"。

---

## 2. 技术栈定型

> 详细论证见 `docs/design/01-research.md`；本节是落地的最终结论，**不再评估**。

### 2.1 主框架

| 维度 | 选型 |
|---|---|
| **运行时** | **Electron**（跟随官方 LTS）+ **Node 20 LTS**（Electron 自带） |
| **语言** | **TypeScript 5.x**（主进程 / 渲染进程 / preload 三端统一 TS） |
| **构建** | **electron-vite**（HMR 友好，三端统一构建） |
| **打包** | **electron-builder**（macOS dmg 优先 / Windows nsis exe / Linux AppImage） |
| **代码签名** | macOS Developer ID + notarization（v1 必须）；Windows Authenticode + Linux GPG v2 best-effort |

### 2.2 渲染进程（UI 层）

| 维度 | 选型 |
|---|---|
| **框架** | **Vue 3 + Vite**（Composition API + `<script setup>`，用户决策 2026-06-10 17:24 改） |
| **状态管理** | **Pinia**（Vue 官方；不用 Redux / MobX / Vuex） |
| **路由** | **Vue Router 4**（`createWebHashHistory` 适配 Electron） |
| **UI 组件库** | **Radix Vue（同一团队，unstyled primitives）+ @headlessui/vue 补缺**（不引 antd / Element Plus / Naive UI，视觉太重） |
| **样式** | **CSS Modules + 全局 CSS 变量**（不引 Tailwind / styled-components） |
| **timeline / git graph** | **AntV X6@3.1.7 + @antv/x6-vue-shape**（图编辑引擎 + Vue 官方桥） |
| **数据校验** | **Zod**（与 TS 类型双向同步，IPC 边界强制校验） |
| **HTTP 客户端** | 原生 fetch（主进程内走，渲染进程不起 HTTP） |
| **测试** | **Vitest + @vue/test-utils + @testing-library/vue + Playwright（e2e）** |

### 2.3 主进程（本地服务层）

| 维度 | 选型 |
|---|---|
| **gitea 客户端** | **`openapi-fetch` + 手写 TS 类型**（或 `gitea-js` 备选；gitea 自带 OpenAPI 文档生成类型） |
| **本地数据库** | **SQLite 文件**（`app.getPath('userData')/kanban.db`） |
| **SQLite 客户端** | **`better-sqlite3`**（同步 API、零回调、性能远超 node-sqlite3） |
| **ORM** | **Drizzle ORM**（schema-first、TS 类型生成、迁移工具链成熟） |
| **迁移** | **`drizzle-kit`** |
| **git CLI 调用** | **`simple-git`**（仅 v2 高级场景；v1 默认不走 git CLI） |
| **keychain** | **`keytar`**（macOS Keychain / Windows Credential Vault / Linux Secret Service） |
| **日志** | **`pino` + `pino-pretty`**（开发） |
| **错误监控** | 本地日志 + Sentry（可选，用户在设置页填 DSN 才开启） |
| **测试** | **Vitest**（与渲染进程同栈） |

### 2.4 部署形态

| 平台 | 产物 | 分发方式 |
|---|---|---|
| macOS | `.dmg` | 官网下载 + Homebrew Cask（v2 考虑 Mac App Store） |
| Windows | `.exe`（NSIS） | 官网下载 + Chocolatey（v2） |
| Linux | `.AppImage` | 官网下载 + Flathub（v2） |

**更新机制**：`electron-updater`（基于 S3 / GitHub Releases），用户首次启动检测、手动确认下载。

### 2.5 鉴权（gitea PAT + 系统 keychain）

- **首次接入**：用户去 gitea `Settings → Applications → Generate New Token` 创建 token（权限 `read:repository, read:issue, read:user, write:repository, write:issue`）→ 粘贴进应用 → 主进程调 `keytar.setPassword` 存 keychain。
- **绝不**存明文到文件 / SQLite / `localStorage`；**绝不**在 IPC 协议里出现 `token` 字段（`auth.connect` 之外）；token 只在主进程内存里。
- **多账号**：keychain service = `gitea-kanban@<url>`，account = `<username>`。

### 2.6 不做的事（边界）

- ❌ 不做 OAuth2 跳转（桌面应用无必要）
- ❌ 不做 nginx 反代 / CSRF 保护（公网入口不暴露）
- ❌ 不做 in-app 冲突解决（v1 跳 gitea 网页）
- ❌ 不做实时协作 / 多人光标（v2 考虑）
- ❌ 不做任务评论 / 通知系统（跳回 gitea 原生 issue/PR 评论）
- ❌ 不绑死 gitea（API 层抽象成 git provider interface，v2 支持 GitLab/Forgejo）

---

## 3. 目录结构

> 当前仓库只有 `docs/design/` 和 `design-system/`，下面是**计划中的**目录树（实现期按此初始化）。每个目录一句话职责。

```
gitea-kanban/
├── AGENTS.md                       # 本文件，所有 agent 必读
├── README.md                       # 用户可见的快速上手
├── LICENSE                         # MIT
├── package.json                    # 依赖 + 脚本
├── pnpm-lock.yaml                  # 锁文件，必须提交
├── electron.vite.config.ts         # electron-vite 三端构建
├── tsconfig.json                   # 渲染进程 TS 配置
├── tsconfig.node.json              # 主进程 / preload TS 配置
├── electron-builder.yml            # 打包配置
├── drizzle.config.ts               # DB 迁移配置
├── .eslintrc.cjs                   # 渲染 + 主进程统一 lint
├── .prettierrc                     # 统一格式化
├── .editorconfig
├── .gitignore
├── .nvmrc                          # Node 20 LTS
├── resources/                      # 图标 / 安装包资源
│   ├── icon.icns
│   ├── icon.ico
│   └── icon.png
├── docs/                           # ========== 设计 + 用户文档 ==========
│   ├── design/                     # 设计阶段产出
│   │   ├── 00-overview.md          # 设计综述 + 路线图（用户 review 入口）
│   │   ├── 01-research.md          # 调研（gitea 生态 / 竞品 / timeline 方案）
│   │   ├── 02-architecture.md      # 架构 + 后端设计（主进程 + IPC 契约）
│   │   ├── 03-frontend.md          # 前端设计（UI/UX + 时间轴 + wireframe）
│   │   └── wireframe/              # 静态 HTML wireframe
│   │       ├── index.html
│   │       ├── timeline.html
│   │       └── merge.html
│   └── adr/                        # 架构决策记录（实现期新增）
├── design-system/                  # ========== 设计系统 ==========
│   └── gitea-kanban/
│       ├── MASTER.md               # ui-ux-pro-max 默认推荐
│       └── OVERRIDE.md             # 本项目实际生效（single source of truth）
├── src/
│   ├── main/                       # ========== 主进程 ==========
│   │   ├── index.ts                # 应用入口 / 生命周期 / 单实例锁 / 托盘
│   │   ├── window.ts               # BrowserWindow 管理
│   │   ├── ipc/                    # IPC 路由层（ipcMain.handle 注册）
│   │   │   ├── index.ts            # 统一注册
│   │   │   ├── repo.ts / branch.ts / commit.ts / pr.ts / board.ts / user.ts / auth.ts
│   │   │   └── schema.ts           # 所有 IPC 的 Zod schema
│   │   ├── gitea/                  # gitea 集成层（fetch + PAT + 错误规整）
│   │   │   ├── client.ts           # 按 (giteaUrl, username) 缓存的 client 工厂
│   │   │   ├── auth.ts             # PAT 校验 + keychain 读写
│   │   │   ├── repos.ts / branches.ts / commits.ts / pulls.ts / issues.ts
│   │   │   ├── hooks.ts            # webhook 注册 / 解析 / 验签（v2）
│   │   │   └── types.ts            # gitea API 响应类型
│   │   ├── cache/                  # 本地缓存（SQLite + TTL + 失效器）
│   │   │   ├── sqlite.ts           # better-sqlite3 单例 + 迁移
│   │   │   ├── repos.ts            # 各资源的 cache-aside
│   │   │   ├── ttl.ts              # TTL 策略
│   │   │   └── webhook-deliveries.ts
│   │   ├── board/                  # 看板业务（列 / 卡片 / 关联 / 撤销栈）
│   │   │   ├── columns.ts / cards.ts / link.ts / undo.ts
│   │   ├── notify/                 # 系统通知（OS Notification + 规则）
│   │   ├── logger.ts               # pino 实例
│   │   ├── config.ts               # 配置加载
│   │   └── store/                  # 偏好持久化
│   │       └── prefs.ts
│   ├── preload/                    # ========== preload 桥 ==========
│   │   ├── index.ts                # contextBridge.exposeInMainWorld('api', api)
│   │   └── api.d.ts                # window.api 类型声明
│   ├── renderer/                   # ========== 渲染进程 ==========
│   │   ├── index.html
│   │   ├── main.ts                 # Vue 3 入口（createApp + Pinia + Vue Router）
│   │   ├── App.vue                 # 根 SFC（<template> + <script setup lang="ts"> + <style scoped>）
│   │   ├── routes/                 # 路由级页面（看板 / 时间轴 / 合并 / 设置 / 仓库列表）
│   │   ├── components/             # 通用组件（AppShell / NavRail / ConfirmDialog / Toast / EmptyState / ErrorBoundary）
│   │   ├── features/               # 业务特性（board / timeline / merge / repo-list / settings）
│   │   ├── stores/                 # Pinia store（auth / repo / board / branch / pr / timeline / sync / ui / settings）
│   │   ├── lib/                    # 工具（ipc-client / format / i18n / date）
│   │   └── styles/                 # 全局样式（theme.css / reset.css / 字体）
│   └── shared/                     # ========== 主/渲染共享 ==========
│       ├── ipc-types.ts            # IPC 契约 TS 类型（Zod 自动生成，single source of truth）
│       ├── errors.ts               # 统一 IpcError 格式
│       ├── constants.ts
│       └── i18n/                   # zh / en 文案
├── drizzle/                        # 迁移 SQL 文件
└── scripts/                        # 工具脚本（建表 / 测 token / 导出日志）
```

---

## 4. 开发规范

### 4.1 Commit Message 规范

> 用户决策（2026-06-10），全项目所有 agent 必须遵守。

- **必须中文**；type 限定 `feat / fix / refactor / perf / chore / test / docs / style` 之一。
- **每个阶段性交付打一次 commit**（一份文档 / 一个模块），不攒大 commit。
- **格式**：
  ```
  <type>: <中文一句话描述>

  <可选：详细说明>
  ```
- **示例**：
  - `feat: 加看板拖拽 + 卡片 CRUD`
  - `fix: 修合并冲突时按钮没禁用`
  - `docs: 写 02-architecture.md §5 IPC 契约`
  - `chore: 升级 electron-vite 到 2.x`
- **commit 末尾不加 `Co-Authored-By`**（不附 AI 自动签名）。
- **commit 必须落到 master**（当前单分支，初始化阶段不引入多分支）。
- **"我写完文件了" 不算交付，"我 commit 了 + commit hash" 才算**。
- **worker agent 不准自己 git commit** —— 所有 commit 由 orchestrator（mavis）统一打，避免并发 worker 互相覆盖。

### 4.2 PR 规范

> v1 阶段单分支 master 直推；v2 引入功能分支时按以下规范。

- **PR 标题**：中文 + type 前缀（与 commit 同格式）。
- **PR 描述模板**：
  - **改动目的**：为什么改
  - **改动内容**：列点
  - **截图 / 录屏**：UI 改动必须附
  - **测试**：跑了哪些 / 怎么验证
  - **关联 issue / 设计文档**：链接到 `docs/design/0X-*.md`
- **必须通过 CI**（lint + type-check + 单测 + e2e）才允许 merge。
- **review 至少 1 人**（实现期 = 计划负责人；v2 团队 = 至少 1 个非作者）。

### 4.3 分支策略

**推荐 trunk-based**（`master` 单分支 + 短命 feature branch）。

理由：
- 项目处于 0 → 1 阶段，无须 release branch / hotfix branch 复杂度。
- 用户决策："当前单分支 master，初始化阶段不引入多分支"——与 trunk-based 一致。
- PR 短期存活（< 1 天），减少合并冲突。
- v1 完成后引入 release tag 即可（不打 branch）。

**禁用**：
- ❌ gitflow（多 long-lived branch，复杂度对小团队不划算）
- ❌ 在 master 上直接 force push
- ❌ 把临时探索性代码 commit 到 master（用 worktree / stash）

### 4.4 测试规范

| 层 | 工具 | 覆盖率目标 | 必测场景 |
|---|---|---|---|
| **主进程单测** | Vitest | ≥ 70% 行覆盖 | gitea client 包装 / 缓存策略 / IPC handler 入参校验 / keychain 抽象 / 权限校验 |
| **渲染进程单测** | Vitest + @vue/test-utils + @testing-library/vue | ≥ 60% 行覆盖 | 组件渲染 / Pinia store action / 危险操作二次确认触发 |
| **e2e** | Playwright + electron | 关键路径 100% 覆盖 | 启动 → 连接 gitea → 切仓库 → 看板拖拽 → 时间轴渲染 → 合并 PR → 离线降级 |
| **契约测试** | 手写 + openapi-fetch 类型 | 100% IPC endpoint 有契约 | grep `ipcMain.handle` 数 = `window.api` 暴露数 |
| **视觉回归** | Playwright screenshot + 人工 review | 关键页面 baseline | 看板 / 时间轴 / 合并确认弹窗 / 二次确认弹窗 |

**必测场景**（不测不准 merge）：
1. 首次启动 → PAT 输入 → 连接 gitea 成功
2. PAT 无效 → 提示"登录已过期" + 跳设置页
3. 看板拖拽卡片跨列 → 后端更新 → 撤销栈记录
4. 时间轴选多个分支 → 渲染 commit 节点 + 合并边
5. 合并 PR（普通 / 变基 / 压缩）→ gitea 写入成功 → 本地缓存失效
6. 删除分支 → 二次确认弹窗 → 输入"删除"才执行
7. 离线模式：网络断开 → 显示 stale 缓存 + 状态栏提示
8. 危险按钮（合并到 main）→ 默认按钮改为"我了解风险，仍要合并"
9. 暗色模式切换 → 全部页面配色正确
10. macOS dmg 安装 → 启动 → 正常进入主窗口

### 4.5 日志规范

- **唯一日志出口**：`pino`（主进程）+ 渲染进程 console（开发期）
- **结构化字段**：`{ ts, level, msg, userId?, giteaUrl?, projectId?, op, latencyMs, errCode? }`
- **热路径保护**：高频调用（缓存读 / IPC 路由）必须用 `logger.isLevelEnabled('debug')` 判断后再拼字符串，避免无谓开销。
- **pino redact 规则**：禁止把 `token` / `password` / `key` 写日志（pino 配置 `redact: ['*.token', '*.password', 'token', 'password']`）。
- **日志位置**：`app.getPath('logs')/main-YYYY-MM-DD.log`，按日滚动，保留 14 天。

### 4.6 格式化 / Lint

- **TS / Vue SFC 格式化**：`prettier`（统一配置在 `.prettierrc`）—— `prettier --write "src/**/*.{ts,vue}"`
- **Lint**：`eslint` + `@typescript-eslint` + `eslint-plugin-vue`（统一配置在 `.eslintrc.cjs`） —— `pnpm lint`
- **CSS**：`stylelint` —— `pnpm lint:css`
- **提交前钩子**（husky + lint-staged）：自动跑 `prettier --write` + `eslint --fix` 修改过的文件。
- **不要全量格式化**（`gofmt -w <file>` 风格）：只格式化修改过的文件，避免污染 diff 历史。

### 4.7 安全

- 渲染进程默认开启 `contextIsolation: true` + `nodeIntegration: false` + `sandbox: true`
- 所有用户输入走 Vue 3 默认 `{{ }}` 模板转义，**禁止** `v-html`（仅 sanitize 后 markdown 渲染可豁免，需 review）
- 主进程所有文件 I/O 走 `app.getPath` + 白名单，**禁止**接受用户提供的绝对路径
- CSP：`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' <gitea URL>; img-src 'self' data: https:`
- 依赖：`pnpm audit --prod` 在 CI 跑；不引带 native binding 的包除非必要

---

## 5. 团队角色与职责边界

> 给未来 **mavis team plan** 用的分工。**后端 agent = 主进程**；**前端 agent = 渲染进程 + IPC 契约**；**verifier** 独立验证；**orchestrator** 拆 plan 跑 cycle。

### 5.1 后端 agent 角色（主进程）

| 维度 | 内容 |
|---|---|
| **负责范围** | `src/main/**`、`src/preload/**`、`src/shared/ipc-types.ts`（Zod schema 部分）、`drizzle/**`、打包配置（`electron-builder.yml`） |
| **文件 boundary** | **不**碰 `src/renderer/**`、**不**写 Vue 组件、**不**写 CSS、**不**直接调 gitea API 而绕过 IPC |
| **产出标准** | ① `pnpm dev` 跑得起来<br>② 所有 IPC handler 在 `src/main/ipc/schema.ts` 有 Zod schema<br>③ `pnpm test` 全绿（主进程单测）<br>④ `pnpm type-check` 无 error<br>⑤ 主进程日志符合 §4.5 规范 |
| **依赖** | `electron`, `better-sqlite3`, `drizzle-orm`, `pino`, `keytar` / `@napi-rs/keyring`, `openapi-fetch` |

### 5.2 前端 agent 角色（渲染进程）

| 维度 | 内容 |
|---|---|
| **负责范围** | `src/renderer/**`、`src/shared/i18n/**`、wireframe HTML、组件库 |
| **文件 boundary** | **不**碰 `src/main/**`、**不**写 SQLite schema、**不**调 gitea API 直连（**不**绕过 IPC）、**不**改 `src/shared/ipc-types.ts`（只能消费，不能改） |
| **产出标准** | ① `pnpm dev` 渲染进程 HMR 跑得起来<br>② `pnpm test` 组件单测全绿<br>③ `pnpm type-check` 无 error<br>④ `pnpm check:no-jargon` 通过（**UI 文本不含 PR/merge/rebase/fork 等原词**）<br>⑤ 关键页面（看板 / 时间轴 / 合并）有 e2e 截图 |
| **依赖** | `vue`, `pinia`, `vue-router`, `@antv/x6`, `@antv/x6-vue-shape`, `zod`, `@radix-vue/*`, `@headlessui/vue`, `lucide-vue-next` |

### 5.3 Verifier 角色

| 维度 | 内容 |
|---|---|
| **职责** | 独立于后端 / 前端 agent，验证 plan 产出**客观可验证的部分** |
| **验证项** | ① `ipcMain.handle` 数 = `window.api` 暴露数（grep 验证）<br>② 危险操作都有二次确认（静态扫描关键字）<br>③ 错误码都用统一 `IpcError`（lint 规则）<br>④ UI 文本零术语（`check:no-jargon` 脚本）<br>⑤ sqlite 路径在 `app.getPath('userData')`（单测）<br>⑥ 离线模式 e2e 跑通<br>⑦ macOS dmg 双击安装可启动（CI mac runner） |
| **FAIL 怎么打回** | 写明 "FAIL: <检查项> — <证据> — <期望>" 的结构化失败报告 → orchestrator 把任务退回对应 agent，附 verifier 报告 → worker 修 → 重跑 |
| **不验证** | 业务逻辑正确性（要用户或 PM 拍板） / UI 美观度（要设计 review） / 性能上限（要压测） |

### 5.4 Orchestrator 角色

| 维度 | 内容 |
|---|---|
| **职责** | 拆 plan → 跑 cycle → 决策 NEXT / RETRY / BLOCKED / DONE |
| **plan 拆法** | 按 `docs/design/02-architecture.md` §8.5 的 15 个子任务拆（见本文件 §7 路线图） |
| **cycle 决策** | ① verifier FAIL → 退回对应 agent<br>② worker 报 BLOCKED → orchestrator 决定是给信息（自决） / 问用户（不决）<br>③ 所有 verifier PASS + 用户接受 → DONE |
| **git commit** | orchestrator **统一打 commit**，不放手给 worker（避免并发覆盖） |
| **不决** | 技术栈变更 / API 契约变更 / 设计原则变更 / 里程碑拆解调整 → 推回用户拍板 |

### 5.5 接口契约文件（IPC 单一信息源）

> **唯一信息源**：`src/shared/ipc-types.ts`（由 Zod schema 派生，主/渲染编译时共用）。

| 类别 | 文档 / 文件路径 | 用途 |
|---|---|---|
| **IPC schema（Zod）** | `src/main/ipc/schema.ts` | 后端 agent 定义，TS 类型自动导出到 `src/shared/ipc-types.ts` |
| **IPC TS 类型** | `src/shared/ipc-types.ts` | 前端 agent **只 import，不改**；字段不匹配 → 提 issue 让后端改 |
| **数据模型 ER 图 + DDL** | `docs/design/02-architecture.md` §4 | **13 张表**（users / gitea_accounts / repo_projects / boards / board_columns / cards / gitea_refs / card_links / starred_branches / prefs / undo_entries / cache_entries / hook_deliveries）+ 关系 + Drizzle schema |
| **错误码表** | `docs/design/02-architecture.md` §5.4 + `src/shared/errors.ts` | 10 个业务错误码 + 中文 hint |
| **设计原则（零术语 / 二次确认 / 错误人话）** | `docs/design/02-architecture.md` §2.7 + §7.3 + `design-system/gitea-kanban/OVERRIDE.md` | UI 文案 + 危险操作清单 |
| **IPC 端点清单** | `docs/design/02-architecture.md` §5.3（10 个 namespace × 多 method） | 仓库 / 分支 / commit / PR / 看板 / 卡片 / 鉴权 / 偏好 / 事件 |
| **端点命名约定** | `<namespace>.<method>`（`repos.list` / `board.cards.list` / `auth.connect`） | 由 02-architecture §5.1 落定；**前端 agent 假设的 `资源:动作` 风格已被 02 §5.1 覆盖** |
| **设计系统 token** | `design-system/gitea-kanban/OVERRIDE.md`（**先读 OVERRIDE**，未覆盖字段才回 MASTER） | 主色 `#609926` / 强调 `#f76707` / **v1 单主题暗色（不提供切换）** |

---

## 6. 关键文档索引

| 文档 | 路径 | 用途 |
|---|---|---|
| **设计综述 + 路线图** | `docs/design/00-overview.md` | 用户 review 入口；M0~M3 路线图 |
| **调研** | `docs/design/01-research.md` | gitea 生态 / 竞品 / timeline 方案 / 技术决策 |
| **架构 + 后端** | `docs/design/02-architecture.md` | 主进程模块 / 数据模型 / IPC 契约 / gitea 集成 / 分支合并工作流 / agent 角色 / 非功能性 |
| **前端设计** | `docs/design/03-frontend.md` | 设计原则 / 信息架构 / 页面组件 / 时间轴方案 / 状态管理 / 样式 / 响应式 / wireframe 说明 |
| **静态 wireframe** | `docs/design/wireframe/index.html` | 看板主页（侧栏 + 列 + 卡片 + 抽屉） |
| **静态 wireframe** | `docs/design/wireframe/timeline.html` | 时间轴视图（多泳道 + commit 节点 + 边 + zoom bar） |
| **静态 wireframe** | `docs/design/wireframe/merge.html` | 合并管理页（PR 列表 + 合并确认弹窗） |
| **设计系统（默认）** | `design-system/gitea-kanban/MASTER.md` | ui-ux-pro-max 默认推荐（仅 OVERRIDE 未覆盖时参考） |
| **设计系统（生效）** | `design-system/gitea-kanban/OVERRIDE.md` | **本项目实际 single source of truth** |
| **本文件** | `AGENTS.md` | 所有 agent 的入口 |

> ⚠️ 03-frontend.md §3 假设的 IPC channel 是 `资源:动作` 风格（如 `repo:list` / `card:create`），
> 而 02-architecture.md §5.1 定的是 `<namespace>.<method>` 风格（如 `repos.list` / `board.cards.create`，**不带 `gitea.` 前缀**）。
> **以 02-architecture.md 为准**——前端 agent 实现时按 02 的命名调 IPC。

---

## 7. 工作流约束

### 7.1 必须经过用户确认（不决）

> 这些事 worker agent **不准自决**，必须 escalate 到用户 / orchestrator 推回用户拍板。

1. **改技术栈**：Electron / TS / **Vue 3 / Pinia / Vue Router** / X6 / SQLite / Drizzle 任一变更
2. **改 IPC 契约**：`src/shared/ipc-types.ts` 的字段增删、命名变更
3. **改数据模型**：`docs/design/02-architecture.md` §4 的 **13 张表** schema 变更（users / gitea_accounts / repo_projects / boards / board_columns / cards / gitea_refs / card_links / starred_branches / prefs / undo_entries / cache_entries / hook_deliveries）
4. **改设计原则**：
   - 零术语翻译表（PR→合并请求、rebase→变基等）
   - 危险操作二次确认清单
   - 错误码表
5. **改设计系统 token**：主色 / 强调色 / 字体 / 默认主题
6. **里程碑拆解调整**：M0~M3 边界重新划分
7. **目标用户范围调整**：是否仍含非技术人员
8. **鉴权方式变更**：PAT → OAuth2 或反之
9. **打包目标平台调整**：macOS 不优先 / 移除 Linux
10. **依赖引入重大库**：新加 ORM / 新加 UI 库 / 换构建工具

### 7.2 agent 可以自决（不打扰用户）

- 内部实现细节：函数命名、文件组织、helper 提取
- 测试用例选择：覆盖哪些场景
- 性能优化策略：何时启用 virtualRender、缓存预热
- 错误消息具体措辞（在错误码 + hint 框架内自由发挥）
- 日志字段细化（在结构化字段框架内）
- 组件 props 命名（与 §3 目录树一致即可）
- 第三方库小版本升级（patch / minor 在 CI 通过即可）
- 局部重构（不影响 IPC schema / 数据模型 / 设计 token）

### 7.3 git commit 工作流（用户决策 2026-06-10）

- 阶段交付用 commit 追溯
- **worker agent 不准自己 git commit** —— 所有 commit 由 orchestrator（mavis）统一打
- 原因：避免并发 worker 互相覆盖、保持 commit 历史整洁可追溯
- 每个交付物（一份文档 / 一个模块）打一次 commit，不攒大 commit
- 当前单分支 master；commit 末尾不加 `Co-Authored-By`
- "我写完文件" 不算交付，"我 commit 了 + commit hash" 才算

---

## 8. 常见陷阱与本项目专属注意

> 来自前序 design 任务 + 用户决策沉淀。新 agent 开工前必读。

### 8.1 设计阶段的两条关键修正

1. **技术栈 v1 → v2 修正（2026-06-10）**：原计划是"React Web + Go 后端 + SQLite + nginx 反代"，**被用户改为 Electron + TS 桌面应用 + PAT + keychain**。如果看到 **`docs/design/01-research.md §1.2 / §5.2 / §5.3 / §5.4`** 还在提"Go + Gin + go-sdk" / "OAuth 跳转" / "nginx 反代"，**一律忽略**——以本文件 §2 与 `02-architecture.md §2` 为准（01 §1 头部已显式声明调研报告完成于决策切换前）。
2. **技术栈 v2 → v3 修正（2026-06-10 17:24）**：原计划是 **React 18 渲染层 + Zustand + Radix UI + React Router**，**被用户改为 Vue 3**（团队无 React 积累，Vue 3 在团队内有现成积累）。配套变更：
   - **状态管理**：Zustand → **Pinia**（Vue 官方，setup store 风格与 Composition API 同源）
   - **UI 组件库**：Radix UI Primitives → **Radix Vue**（同一团队，unstyled primitives）；按需 `@headlessui/vue` 补缺
   - **路由**：React Router 6 → **Vue Router 4**（`createWebHashHistory` 适配 Electron file:// 协议）
   - **timeline**：**新增 `@antv/x6-vue-shape` 包**（X6 官方 Vue 桥，注册 Vue 组件为 X6 节点）
   - **图标**：`lucide-react` → **`lucide-vue-next`**（同包名 Vue 版）
   - **测试**：React Testing Library → **`@vue/test-utils` + `@testing-library/vue`**
   - **CSS / 构建 / 数据校验**：保持不变（CSS Modules + Vite + Zod）
   - 任何 agent 开工时看到本节 + 02-architecture §2.2 + 03-frontend §2 + 03-frontend §6 + package.json 的 deps 已统一是 Vue 栈；如遇到历史 commit / 旧文档 / 调研报告残留的 "React" / "Zustand" / "Radix UI" 字样，**一律以本节 + package.json 实际安装的依赖为准**——这是用户拍板过的，不属于"自决"边界。
3. **主题策略 v3 → v4 → v5 修正（2026-06-10）**：
   - v3 草稿（frontend-design attempt=1）曾定"默认暗色 + 不提供切换"
   - v4（attempt=2）按 OVERRIDE 改回"默认浅色 + 暗色可切"
   - **v5（2026-06-10 12:12 用户拍板）**：**v1 单主题暗色、不提供切换**——以 `design-system/gitea-kanban/OVERRIDE.md` §"覆盖决策"表 "背景" 行为准
   - 三次反复的教训：M0 启动前**任何主题策略变更必须经过用户拍板**，worker 不准自由发挥

### 8.2 端到端鉴权铁律（用户决策 #3）

- **token 永远不离开主进程内存**。`auth.connect` 是**唯一**接收 token 的 IPC 入口。
- 渲染进程**永远拿不到明文 token**；通过 `auth.status` 看连接状态。
- keychain 是**唯一** token 落盘位置。**禁止**把 token 写到 SQLite / 文件 / 日志。
- pino `redact` 规则必须在配置里写死，禁止关闭。

### 8.3 零术语 + 二次确认 + 错误人话（用户决策 #2）

- UI 文本**禁止**出现 `PR` / `merge` / `rebase` / `fork` / `issue`（保留）/ `repo` / `branch` / `maintainer` 等原词——全部走翻译表（见 OVERRIDE.md §本项目专属规则 #1）。
- 危险操作（删分支 / 强推 / 合并冲突 / 关闭 PR）**必须**弹二次确认，写明"将影响什么"（见 02 §7.3）。
- 错误提示走统一 `IpcError` 格式（code + message + hint），前端**禁止**直接展示 gitea HTTP 错误原文。
- 跑 `pnpm check:no-jargon` 验证零术语——**没跑过不准 merge**。

### 8.4 X6 回调签名 + attr 处理器（历史踩坑）

- **interacting.* 回调第一参数是 `cellView`（view）**，不是 cell。想拿 cell 用 `view.cell`。
- **view 上没有 `getData()`**。默认事件回调（`graph.on('node:moving', ...)`）第一参数是 `{ cell, view }` 对象，不是 view 本身。
- **attr 处理器只透传注册过的 SVG presentation 属性**（fill / stroke / r / cx / cy / transform 等）。**CSS 属性（cursor / pointer-events 等）不会通过 attrs 写到 DOM**——必须用 CSS 选择器在 styles.css 里覆盖。
- 写回调前先查 X6 官方文档 / TS 类型定义，**别靠"参数名像 cell"想当然**。

### 8.5 离线降级不可省

- 远程 gitea API 失败时**不**直接报 "Network Error"——降级到本地 SQLite 缓存继续显示，状态栏显著提示"当前为离线/缓存模式"并标哪些数据是陈旧的。
- 所有写操作离线时禁用按钮并说明原因。
- v1 默认**不开本地 webhook server**（避免用户开防火墙 / 端口冲突），主进程按周期后台轮询（pulls 30s / commits 2min / branches 5min）。
- v2 才提供"启用本地 webhook server"选项。

### 8.6 Edit 工具替换块不完整会留残段

- `Edit` 工具的 `oldString` 只匹配一段；如果要替换的块大于 `oldString` 匹配范围，替换后**被替换范围外的旧代码会残留在新代码后面**。
- **防御**：
  1. 写 `oldString` 时尽量包整个函数 / 大段
  2. 替换完立刻 `git diff` 看整体，确认没有重复行
  3. 如果发现残段，用 Python 字符串替换（`content.replace(old, new)`）而不是 sed
  4. 跑 `node --check file.js` 验证语法

### 8.7 视觉化语义（如果未来加 visualizer 风格动画）

- 同一条边上的多段动画有**因果顺序**约束（如先收后发）——业务信号放大时间让动画更明显，但**顺序约束不能变**。
- 持续时间是业务信号不是观感调节。

### 8.8 backend agent 越权默认值（plan_9ad2d873 实战教训 · 2026-06-10）

backend 收口后做 §5 越权审计，发现两处 **worker 默认会越界**而 orchestrator 没拦住：

1. **业务表计数越权**：AGENTS.md §5 拍板的"13 张业务表"在 `src/main/cache/schema/index.ts` 实际导出了 **15 张表**——其中 `giteaUser` 是 backend 自己加的"远端用户信息缓存表"（denormalized 缓存，存 user id / login / avatar_url / full_name），用于卡片显示头像不重复打 /users/{id}。**业务实体**只有 13 张，多出的 2 张（giteaUser + index）一个是缓存、一个是聚合导出。
2. **IPC 错误码越权**：AGENTS.md §5.4 拍板"10 个错误码"——backend 在 `src/shared/errors.ts` 加了 `KEYCHAIN_UNAVAILABLE` / `KEYCHAIN_ACCESS_DENIED` 2 个，没问用户。事后看，这俩是 **ADR-0001（2026-06-10）下游项**，是上一轮 ADR commit 时已经写进 §"需更新的下游文件"的，所以"理由上"算有据可查——但**形式上**没经过 §7.1 拍板流程。

**下次 plan 启动前的强制动作**（orchestrator 自查）：

- backend plan owner 启动前**先** grep `src/main/cache/schema/*.ts` 统计 table 数对不对齐 AGENTS.md §5 / 02-architecture §4 的拍板数
- 启动 backend session 时在 prompt 里写明 "**任何新增的 IpcErrorCode / 新增的表 / 新增的 IPC 端点都必须先 escalate orchestrator 推回用户拍板，不要走 §7.2 自决**"
- orchestrator cycle 报告 review 时把"越权审计"列为必查项，不止看 verifier verdict

**给下个 plan 的边界修正**：

- 13 张表是**业务实体表**（有独立业务语义的实体），denormalized 缓存表（giteaUser / cacheEntries / hookDeliveries 这种）算**基础设施表**，**不计入**业务表计数
- 10 个 IpcErrorCode 是 v1 启动时拍板的最小集合，**新增必须经过拍板**——但**理由链 ADR 引用**算"半合规"，plan 收口时在 AGENTS.md §8 加条目登记

### 8.9 跨项目通用：本机 darwin x86_64 的 native 依赖结论需要 arm64 / Linux 复测

- 选型时 darwin x86_64 + Node 25 + pnpm 11.5.2 实测通过，**不代表 arm64 / Linux 通过**（prebuild 覆盖矩阵可能缺平台、musl 链接问题等）
- ADR 必须在 §"未覆盖" / §"待补" 段显式列"待补 5 分钟 smoke test：darwin arm64 / linux x64-gnu / linux x64-musl"
- 下次拿到对应平台机器时优先补测再下结论

### 8.10 Electron sandboxed preload 必须 CJS bundle（V8 加载语义铁律 · 2026-06-11）

- **铁律**：`sandbox: true`（AGENTS §4.7 已定）下，preload 产物**必须** CJS bundle，文件后缀 `.cjs`。
- **错误现象**：V8 加载 `.mjs` 时强制 module 模式，要求 `import/export`；sandboxed preload 跑在 classic-script 上下文，`require` 是 polyfill（参见 [Electron 官方 sandbox 文档](https://www.electronjs.org/docs/latest/tutorial/sandbox#preload-scripts)）。两套加载语义不兼容 → 报 `SyntaxError: Cannot use import statement outside a module`。
- **配置**（`electron.vite.config.ts`）：
  ```ts
  preload: {
    build: {
      rollupOptions: {
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  }
  ```
- **窗口配置**（`src/main/window.ts`）：`preload: join(__dirname, '../preload/index.cjs')` —— 必须与 vite 输出文件名一致。
- **防御**：任何 worker 看到 `.cjs` 想"优化"回 `.mjs` / ESM 都会撞同一个坑。CI 验证路径：`pnpm dev` 看主进程日志 + `out/preload/index.cjs` 实际存在 + `index.mjs` 不存在。
- **跨项目通用**：所有 Electron 沙箱项目（任何用了 `sandbox: true` 的桌面应用）都受此约束——preload 永远是 CJS bundle。

### 8.11 better-sqlite3 electron 42+ prebuilt 等上游 + 双 ABI 循环陷阱（2026-06-11）

- **铁律**：better-sqlite3 12.10.0（2026-05-12 latest）**故意**不发布 electron 42 prebuilt（changelog "Temporarily rollback support for Electron v42 prebuilds"，PR #1470）；12.9.1 标 ⚠️ NOT A VIABLE RELEASE（electron 39+ prebuilds 编译失败）。**结论：better-sqlite3 上游锁了 electron ≤ 35**。
- **当前拍板 electron 41.7.2**（2025-Q4）——能跑 12.10.0 prebuilt (NODE_MODULE_VERSION 145)。
- **等上游修复后的复测动作**：
  1. 跟踪 https://github.com/WiseLibs/better-sqlite3/releases 看 electron 42/43 prebuilt 出现
  2. 出现后开独立 PR 升 electron，跳这步
  3. 不要在本项目里 patch better-sqlite3 上游源码——会冲突
- **双 ABI 循环陷阱**（vitest 跑 node 22 ABI=141，electron 41 要 ABI=145）：
  - `pnpm install` 触发 `postinstall: electron-builder install-app-deps` → 编成 145（electron ABI）
  - 之后 `pnpm test` 跑 vitest → 报 `NODE_MODULE_VERSION 145 vs 141 mismatch`
  - 反之亦然
  - **解决**（package.json scripts 已修）：`test` / `test:watch` / `test:coverage` 全部前置 `pnpm rebuild:native:node` 切回 node ABI；`dev` 不动（postinstall 已经是 electron ABI）
  - **绝对不能**改 postinstall 成 `pnpm rebuild:native:node` —— dev 立即跑不动
  - **绝对不能**直接删 postinstall —— 切到非本机时（如别的开发者）会装错 ABI

---

## 9. 一句话总结

> gitea-kanban = **Electron 桌面应用 + Vue 3/Pinia/X6 渲染进程 + Node 主进程 + SQLite + gitea PAT**。
> 强 git 集成 + 零术语 + 危险操作二次确认 + 离线可读 + 跨平台单二进制。
> 任何修改前先读 `docs/design/00-overview.md` 和 `02-architecture.md`；UI 修改前先读 `design-system/gitea-kanban/OVERRIDE.md`。
