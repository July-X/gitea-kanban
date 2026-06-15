<!-- AGENTS.md — gitea-kanban -->
# AGENTS.md — gitea-kanban (touch v4)

> **本文件给所有 AI coding agent 和开发者读**。它是项目实现的入口规范；如果本文件与仓库里其它文档冲突，**以本文件为准**。
>
> 最后更新：2026-06-13（基于当前实际代码与配置重写）

---

## 1. 项目概述

**gitea-kanban** 是一个**基于 Gitea 的桌面端看板 + 时间轴工具**，技术形态为 **Electron + TypeScript + Vue 3**。

- **核心定位**：把 Gitea 仓库里的 issue、分支、提交、合并请求以可视化方式呈现给团队，让非技术人员也能看懂当前工作流。
- **Source of truth**：Gitea。本地只存用户偏好、缓存和必要的派生数据（localStore + 文件 KV，零 SQLite 依赖）。
- **目标用户**：Gitea 自托管团队，**包含非技术人员**（PM、设计师、市场、运营）。因此 UI 必须零术语、危险操作二次确认、错误提示要说“人话”。
- **当前状态**：项目处于 0→1 实现阶段，单分支 `master` 直推，已有完整主进程 IPC、渲染端路由/视图、本地存储（localStore state.json + 文件 KV 缓存 + queue.jsonl 同步队列）。

---

## 2. 技术栈（实际生效）

> 以下均来自 `package.json`、`electron.vite.config.ts`、`vitest.config.ts` 等真实配置，不是计划文档中的历史草稿。

| 维度 | 选型 | 说明 |
|---|---|---|
| 运行时 | **Electron 41.7.2** + Node 20 LTS | `.nvmrc` 指定 `20` |
| 语言 | **TypeScript 5.7.2** | ESM (`"type": "module"`) |
| 构建 | **electron-vite 5.0.0** | 三端构建：main / preload / renderer |
| 打包 | **electron-builder 26.15.2** | 配置在 `electron-builder.yml` |
| 渲染框架 | **Vue 3.5.35** + Composition API + `<script setup>` | 不是 React |
| 状态管理 | **Pinia 3.0.4** | 不是 Zustand / Vuex |
| 路由 | **Vue Router 4.6.4** | `createWebHashHistory` 适配 Electron file:// |
| UI 组件 | **Radix Vue** + **@headlessui/vue** + 自研组件 | 无 antd / Element Plus |
| 样式 | **CSS Modules + 全局 CSS 变量** | 无 Tailwind；token 在 `src/renderer/styles/theme.css` |
| 时间轴 | **AntV X6 3.1.7** + **@antv/x6-vue-shape** | 图编辑引擎 + Vue 官方桥 |
| 图标 | **lucide-vue-next** | |
| 校验 | **Zod 3.23.8** | IPC 边界强制校验 |
| 本地存储 | **electron-store 11.0.2**（业务态）+ **文件 KV**（Gitea 缓存层，自研 file-store.ts） | 业务态 → localStore.state.json；Gitea 缓存 → cache/<resource>/<projectId>__<key>.json（ADR-0003 完结，零 SQLite 依赖） |
| 同步队列 | **queue.jsonl**（append-only，JSONL） | 离线写 op 持久化（ADR-0003 完结） |
| Gitea 客户端 | **gitea-js 1.23.0** | swagger 生成 TS client（ADR-0002） |
| 密钥存储 | **@napi-rs/keyring 1.3.0** | 替代已归档的 keytar（ADR-0001） |
| 日志 | **pino 9.5.0** + pino-pretty | 主进程唯一日志出口 |
| 测试 | **Vitest 4.1.8** + @vue/test-utils + @testing-library/vue | e2e 计划用 Playwright |
| 包管理 | **pnpm 11.x** | 见 `pnpm-workspace.yaml` |

---

## 3. 目录结构

