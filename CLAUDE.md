# CLAUDE.md — gitea-kanban

> 这是给 Claude 的工作指引版摘要。若与 `AGENTS.md` 冲突，以 `AGENTS.md` 为准。

## 项目一句话

`gitea-kanban` 是一个基于 Gitea 的桌面端看板 + 时间轴工具，技术栈固定为 Electron + TypeScript + Vue 3 + Pinia + Vue Router + X6 + SQLite。

目标用户包含非技术人员，所以 UI 必须零术语、危险操作二次确认、错误提示要人话。

## 固定技术栈

- 运行时：Electron + Node 20 LTS
- 语言：TypeScript 5.x
- 构建：electron-vite
- 打包：electron-builder
- 渲染进程：Vue 3 + Vite + Pinia + Vue Router 4
- UI：Radix Vue + @headlessui/vue
- 图形 / 时间轴：AntV X6 + @antv/x6-vue-shape
- 校验：Zod
- 本地库：better-sqlite3 + Drizzle ORM + drizzle-kit
- Git 集成：simple-git 仅用于高阶场景
- 密钥：keytar
- 日志：pino

## 关键产品约束

- Gitea 是 source of truth，本地只存偏好、缓存和必要的派生数据
- 不做 OAuth2，不做 nginx 反代，不做实时协作，不做 in-app 冲突解决
- token 只允许在主进程内存和系统 keychain 中存在，不能写文件、SQLite、日志、localStorage
- UI 文本禁止直接出现 `PR`、`merge`、`rebase`、`fork`、`repo`、`branch`、`maintainer` 等原词，必须走项目翻译表
- 危险操作必须二次确认，并说明影响
- 离线时要降级到本地缓存，不能直接给生硬的网络错误
- 主题策略按当前拍板的三主题方案执行，不要自行改回单主题或重新设计

## 目录边界

- `src/main/**`：主进程
- `src/preload/**`：preload 桥
- `src/shared/**`：主渲染共享类型与常量
- `src/renderer/**`：渲染进程
- `docs/design/**`：设计文档
- `design-system/gitea-kanban/OVERRIDE.md`：当前生效设计系统

不要跨边界写代码：

- 不要在渲染进程里直接调 Gitea API
- 不要在前端改 `src/shared/ipc-types.ts`
- 不要在主进程里写 Vue 组件或 CSS

## IPC 和数据模型

- IPC 命名以 `<namespace>.<method>` 为准，例如 `repos.list`、`auth.connect`
- `src/shared/ipc-types.ts` 是前后端共享契约，前端只消费，不修改
- Gitea 的 projects REST API 不可依赖
- 看板列是本地 SQLite 实体
- 卡片对应 Gitea issue
- 列和卡片的关联通过 label 映射

## 存储路径

- SQLite 数据目录统一走 `GITEA_KANBAN_DATA_DIR`，否则回退到 `~/.gitea-kanban`
- 日志目录跟数据目录同根，走 `.../logs/main`
- 不要回到 `app.getPath('userData')` 或 `app.getPath('logs')`

## 安全与日志

- 渲染进程默认 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`
- 禁止 `v-html`，除非是明确审核过的 sanitize 场景
- 主进程文件 I/O 走白名单，不接受用户绝对路径作为任意输入
- pino 必须 redact token / password / key

## 测试与验证

- 主进程：Vitest
- 渲染进程：Vitest + @vue/test-utils + @testing-library/vue
- E2E：Playwright + electron
- 关键路径必须覆盖：首次接入、无效 token、拖拽换列、时间轴、离线模式、危险操作确认、暗色/主题切换、安装启动

## 工作方式

- 修改前先看相关代码和设计文档，优先用代码图谱工具理解调用链
- 做架构 / 依赖 / IPC / 数据模型变更前，先确认是否属于必须征求用户拍板的范围
- 小改动可以直接做；技术栈、IPC 契约、数据模型、设计原则、设计 token、鉴权方式等不要擅自变更

## Claude 工具建议

- 查库 / 框架 / API 文档：优先用 Context7
- 查代码调用关系、影响范围：优先用 CodeGraph
- 查 literal 文本、日志字符串：再用 rg

## 常用文档入口

- `docs/design/00-overview.md`
- `docs/design/01-research.md`
- `docs/design/02-architecture.md`
- `docs/design/03-frontend.md`
- `design-system/gitea-kanban/OVERRIDE.md`

## 提交规范

- commit message 必须中文
- 格式：`<type>: <中文一句话描述>`
- type 只用 `feat / fix / refactor / perf / chore / test / docs / style`
- 阶段性交付要有 commit 和 hash
- 不要加 `Co-Authored-By`
- 当前单分支 `master`

## 启动调试与 CDP（详见 AGENTS.md §8.7）

启动问题**第一件事**去看 `${GITEA_KANBAN_DATA_DIR}/logs/main/main-*.log`——pino 在 dev/preview 走 file transport，**stdout 没有**。常见根因：better-sqlite3 ABI 141/145 不匹配（`pnpm install --ignore-scripts` 跳过 rebuild-native.sh）。CDP 远程调试端口 9492 在 dev/preview 自动开，用 `http://127.0.0.1:9492/json/list` 拿 Renderer 列表。

## 实际工作提醒

- 任何开始前，先确认当前上下文是否已经有相关实现或历史决策
- 遇到不确定的库、框架、CLI、SDK，用官方文档确认，不要凭记忆
- 如果要改 UI，优先保持本项目已有的设计系统和零术语规则