```
gitea-kanban/
├── AGENTS.md                    # 本文件
├── CLAUDE.md                    # 给 Claude 的快捷摘要（与本文件冲突时以本文件为准）
├── package.json                 # 依赖 + scripts
├── pnpm-lock.yaml               # 锁文件，必须提交
├── pnpm-workspace.yaml          # pnpm 11 workspace + allowBuilds 白名单
├── electron.vite.config.ts      # 三端构建配置
├── electron-builder.yml         # 打包配置
├── tsconfig.json                # 渲染进程 + shared TS 配置
├── tsconfig.node.json           # 主进程 + preload + scripts TS 配置
├── vitest.config.ts             # 测试配置
├── drizzle.config.ts            # Drizzle 迁移配置
├── .eslintrc.cjs                # ESLint 配置
├── .prettierrc                  # Prettier 配置
├── .editorconfig                # 编辑器格式约定
├── .nvmrc                       # Node 20
├── docs/                        # 设计文档 + ADR
│   ├── design/00-overview.md    # 路线图入口
│   ├── design/01-research.md    # 调研（注意：部分历史内容已过时，以本文件为准）
│   ├── design/02-architecture.md # 架构 + IPC 契约 + 数据模型
│   ├── design/03-frontend.md    # 前端设计
│   ├── design/wireframe/        # 静态线框
│   └── adr/                     # 架构决策记录
│       ├── 0001-keychain.md     # @napi-rs/keyring 选型
│       └── 0002-board-data-source-reset.md # board 数据模型 reset
├── design-system/
│   ├── gitea-kanban/MASTER.md   # ui-ux-pro-max 默认推荐（仅 OVERRIDE 未覆盖时参考）
│   ├── gitea-kanban/OVERRIDE.md # **本项目设计系统 single source of truth**
│   └── pages/tech-refine.md     # v1.1/v1.2 科技感精修 token
├── drizzle/                     # 迁移 SQL 文件
├── giteaDemo/                   # 本地 Gitea 演示 docker-compose
├── scripts/                     # 工具脚本
│   ├── check-no-jargon.ts       # 零术语检查
│   └── ...                      # e2e / seed / verify 脚本
├── src/
│   ├── main/                    # 主进程
│   │   ├── index.ts             # 应用入口 / 生命周期 / IPC 注册
│   │   ├── window.ts            # BrowserWindow + CSP
│   │   ├── logger.ts            # pino 日志
│   │   ├── config.ts            # 默认配置
│   │   ├── local/               # localStore（业务态 source of truth，ADR-0003 完结）
│   │   │   ├── store.ts         #   LocalStore 抽象（原子写 + debounce flush + 重试退避）
│   │   │   ├── state.ts         #   顶层 LocalState TS interface + 单例
│   │   │   ├── accounts.ts      #   业务接口：accounts（含 userInfo）
│   │   │   ├── projects.ts      #   业务接口：repo_projects
│   │   │   ├── columns.ts       #   业务接口：board_columns
│   │   │   ├── label-maps.ts    #   业务接口：column_label_mapping
│   │   │   └── starred-branches.ts # 业务接口：starred_branches
│   │   ├── ipc/                 # IPC handler（按 namespace 分文件）
│   │   │   ├── index.ts         # 统一注册入口
│   │   │   ├── schema.ts        # 所有 IPC 的 Zod schema
│   │   │   ├── auth.ts
│   │   │   ├── board.ts
│   │   │   ├── branches.ts
│   │   │   ├── clipboard.ts
│   │   │   ├── commits.ts
│   │   │   ├── issues.ts
│   │   │   ├── labels.ts
│   │   │   ├── members.ts
│   │   │   ├── preferences.ts
│   │   │   ├── pulls.ts
│   │   │   ├── repos.ts
│   │   │   └── user.ts
│   │   ├── gitea/               # Gitea 集成层
│   │   │   ├── client.ts        # gitea-js client 工厂 + HTTP 错误映射
│   │   │   ├── auth.ts          # PAT 校验 + keychain 读写
│   │   │   ├── keychain.ts      # @napi-rs/keyring 封装
│   │   │   ├── repos.ts / branches.ts / commits.ts / pulls.ts / issues.ts / labels.ts
│   │   │   └── ...
│   │   ├── cache/               # Gitea 缓存层（文件 KV，file-store.ts）
│   │   │   ├── file-store.ts    # 文件 KV + TTL + LRU GC（替代 SQLite cache_entries）
│   │   │   └── ...              # 各资源 cache-aside / TTL（repos / branches / commits / pulls / timeline）
│   │   └── board/               # 看板业务逻辑（列 / 卡片移动）
│   ├── preload/                 # preload 桥
│   │   ├── index.ts             # contextBridge.exposeInMainWorld('api', api)
│   │   └── api.d.ts             # window.api 类型声明
│   ├── renderer/                # 渲染进程
│   │   ├── index.html
│   │   ├── main.ts              # Vue 3 入口
│   │   ├── App.vue              # 根 SFC
│   │   ├── routes/index.ts      # Vue Router
│   │   ├── components/          # 通用组件（AppShell / NavRail / StatusBar / Toast / ConfirmDialog ...）
│   │   ├── views/               # 路由级页面
│   │   ├── stores/              # Pinia store
│   │   ├── lib/                 # 工具（ipc-client / toast / command-palette / confirm ...）
│   │   └── styles/              # 全局样式（theme.css / reset.css）
│   └── shared/                  # 主/渲染共享
│       ├── constants.ts         # 常量（APP_NAME / CACHE_TTL / POLL_INTERVALS_MS ...）
│       ├── errors.ts            # IpcError 统一错误格式 + 错误码
│       └── ipc-channels.ts      # IPC channel 名常量（zod-free）
└── out/                         # electron-vite 构建产物（main / preload / renderer）
```

---

## 4. 构建与开发命令

全部命令来自 `package.json`：

```bash
# 开发（启动 electron-vite dev server + Electron）
pnpm dev

# 三端构建（main / preload / renderer）
pnpm build

# 预览生产构建
pnpm preview

# 类型检查（主进程 + 渲染进程）
pnpm type-check
pnpm type-check:main
pnpm type-check:renderer

# 测试
pnpm test              # vitest run
pnpm test:watch        # vitest watch
pnpm test:coverage     # vitest run --coverage

# 代码质量
pnpm lint
pnpm lint:fix
pnpm format            # prettier --write "src/**/*.{ts,tsx,json,css,md}"
pnpm format:check
pnpm check:no-jargon   # 零术语检查（**没跑过不准 merge**）
```

### 本地开发首次 setup
1. `nvm use` 或保证 Node >= 20
2. `pnpm install`（ADR-0003 完结后无 native binding 需求，postinstall 已移除）
3. 如需本地 Gitea：`cd giteaDemo && docker compose up -d`
4. `pnpm dev`

---

## 5. 代码风格与规范

### 5.1 格式化

- **Prettier** 配置在 `.prettierrc`：
  - `semi: true`
  - `singleQuote: true`
  - `trailingComma: all`
  - `printWidth: 100`
  - `tabWidth: 2`
  - `endOfLine: lf`
- 运行 `pnpm format` 只格式化修改过的文件所属集合，**不要全量格式化**以避免污染 diff。
- `.editorconfig` 与 Prettier 一致：utf-8 / lf / 2 space。

### 5.2 Lint

- ESLint 配置在 `.eslintrc.cjs`：
  - 基础：`eslint:recommended` + `@typescript-eslint/recommended`
  - 强制 `consistent-type-imports`（`type` import 优先）
  - `eqeqeq: ['error', 'smart']`
  - `no-console` 关闭（开发期保留 console，主进程用 pino）
- 忽略 `out/` / `dist/` / `drizzle/` / `coverage/` / `*.cjs` / `*.config.{js,ts}`。

### 5.3 TypeScript

- 严格模式全开：`strict: true` / `noImplicitAny: true` / `noUnusedLocals: true` / `noUnusedParameters: true`
- 路径别名：
  - 主进程：`@main/*` → `src/main/*`
  - 共享：`@shared/*` → `src/shared/*`
  - 渲染端：`@renderer/*` → `src/renderer/*`
- `verbatimModuleSyntax: false`，但 ESLint 强制 type import。

### 5.4 注释与命名

- 关键业务逻辑、安全边界、历史踩坑必须写中文注释。
- IPC 端点命名：**`<namespace>.<method>`**，例如 `repos.list`、`board.columns.list`、`issues.moveColumn`。
- 不要混用旧版“资源:动作”风格（如 `repo:list`）。

### 5.5 Commit Message

- **必须中文**。
- Type 限定：`feat / fix / refactor / perf / chore / test / docs / style`。
- 格式：`<type>: <中文一句话描述>`。
- 每个阶段性交付打一次 commit，不攒大 commit。
- 末尾不加 `Co-Authored-By`。
- 当前单分支 `master`。

---

## 6. 架构要点

### 6.1 Electron 三端构建

`electron.vite.config.ts` 配置：

- **main**：入口 `src/main/index.ts`，产物 `out/main/index.js`；`externalizeDeps: true`。
- **preload**：入口 `src/preload/index.ts`，产物 `out/preload/index.cjs`；**必须 CJS bundle**（sandboxed preload 不支持 ESM），`externalizeDeps: false` 全部内联。
- **renderer**：根 `src/renderer/`，入口 `src/renderer/index.html`，产物 `out/renderer/`。

### 6.2 IPC 契约

- **唯一信息源**：
  - channel 常量：`src/shared/ipc-channels.ts`
  - Zod schema：`src/main/ipc/schema.ts`
  - 错误码：`src/shared/errors.ts`
- 当前共 **44 个 IPC 端点**：
  - `auth` × 3、`repos` × 3、`branches` × 5、`commits` × 3、`pulls` × 4
  - `board.columns` × 7、`issues` × 7 + `issues.comment` × 2、`labels` × 2
  - `members` × 1、`user` × 4、`preferences.theme` × 2、`preferences.clipboard` × 1
- 渲染端通过 `window.api` 调用；`src/preload/index.ts` 暴露 API，`src/preload/api.d.ts` 导出类型。
- 加新 namespace 时：在 `schema.ts` 定义 schema → 在 `ipc/<namespace>.ts` 写 handler → 在 `ipc/index.ts` 注册 → 在 `preload/index.ts` 暴露。

### 6.3 数据模型

**v1.2 现状（ADR-0003 完结：零 SQLite 依赖）**：

业务态 7 张表（**全部**在 localStore.state.json）：
- `users`（1 行 seed `local-user`）
- `gitea_accounts` + `gitea_user` denormalize 进 `accounts[]` + `accounts[].userInfo`
- `repo_projects` → `projects[]`
- `board_columns` → `columns[]`
- `column_label_mapping` → `labelMaps[]`
- `starred_branches` → `starredBranches[]`
- `prefs` → `prefs` (Record<string, unknown>)

Gitea 缓存层（文件 KV，自研 `src/main/cache/file-store.ts`）：
- 5 个 resource（repos / branches / commits / pulls / timeline）→ `cache/<resource>/<projectId>__<key>.json`
- TTL 按 mtime 算；启动期 LRU GC（50 MB 预算）；原子写（tmp + rename）

> **2026-06-15 ADR-0003 真正完结**：三阶段 + Phase 3b 全部落地
> - **Phase 1**：localStore 基础设施 + prefs 双写 + 一致性巡检（commit `8ffa951`）
> - **Phase 2**：业务表全走 localStore 读 + 5 个 commit 切读路径（`79f761d`~`d214a0e`）
> - **Phase 3**：写 op dispatch 统一入口 + 同步队列 + 删 drizzle-kit + 删 8 张业务表 schema（`93e9659`~`372017e`）
> - **Phase 3b**：Gitea 缓存层从 SQLite 切文件 KV + 删 SQLite 链路本体（`sqlite.ts` + `cache/schema/` + `better-sqlite3`/`drizzle-orm` 依赖 + native rebuild 工具链，commit `5bae978`）
>
> 净效果：零 SQLite 依赖，包体减 200+ MB，Electron 升级不再需要 rebuild native binding。
>
> 详见 `docs/adr/0003-local-store-electron-store.md`。

核心设计：
- **看板列**是 gitea-kanban 本地概念，存 `localStore.state.columns[]`。
- **卡片 = Gitea issue**，本地不存卡片实体，通过 `state.labelMaps` 把列映射到 Gitea label；issue 带这个 label 就属于该列。
- **本地业务态** = `state.json`（`src/main/local/state.ts`）；崩恢复靠 localStore.atomic write。
- **Gitea 缓存层** = `${DATA_DIR}/cache/<resource>/`（`src/main/cache/file-store.ts`，cache-aside 模式）。
- **同步队列** = `${DATA_DIR}/queue.jsonl`（`src/main/sync/queue.ts` + `runner.ts`）—— append-only + 崩恢复 + 30 天 GC。

### 6.4 Gitea 集成

- 使用 `gitea-js` 包装 Gitea API（ADR-0002）。
- client 按 `(giteaUrl, username)` 缓存；token 临时从 keychain 读，5 分钟内存缓存。
- HTTP 错误在 `src/main/gitea/client.ts` 统一映射为 `IpcError`。

### 6.5 主题系统

- **v1.2 拍板**：**2 主题切换**（dark / light），默认 dark。
  - dark 基底 `#0F1115`（中性近黑），主色 token `#74B830`
  - light 基底 `#E8F1F5`，主色 token `#466B16`
- 持久化走 localStore `prefs` 子键；IPC 端点 `preferences.theme.get` / `preferences.theme.set`。
- 启动期 0 闪烁：由 `src/renderer/index.html` 内联 script 先读 `localStorage`，再由 `useUiStore().initTheme()` 与后端 reconcile。
- 切换入口 3 处：StatusBar cycle 按钮 / 设置页“外观” / 命令面板 ⌘K。

---

## 7. 测试策略

### 7.1 单元测试

- 配置：`vitest.config.ts`
- 默认环境：`node`。
- 覆盖目标（`coverage.thresholds`）：
  - lines / statements / functions：70%
  - branches：65%
- 当前项目自有测试文件：`src/main/ipc/__tests__/isoDateSchema.test.ts`。
- 运行：`pnpm test`

### 7.2 渲染端组件测试

- 工具：Vitest + @vue/test-utils + @testing-library/vue。
- 如需 DOM，在测试文件顶部加 `// @vitest-environment happy-dom`。
- 当前前端任务 0 不引入新依赖，DOM 测试用最小 stub 规避。

### 7.3 E2E

- 计划用 Playwright + Electron。
- 关键路径必须覆盖：首次接入、无效 token、看板拖拽换列、时间轴渲染、合并请求、离线模式、危险操作二次确认、主题切换、安装启动。
- 相关脚本在 `scripts/e2e-verify-*.ts`。

### 7.4 其他验证

- `pnpm type-check` 必须无 error。
- `pnpm lint` 通过。
- `pnpm check:no-jargon` 通过（**强制**）。

---

## 8. 安全与运维

### 8.1 鉴权铁律

- **token 永远不离开主进程内存**。
- `auth.connect` 是**唯一**接收 token 的 IPC 入口。
- token 通过 `@napi-rs/keyring` 存系统 keychain；**绝不**存到文件（生产）/ 日志 / localStorage。
- 渲染进程永远拿不到明文 token，只能看连接状态。
- pino `redact` 规则写死，禁止把 `token` / `password` / `key` 等写入日志。

### 8.2 数据与日志路径

- 数据根目录优先级：
  1. 环境变量 `GITEA_KANBAN_DATA_DIR`（必须是绝对路径）
  2. 兜底 `~/.gitea-kanban`
- 业务态：`${dataRoot}/state.json`（localStore，electron-store 序列化）
- Gitea 缓存：`${dataRoot}/cache/<resource>/<projectId>__<key>.json`（file-store.ts）
- 同步队列：`${dataRoot}/queue.jsonl`
- 日志目录：`${dataRoot}/logs/main/main-YYYY-MM-DD.log`
- 保留 14 天。
- 开发模式如遇 macOS SIP 写权限问题，会 fallback 到 `/tmp/gitea-kanban`。

### 8.3 BrowserWindow 安全

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`（仅生产；开发模式临时关闭以避免 sandbox helper 签名问题）
- CSP 通过 `webRequest.onHeadersReceived` 注入；生产按 `giteaUrl` 动态加白名单。
- 拦截外链和任意导航，外部 http(s) 走系统浏览器。

### 8.4 输入与路径安全

- 主进程不接受用户提供的绝对路径。
- 文件 I/O 走白名单：`app.getPath('userData')` 或 `GITEA_KANBAN_DATA_DIR`。
- 禁止 `v-html`，除非是明确审核过的 sanitize 场景。

### 8.5 沙箱与 preload

- preload 产物必须是 CJS（`.cjs`），不能改 ESM。
- preload 不 externalize 依赖，全部静态 bundle。
- `gitea-js`、数据库操作、keychain 操作**只能**在主进程使用，preload / 渲染端不直接引用。

### 8.6 开发模式特殊处理

`src/main/index.ts` 与 `src/main/window.ts` 中有明确的 dev-only 逻辑：
- 启用 remote debugging 端口 `9492`（可用 `GITEA_KANBAN_DISABLE_REMOTE_DEBUG=1` 关闭）
- 关闭 Chromium sandbox
- userData 改到 `/tmp/gitea-kanban-dev`
- 单实例锁默认跳过（可用 `GITEA_KANBAN_SKIP_SINGLETON=0` 强制启用）

### 8.7 启动调试与 CDP 排查（**重要踩坑沉淀**）

`pnpm dev` 或 `pnpm preview` 跑不起来时，按以下顺序排查。**不要**凭直觉去看 stdout——日志在文件里。

#### 8.7.1 日志位置

主进程 pino logger 在 dev / preview 模式（`isDev = !app.isPackaged`，`electron-vite preview` 跑的是 out/main/index.js，`isPackaged=false`）走**文件 transport**：

```
${GITEA_KANBAN_DATA_DIR}/logs/main/main-YYYY-MM-DD.log
```

默认 `~/.gitea-kanban/logs/main/main-YYYY-MM-DD.log`（dev 模式 userData 改为 `/tmp/gitea-kanban-dev`，但日志目录仍走 `GITEA_KANBAN_DATA_DIR`）。

**stdout 不会输出 pino 日志**——这是 2026-06-14 启动排查时踩的坑：用 `tee /tmp/electron-preview.log` 看不到任何 pino 行，以为主进程没进 ready 块，事实是 logger 早就写了文件。

排查启动问题**第一件事**：

```bash
# 设独立 data dir 避免污染真实数据
export GITEA_KANBAN_DATA_DIR=/tmp/gitea-kanban-debug
rm -rf "$GITEA_KANBAN_DATA_DIR"
pnpm preview   # 或 pnpm dev
# 看日志
ls "$GITEA_KANBAN_DATA_DIR/logs/main/"
tail -50 "$GITEA_KANBAN_DATA_DIR/logs/main/main-"*.log
```

#### 8.7.2 主进程崩溃常见原因（按出现频率排序）

1. **CSP 拒绝加载渲染端**（`THEME_BOOTSTRAP_SCRIPT_HASH` 不匹配）—— `src/renderer/index.html` 的 theme bootstrap inline script 改了但 `src/main/window.ts` line 71 的 hash 没同步
2. **`app.setPath('userData', ...)` 写入受限**（macOS SIP）—— dev 模式已 hard-code `/tmp/gitea-kanban-dev`；如自定义路径走 `GITEA_KANBAN_DATA_DIR`
3. **electron-store 11 + ajv schema 校验失败** —— 不传 schema 即可关闭（本项目 localStore 已关闭 ajv，校验走 Zod）
4. **state.json 损坏 / 缺失** —— localStore 启动期文件缺失会初始化默认值（不抛）；JSON 损坏会抛，删 `state.json` 重启即可恢复（业务态可从 Gitea 重建）

#### 8.7.3 CDP 远程调试连接

dev / preview 模式默认开远程调试端口 9492。连接方式：

```bash
# 1. 后台跑 dev / preview
pnpm dev  # 或 pnpm preview

# 2. 确认端口在听
lsof -iTCP:9492  # macOS / Linux
# 或
curl -s http://127.0.0.1:9492/json/version
# 返 {"Browser":"..."} 即活

# 3. 通过 chrome-devtools-mcp 连（VS Code / Cursor）
# MCP 配置里 browserUrl 设 http://127.0.0.1:9492

# 4. 直接 curl 拿 DevTools 目标列表
curl -s http://127.0.0.1:9492/json/list
# 返 Array<{ id, title, url, ... }>，每个就是 Renderer 进程

# 5. 拿到 webSocketDebuggerUrl 直接 attach
# 例：ws://127.0.0.1:9492/devtools/page/<id>
```

#### 8.7.4 常见误区

- **不要用 `tee` 抓 pino 日志**——logger 走 file transport，tee 看不到
- **不要用 `timeout 10 electron .`**——macOS 容器没 `timeout` 命令；用 `&` 后台 + `kill`
- **不要把 `lsof` 当成检查进程的标准**——容器里 `ps` 可能被禁；用 `/proc/<pid>` 或 `lsof -iTCP:9492` 反查端口
- **不要用 `pgrep -f electron` 杀进程**——会误杀 chrome-devtools-mcp 自身；用 `pkill -9 -f "gitea-kanban" || pkill -9 -f "out/main"`
- **preview 模式 `app.isPackaged` 是 false**（因为 out/main 是 unbundled），所以 logger 走 isDev 分支（写文件）；不是 bug

#### 8.7.5 完整端到端调试模板

```bash
# 1. 清环境
pkill -9 -f "gitea-kanban" 2>/dev/null || true
pkill -9 -f "out/main" 2>/dev/null || true
rm -rf /tmp/gitea-kanban-debug
mkdir -p /tmp/gitea-kanban-debug

# 2. 跑（后台 + 拉 CDP）
GITEA_KANBAN_DATA_DIR=/tmp/gitea-kanban-debug \
  ELECTRON_ENABLE_LOGGING=1 \
  node_modules/.bin/electron out/main/index.js \
  > /tmp/electron-stdout.log 2>&1 &
echo "pid=$!"

# 3. 等 8 秒（vite 编译在 preview 模式省了；纯跑产物）
sleep 8

# 4. 三路看
echo "--- 1. CDP 端口 ---"
lsof -iTCP:9492 2>&1 | head -3
echo "--- 2. 主进程日志（pino file transport）---"
tail -40 /tmp/gitea-kanban-debug/logs/main/main-*.log 2>&1
echo "--- 3. stdout/stderr（Electron 自身输出）---"
tail -20 /tmp/electron-stdout.log
```

诊断矩阵：
- 1 没东西 + 2 有 `failed during app ready` + 3 啥都没 → 主进程在 `app.on('ready')` 块内崩（看 2 找根因）
- 1 没东西 + 2 没东西 + 3 啥都没 → pino file transport 没启（异常环境，logger 退化 silent）；改用 `pino.destination(1)` 强制 stdout
- 1 活着 + 2 显示 createMainWindow done + 3 没东西 → 渲染端**没崩**，可能 IPC 异常；走 CDP 抓 console
- 1 活着 + 3 有 `Renderer process gone` → 渲染端崩（preload 错 / CSP 拦 / IPC schema 错），用 CDP attach 抓 console

---

## 9. 关键产品约束

### 9.1 零术语

UI 文本禁止直接出现以下原词，必须走翻译表：

| 原词 | 中文 |
|---|---|
| PR | 合并请求 |
| merge | 合并 |
| rebase | 变基 |
| fork | 派生 |
| repo | 仓库 |
| branch | 分支 |
| maintainer | 维护者 |
| issue | 议题（或保留 Issue，gitea 自身保留） |

运行 `pnpm check:no-jargon` 验证。

### 9.2 危险操作二次确认

以下操作必须弹窗二次确认，并用人话说明后果：
- 删分支
- 强推 / 强制推送
- 合并冲突解决
- 关闭合并请求
- 合并到主线分支

### 9.3 错误提示“人话”

- 统一走 `IpcError`：`code + message + hint`。
- 渲染端 `src/renderer/lib/ipc-client.ts` 把错误码转成本地化中文类别前缀 + 建议。
- 不暴露内部 stack trace 给最终用户。

### 9.4 离线降级

- 远程 Gitea API 失败时降级到本地文件缓存，状态栏显著提示"离线/缓存模式"。
- 写操作离线时禁用按钮并说明原因。
- v1 默认不开本地 webhook server，后台轮询周期：pull 30s / commit 2min / branch 5min。

---

## 10. 常见陷阱与专属注意

1. **IPC 端点命名**：用 `<namespace>.<method>`，不是 `资源:动作`。`board.columns.*` 是嵌套 namespace，渲染端用 `invokeNested`。
2. **preload 产物格式**：必须是 `out/preload/index.cjs`（CJS）。改成 `.mjs` 会在 sandboxed preload 启动时失败。
3. **CSP hash 同步**：`src/renderer/index.html` 里的主题 bootstrap inline script 修改后，必须同步更新 `src/main/window.ts` 里的 `THEME_BOOTSTRAP_SCRIPT_HASH`。
4. **keychain dev fallback**：开发模式因 macOS sandbox 限制，token 会 fallback 写到 `userData/dev-tokens/*.json`（0600）；生产仍走系统 keychain。
5. **@napi-rs/keyring 平台包**：`package.json` 的 `optionalDependencies` 已显式列出 7 个目标平台包；不要删除。
6. **pnpm 11 allowBuilds**：`pnpm-workspace.yaml` 里 `allowBuilds` 控制原生 build；当前 `electron`、`esbuild` 等需要 true（ADR-0003 完结后无 better-sqlite3）。
7. **X6 回调签名**：`interacting.*` 回调第一参数是 `cellView`，默认事件回调第一参数是 `{ cell, view }`；不要想当然用 `getData()`。
8. **Edit 工具残段**：StrReplaceFile 的 `oldString` 尽量包整个函数或大段；替换后 `git diff` 确认无重复行。
9. **不要跨边界**：渲染端不写 `src/main/**`、不改 `src/shared/ipc-types.ts`；主进程不写 Vue 组件 / CSS。
10. **启动排查 + CDP 调试**：详见 §8.7。**关键提醒**：(a) pino 在 dev/preview 模式走 file transport 不是 stdout，tee 看不到；(b) CDP 远程调试端口 9492 在 dev / preview 模式自动开，连接用 `http://127.0.0.1:9492/json/list` 拿 Renderer 列表。

---

## 11. 关键文档索引

| 文档 | 路径 | 用途 |
|---|---|---|
| 设计综述 + 路线图 | `docs/design/00-overview.md` | 用户 review 入口 |
| 架构 + 后端设计 | `docs/design/02-architecture.md` | IPC 契约、数据模型、Gitea 集成 |
| 前端设计 | `docs/design/03-frontend.md` | UI/UX、路由、状态管理 |
| keychain 选型 | `docs/adr/0001-keychain.md` | 为什么用 @napi-rs/keyring |
| board 数据模型 reset | `docs/adr/0002-board-data-source-reset.md` | 为什么卡片 = Gitea issue |
| **本地存储迁移 + 同步队列** | `docs/adr/0003-local-store-electron-store.md` | **ADR-0003（已完结）**：SQLite → electron-store + 文件 KV + queue.jsonl；零 SQLite 依赖 |
| 设计系统（生效） | `design-system/gitea-kanban/OVERRIDE.md` | 颜色、字体、零术语、二次确认 |
| 科技感精修 token | `design-system/pages/tech-refine.md` | v1.1/v1.2 具体 token |
| 本文件 | `AGENTS.md` | agent 入口规范 |

---

## 12. Agent 角色边界（参考）

> 项目使用 mavis team plan 时的角色分工。单人开发时也可作为代码组织参考。

- **后端 agent**：负责 `src/main/**`、`src/preload/**`、`src/shared/*`、`drizzle/**`、打包配置。
- **前端 agent**：负责 `src/renderer/**`、wireframe、组件库；不碰主进程 / IPC schema。
- **verifier**：独立验证 `ipcMain.handle` 数与 `window.api` 暴露数、零术语、错误码统一性、数据路径、e2e、打包安装。
- **orchestrator**：拆 plan、跑 cycle、统一 git commit。

---

## 13. 不决事项（必须推给用户拍板）

以下变更不准 agent 自决：
1. 改技术栈（Electron / TS / Vue 3 / Pinia / X6 / electron-store 任一变更）
2. 改 IPC 契约（`src/shared/ipc-types.ts` 或 `schema.ts` 字段增删 / 命名变更）
3. 改数据模型（localStore state 结构 / 文件缓存 resource 增删改）
4. 改设计原则（零术语表、危险操作清单、错误码表）
5. 改设计系统 token（主色 / 强调色 / 字体 / 默认主题）
6. 改鉴权方式（PAT → OAuth2 等）
7. 改打包目标平台
8. 引入重大新依赖

---

> **记住**：本文件是活的规范。当你修改了技术栈、构建流程、安全边界、目录结构或关键约定时，必须同步更新本文件。
