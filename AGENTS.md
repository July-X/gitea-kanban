<!-- AGENTS.md — gitea-kanban -->
# AGENTS.md — gitea-kanban (v2.0 → v0.5.0-m9)

> **本文件给所有 AI coding agent 和开发者读**。它是项目实现的入口规范；如果本文件与仓库里其它文档冲突，**以本文件为准**。
>
> 最后更新：2026-07-01（**v2.0 重大迁移** + **v2.4 迭代收尾** + **v2.5 workspace 按账号分层** + **v2.6 同步进度条** + **v3.0–v3.14 Git Graph 严格 1:1 复刻 vscode-git-graph** + **v0.3.0 UNCOMMITTED lane 1:1 对齐** + **v0.5.0-m9 M9 里程碑**）
>
> - **v2.0** (2026-06-22)：Electron+TypeScript+Vue → Go+Wails+Vue 3；单平台 Gitea → 多平台 Gitea+GitHub；前端保留 Vue 3，git 客户端改用 go-git；旧代码归档到 `legacy/electron/`。详见 [ADR-0005](./docs/adr/0005-electron-to-go-wails-migration.md)
> - **v2.4** (2026-06-22)：迁移完成后真实用户桌面跑暴露 6 类问题（鉴权铁律 / 业务 binding stub / 数据目录嵌套 / StatusBar localPath 拼错 / prefs 死链 / go-git 拉全 worktree），全部修复并记录在 [ADR-0006](./docs/adr/0006-v24-iteration-fixes.md) + [07-v24-iteration.md](./docs/design/07-v24-iteration.md)。关键：所有 binding 接受 `projectId` / `owner+repo` 业务态概念，Go 端反查 `localPath + token`；go-git 走 `NoCheckout=true` 轻量模式（磁盘 -99%）；prefs 走 IPC + localStorage 双源持久化
> - **v2.5** (2026-06-22)：workspace 按账号分层。`${dataDir}/workspace/repos/${owner}__${repo}/` → `${dataDir}/workspace/repos/${username}/${owner}__${repo}/`。多账号场景避免同名 username 在不同平台撞目录；启动期**自动迁移**旧数据，备份保留到 `${dataDir}/workspace/_pre_v25_workspace`。详见 [ADR-0007](./docs/adr/0007-workspace-account-scoped.md) + §6.4 + §6.5
> - **v2.6** (2026-06-25)：StatusBar 仓库行同步进度条。`go-git sideband.Progress` → Go 端 `SidebandWriter` → `wailsruntime.EventsEmit("git:sync:progress")` → 前端 `wails-api-shim.on()` → repo store `progressByRepo` → StatusBar 行内 2px 进度条。详见 [memory: gitea-kanban-v26-sync-progress-bar](../../.reasonix/projects/-Users-zhongxingxing-2026-code-gitea-kanban/memory/gitea-kanban-v26-sync-progress-bar.md)
> - **v3.0–v3.14** (2026-06-26 ~ 2026-06-30)：Git Graph 严格 1:1 复刻 vscode-git-graph，丢弃 v2.x 历史包袱。关键 commit `71a43f3 refactor(gitgraph): v3.0 严格 1:1 复刻 vscode-git-graph，丢弃 v2.x 历史包袱`。包含：v3.1-v3.3 列宽拖动 / [60,715] clamp、v3.10-v3.14 dot hover + ref badge + lane 色软底、SVG S 曲线、SourceTree 风格栅格栏、表头中文、author date 替代 committer date、blobless clone 下 (+N | -N) 0 修复等
> - **v0.3.0** (2026-07-01)：UNCOMMITTED lane 1:1 对齐 vscode-git-graph，`git status --porcelain` 直采。详见 `git tag v0.3.0` 注释 + commit `24066b5 fix(gitgraph): UNCOMMITTED 检测改用 git status --porcelain, 1:1 复刻 vscode-git-graph`
> - **v0.5.0-m9** (2026-07-01)：M9 里程碑。TimelineView 防抖 composable 抽离 + schema regression 守 M5 fix-1 + W3 e2e helper 计数语义修正。4 件套全 EXIT=0，W3 known-issue 3→0，vitest 68 tests PASS
>
> **历史快照**：v1 时代的 Electron 文档已移入 `legacy/electron/` 仅供参考，**不再构建、不再维护**。
>
> **过期文档警示**（避免后续 agent 误信）：
> - `docs/adr/0001-keychain.md` — SUPERSEDED by ADR-0005（已加横幅）
> - `docs/adr/0003-local-store-electron-store.md` — SUPERSEDED by ADR-0005（已加横幅）
> - `docs/design/02-architecture.md` — DEPRECATED（已标注）
> - `docs/design/03-frontend.md` — DEPRECATED（2026-07-01 加横幅）
> - `docs/design/00-overview.md` / `01-research.md` / `04-review-report.md` / `05-repair-decisions.md` / `checklist.md` — v1 设计阶段历史档案，**不**作为实施依据
> - `docs/onboarding/pm-first-run.md` / `docs/review/*.md` — v1 时代 review 文档
> - `CHANGELOG.md` — 严重过期，停留在 v1.3.1（重写待办）

---

## 1. 项目概述

**gitea-kanban** 是一个**基于 Gitea/GitHub 的桌面端看板 + Git Graph 工具**，技术形态为 **Go + Wails v2 + Vue 3**。

- **核心定位**：把 Gitea/GitHub 仓库里的 issue、分支、提交、合并请求以可视化方式呈现给团队，让非技术人员也能看懂当前工作流。**Git Graph 是核心入口**，其它功能（看板、合并管理、成员）从 commit DAG 衍生展开。
- **Source of truth**：Gitea / GitHub API。本地只存用户偏好、缓存和必要的派生数据（Go 端 `app/store` 包 + 文件 KV，零 SQLite 依赖）。
- **目标用户**：自托管 Gitea / GitHub 团队，**包含非技术人员**（PM、设计师、市场、运营）。因此 UI 必须零术语、危险操作二次确认、错误提示要说"人话"。
- **当前状态**：v2.0 已完成核心迁移（Go+Wails 骨架 + go-git + 多平台 PlatformAdapter）。前端 Vue 3 完整保留（9 视图 + 10 store + 组件库），通过 `wails-api-shim` 兼容旧 IPC 调用方式，逐步替换为 Go 后端 Wails bindings。

### 1.1 多平台支持

| 平台 | 鉴权方式 | 首期支持范围 |
|---|---|---|
| **Gitea** | `Authorization: token <pat>` | 全部功能：仓库 / 分支 / Git Graph / 议题 / 合并 / 标签 / 成员 |
| **GitHub** | `Authorization: Bearer <token>` | **仅 Git Graph**（VerifyToken + CloneRepo + LogGraph）；其余返回 `ErrNotSupported` |

---

## 2. 技术栈（实际生效）

> 以下均来自 `go.mod`、`wails.json`、`frontend/package.json` 等真实配置，不是计划文档中的历史草稿。

| 维度 | 选型 | 说明 |
|---|---|---|
| 运行时 | **Go 1.22+** + Wails v2.12.0 | Go 编译为单一原生二进制；Wails 用系统 WebView |
| 客户端框架 | **Wails v2.12.0** | 跨平台桌面应用（macOS / Windows / Linux），system WebView |
| git 客户端 | **go-git v5.16**（纯 Go，无 CGO） | 替代旧版 `spawn('git', ...)` 子进程调用 |
| 凭证存储 | **zalando/go-keyring v0.2.6**（纯 Go） | 跨平台 keychain（macOS Keychain / Windows Credential Vault / Linux Secret Service） |
| 业务态存储 | **JSON 文件 + 文件 KV**（自研 `app/store` + `app/cache`） | 延续 ADR-0003 零 SQLite 决策；Go 端 `encoding/json` 序列化 |
| 同步队列 | **queue.jsonl**（append-only，JSONL） | 离线写 op 持久化（Go 端 `app/sync`） |
| 平台 API | **Go net/http**（手写，替代旧版 gitea-js） | Gitea REST API + GitHub REST API，统一走 `app/platform` 抽象层 |
| UUID | **google/uuid** | id 生成 |
| 日志 | **log/slog** + 文件 transport | 写 `${dataRoot}/logs/main/main-YYYY-MM-DD.log` |
| 测试 | **Go testing** + httptest | 9 个 Go 包测试（config/git/git-graph/platform/platform-gitea/platform-github/secret/store/sync），共 50+ 测试用例 |
| 前端语言 | **TypeScript 5.7.2** | ESM (`"type": "module"`) |
| 前端构建 | **Vite 6.0** | 产物输出到 `frontend/dist/`，由 `main.go` 的 `//go:embed` 嵌入二进制 |
| 前端框架 | **Vue 3.5.35** + Composition API + `<script setup>` | 保留 v1 Vue 3 全部 9 视图 + 10 store |
| 前端状态 | **Pinia 3.0.4** | 保留 v1 Pinia stores |
| 前端路由 | **Vue Router 4.6.4** | `createWebHashHistory`（与 v1 相同） |
| 前端图标 | **lucide-vue-next** |  |
| 前端拖拽 | **vue-draggable-plus 0.6.1** | 看板列拖拽（v1 沿用） |
| 前端 Markdown | **markdown-it + dompurify** | 议题/PR 评论渲染（v1 沿用） |
| 包管理（前端） | **pnpm 11.x** |  |
| 包管理（Go） | **Go modules** |  |

### 2.1 关键依赖（go.mod）

```
github.com/go-git/go-git/v5 v5.16.2
github.com/google/uuid v1.6.0
github.com/wailsapp/wails/v2 v2.12.0
github.com/zalando/go-keyring v0.2.6
golang.org/x/sys（flock 跨进程锁用）
```

---

## 3. 目录结构

```
gitea-kanban/
├── AGENTS.md                    # 本文件
├── CLAUDE.md                    # 给 Claude 的快捷摘要（与本文件冲突时以本文件为准）
├── go.mod / go.sum              # Go 依赖
├── wails.json                   # Wails v2 配置
├── main.go                      # Wails 应用入口（OnStartup/OnShutdown + Bind）
├── app.go                       # 主后端 App（Wails binding 入口）
├── app/                         # Go 后端业务逻辑
│   ├── config/                  # 数据根目录解析 + slog 日志
│   ├── store/                   # 业务态（state.json，原子写 + 并发安全）
│   ├── git/                     # go-git 封装：clone / log / workspace / sync / repo / lock
│   │   └── graph/               # 自研 lane 布局算法（替代 git log --graph 字形）
│   ├── platform/                # 平台抽象层
│   │   ├── adapter.go           # PlatformAdapter interface + DTO
│   │   ├── platform.go          # Platform 常量（gitea / github）
│   │   ├── gitea/               # GiteaAdapter（net/http + token <pat>）
│   │   └── github/              # GitHubAdapter（仅 Git Graph，Bearer 鉴权）
│   ├── secret/                  # 凭证存储（go-keyring + dev 文件 fallback）
│   └── sync/                    # 同步队列（queue.jsonl append-only + GC）
├── frontend/                    # Vue 3 前端（从旧 src/renderer 迁移）
│   ├── package.json
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── index.html
│   └── src/                     # 与 v1 src/renderer 结构对齐
│       ├── App.vue              # 根 SFC
│       ├── main.ts              # Vue 3 入口（注入 wails-api-shim）
│       ├── routes/              # Vue Router
│       ├── components/          # 通用组件（AppShell / NavRail / StatusBar / Toast ...）
│       ├── views/               # 路由级页面（9 个 view）
│       ├── stores/              # Pinia store（10 个）
│       ├── lib/                 # 工具（含 wails-api-shim 兼容层）
│       ├── types/               # DTO 类型
│       ├── shared/              # 前后端共享（errors + ipc-channels）
│       └── styles/              # 全局样式（theme.css / reset.css）
├── build/                       # Wails 构建产物（macOS / Windows / Linux）
│   ├── appicon.png              # 应用图标（gitea 绿 #609926）
│   ├── darwin/  windows/  linux/
├── docs/                        # 设计文档 + ADR
│   ├── design/                  # 设计文档（v2 部分文档已 deprecated）
│   │   ├── 00-overview.md       # 设计综述（**需更新**技术栈章节）
│   │   ├── 02-architecture.md   # **DEPRECATED**（基于 Electron IPC 架构，v2 改为 Wails bindings）
│   │   ├── 03-frontend.md       # 前端设计（v2 仍有效）
│   │   ├── 06-gitgraph.md       # Git Graph 设计（v2 仍有效）
│   │   └── ...                  # 其余 wireframe / review
│   ├── adr/                     # 架构决策记录
│   │   ├── 0001-keychain.md     # @napi-rs/keyring（v1 决策，v2 改 go-keyring 但设计理念一致）
│   │   ├── 0002-board-data-source-reset.md
│   │   ├── 0003-local-store-electron-store.md  # 零 SQLite 决策（v2 沿用）
│   │   ├── 0004-single-repo-focus.md
│   │   └── 0005-electron-to-go-wails-migration.md  # **v2.0 重大决策（新增）**
│   └── dev/
│       └── cdp-performance-testing.md  # CDP 调试（**Electron 专用，v2 不适用**）
├── legacy/electron/             # v1 旧代码归档（**不再构建、不再维护**）
│   ├── src/                     # main / preload / renderer / shared
│   ├── electron.vite.config.ts
│   ├── electron-builder.yml
│   ├── package.json
│   └── README.md                # 归档说明
└── scripts/                     # 工具脚本（check-no-jargon / 各类验证）— v1 遗留
```

---

## 4. 构建与开发命令

```bash
# 开发（启动 Wails dev server + 桌面窗口 + Vite HMR）
wails dev

# 三端构建（Go 后端 + 前端 + Wails bundle）
wails build                    # 默认当前平台（macOS → .app / Windows → .exe / Linux → .AppImage）
wails build -platform darwin/universal  # 跨架构：x86_64 + arm64

# 平台特定构建（在对应平台机器上执行）
wails build -platform windows/amd64
wails build -platform linux/amd64

# 清理 + 重新构建
wails build -clean

# Go 单元测试
go test ./app/...              # 全部 9 个包测试
go test -v ./app/git/...       # 单包详细输出
go test -race ./app/...        # 竞态检测

# Go vet + 编译验证
go vet ./...
go build -o /dev/null .

# 前端独立构建（不进 Wails，直接出 dist/）
cd frontend
pnpm install
pnpm build                     # vite build（typecheck 暂时跳过，迁移期旧代码有 strict 报错）
pnpm typecheck                 # vue-tsc --noEmit（迁移期可能失败，旧代码 strict 模式报错）
```

**前端类型检查铁律**：仓库已有 `frontend/package.json` 的 `typecheck` 脚本。需要跑 `vue-tsc` 时必须执行 `cd frontend && pnpm typecheck`，禁止临时手写后台 `npx vue-tsc --noEmit &` + `sleep/kill/ps` 超时脚本；这类脚本容易拿错 `$!`、误判卡住并遗留进程。

### 4.1 跨平台编译说明

- **macOS**：默认产出 `.app`（17MB，含 x86_64+arm64 universal binary）
- **Windows**：在 Windows 机器上跑 `wails build -platform windows/amd64`
- **Linux**：在 Linux 机器上跑 `wails build -platform linux/amd64`（需要 webkit2gtk-4.0）
- **macOS 交叉编译 Linux**：需要 `CGO_ENABLED=0`（但 Linux 实际打包仍需 Linux 平台环境）

### 4.2 本地开发首次 setup

1. **Go ≥ 1.22**（项目用 `go 1.22` 工具链）
2. **Node ≥ 20** + pnpm 11（前端构建用）
3. **Wails CLI**：`go install github.com/wailsapp/wails/v2/cmd/wails@latest`
4. `git clone` 后进入项目
5. `cd frontend && pnpm install`（前端依赖）
6. `go mod download`（Go 依赖）
7. `wails dev` 启动开发模式

---

## 5. 代码风格与规范

### 5.1 Go 代码

- `gofmt` 格式化（所有 `.go` 必须 `gofmt -d` 干净）
- 注释关键业务逻辑、安全边界、历史踩坑**必须中文**
- 命名风格：package 小写、export 大写驼峰
- 错误处理：**不吞 error**；`fmt.Errorf("ctx: %w", err)` 包装
- 导出函数必须有 godoc 注释（`// FuncName ...`）

### 5.2 TypeScript / Vue 代码

- **Prettier** 配置在 `frontend/.prettierrc`：
  - `semi: true`
  - `singleQuote: true`
  - `trailingComma: all`
  - `printWidth: 100`
  - `tabWidth: 2`
  - `endOfLine: lf`
- 路径别名：
  - `@renderer/*` → `frontend/src/*`
  - `@shared/*` → `frontend/src/shared/*`
- 注释关键业务逻辑必须中文
- IPC 端点命名：**`<namespace>.<method>`**，例如 `repos.list`、`board.columns.list`、`issues.moveColumn`

### 5.3 Commit Message

- **必须中文**。
- Type 限定：`feat / fix / refactor / perf / chore / test / docs / style`。
- 格式：`<type>: <中文一句话描述>`。
- 每个阶段性交付打一次 commit，不攒大 commit。
- 末尾不加 `Co-Authored-By`。
- 当前单分支 `main`（v1 时代是 `master`，v2 已迁回 `main`）。

---

## 6. 架构要点

### 6.1 Wails 三层架构

```
+--------------------------------------------+
|  Vue 3 Renderer (frontend/dist)            |  ← wails build 嵌入到二进制
|  - Pinia stores                            |
|  - window.go.main.App.* (Wails bindings)   |
+--------------------------------------------+
            ↕ IPC (Wails 自动生成的 Go bindings)
+--------------------------------------------+
|  Go Backend (main package + app/...)       |
|  - App struct: 所有 Wails-exposed 方法    |
|  - app/platform: PlatformAdapter interface |
|  - app/git: go-git 封装                    |
|  - app/store: state.json 原子写            |
|  - app/secret: go-keyring                  |
+--------------------------------------------+
            ↕ HTTPS REST API
+--------------------------------------------+
|  Gitea / GitHub API                         |
|  - GiteaAdapter: token <pat>               |
|  - GitHubAdapter: Bearer <token>            |
+--------------------------------------------+
```

### 6.2 Wails Binding 模式

**`main.go`** 定义窗口 + bind App struct：
```go
wails.Run(&options.App{
    Bind: []interface{}{app},
    OnStartup: app.OnStartup,
    OnShutdown: app.OnShutdown,
})
```

**`app.go`** 集中所有暴露给前端的方法：
```go
type App struct { /* ... */ }
func (a *App) GetAppInfo() AppInfo { ... }
func (a *App) AuthConnect(args ConnectArgs) (ConnectResult, error) { ... }
func (a *App) ListRepos(args ListReposArgs) (ListReposResp, error) { ... }
func (a *App) CloneRepo(args CloneRepoArgs) (CloneRepoResult, error) { ... }
func (a *App) GetGitGraph(args GetGitGraphArgs) (GraphResultDTO, error) { ... } // v2.4
// ... 全部 Wails binding 方法都集中在这里
```

**Wails 自动生成** TypeScript bindings 到 `frontend/wailsjs/wailsjs/go/main/App.d.ts`，前端直接 `import { GetAppInfo } from '../wailsjs/go/main/App'` 调用。

> **v2.4 重要更新**：所有 binding 接受业务态概念（`projectId` / `owner+repo`），Go 端反查 `localPath + token`。**禁止**前端传 `localPath` / `token`（违反 AGENTS §8.2 鉴权铁律）。详见 [ADR-0006 §2.1 + §2.4](./docs/adr/0006-v24-iteration-fixes.md)。

### 6.3 平台抽象层（PlatformAdapter）

所有平台差异通过 `app/platform/adapter.go` 中的 `PlatformAdapter` interface 隔离：

```go
type PlatformAdapter interface {
    Platform() Platform
    VerifyToken(ctx, hostURL, token) (*UserDTO, error)
    ListRepos(ctx, hostURL, username, token, opts) ([]RepoDTO, error)
    ListBranches(ctx, hostURL, username, token, owner, repo) ([]BranchDTO, error)
    CloneRepo(ctx, hostURL, username, token, owner, repo, workspacePath, accountUsername string) (string, error) // v2.5 加 accountUsername
    LogGraph(ctx, localPath, opts) (*GraphResult, error)
    ListIssues(ctx, hostURL, username, token, owner, repo, opts) ([]IssueDTO, error)
    ListPulls(ctx, hostURL, username, token, owner, repo, opts) ([]PullDTO, error)
    ListLabels(ctx, hostURL, username, token, owner, repo) ([]LabelDTO, error)
    ListMembers(ctx, hostURL, username, token, owner, repo) ([]MemberDTO, error)
}
```

**实现**：
- `GiteaAdapter`（`app/platform/gitea/`）：完整实现 9 类方法，鉴权 `token <pat>`
- `GitHubAdapter`（`app/platform/github/`）：首期**仅**实现 `VerifyToken` + `CloneRepo` + `LogGraph`，其余 6 个方法返回 `platform.ErrNotSupported`

### 6.4 数据模型

业务态 8 张表（**全部**在 `state.json`，由 `app/store/store.go` 的 `LocalState` 定义）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `schemaVersion` | int | 当前 1（迁移时手动 bump） |
| `accounts` | []GiteaAccount | v2 新增 `Platform` 字段（`gitea` / `github`），旧数据迁移默认 `gitea` |
| `users` | []LocalUser | 1 行 seed `local-user` |
| `prefs` | map[string]any | 业务偏好（含 `app.workspacePath`） |
| `projects` | []RepoProject | v2 新增 `Platform` 字段 |
| `columns` | []BoardColumn | 看板列 |
| `labelMaps` | []ColumnLabelMap | 列 ↔ Gitea label 映射 |
| `starredBranches` | []StarredBranch | 收藏的分支 |

**加载与原子写**（`app/store/store.go`）：
- 启动期 `NewLocalStore(path)`：`os.ReadFile` + `json.Unmarshal`；文件不存在初始化默认值；JSON 损坏返 error
- 写操作 `Mutate(fn)`：`sync.RWMutex` 保护 + 临时文件 `tmp+rename` 原子写
- 旧数据迁移：`accounts[i].Platform == ""` → 默认 `"gitea"`

**Gitea 缓存层**（v2 暂未实现，仍走 Gitea API 实时拉取；v2.1 计划加 `app/cache` 文件 KV 缓存层，对齐 v1 设计）。

**Workspace 路径**（Git Graph 专用，**v2.2 锁定不可改**）：`~/.gitea-kanban/workspace`（单层，无嵌套），repos 存 `${workspace}/repos/${username}/${owner}__${repo}/`（v2.5 起按账号分层）。**禁止**在连接 / 设置界面暴露修改入口（v2.2 user 拍板）；设置界面只读 + "打开应用数据目录"按钮（`App.OpenDataDir`）。详见 [ADR-0006 §2.3](./docs/adr/0006-v24-iteration-fixes.md#23-数据目录收尾-v22--v24)。

**v2.5 按账号分层**（user 拍板 2026-06-22）：
- 旧布局 `${workspace}/repos/${owner}__${repo}/` 启动期**自动迁移**到新布局（见 §6.5）
- 迁移逻辑：`app/git/workspace.go` 的 `MigrateLegacyWorkspaceLayout` + `App.runLegacyWorkspaceMigration`
- 迁移成功后旧 `${workspace}/repos/` 整目录 mv 到 `${workspace}/_pre_v25_workspace` 保留备份
- 失败时整个旧目录也 mv 到 `_pre_v25_workspace`（带 .1/.2... 后缀避免冲突）；新空 `${workspace}/repos/` 重建
- 任何时候 resolveTokenByLocalPath 都兼容 v2.4 旧路径（`repos/<owner>__<repo>` 两层）+ v2.5 新路径（`repos/<username>/<owner>__<repo>` 三层），主要用于迁移期残留数据

### 6.5 git 客户端（go-git）

> **v2.4 轻量模式（user 拍板）**：本应用**只**用 commit / tree / branch 元信息画 Git Graph，**不** clone 工作区文件。`PlainClone` 必须传 `NoCheckout: true`，磁盘占用 -99%。

**`app/git/clone.go`**：`go-git.PlainClone(localPath, false, &git.CloneOptions{NoCheckout: true, Auth: ...})`，token 仅内存态不落盘。
  - v2.5 起路径：`RepoLocalPathForAccount(workspacePath, accountUsername, owner, repo)` = `${ws}/repos/${username}/${owner}__${repo}/`
  - 旧版 `RepoLocalPath(workspacePath, owner, repo)` 保留（仅供测试 / 迁移期 fallback）
**`app/git/log.go`**：`repo.Log(&git.LogOptions{Order: git.LogOrderCommitterTime})` 遍历 commit DAG。
**`app/git/graph/layout.go`**：自研 lane 布局算法（go-git 不提供 `git log --graph` 字形），输出结构化 `GraphNode + GraphEdge`。
**`app/git/workspace.go`**：workspace 路径管理（mkdir / list / migrate）。
  - `ListRepos`：扫 `${ws}/repos/<username>/<owner>__<repo>/`，返回带 AccountUsername 字段的 WorkspaceRepo
  - `MigrateLegacyWorkspaceLayout`：启动期一次性旧 → 新布局迁移，使用 `_v25_migration_staging` 临时目录 + `os.Rename` 原子切换
  - 备份目录命名 `_pre_v25_workspace`（冲突时自动加 `.1` / `.2` 后缀）
**`app/git/sync.go`**：`FetchRepo` + `PullRepo`（**NoCheckout 适配**：fetch 后**主动**更新本地 HEAD ref 指向新 remote HEAD；`AddedCommits` 真正反映远端变化）。
**`app/git/repo.go`**：commit 详情 + diff 封装。
**`app/git/lock.go`**：per-repo `sync.Mutex`（内存）+ `flock`（跨进程）双重锁，防 `CloneRepo` 并发竞态。

### 6.6 凭证存储

**`app/secret/store.go`**：
- 生产：`go-keyring`（zalando/go-keyring，跨平台纯 Go）写系统 keychain
- dev fallback：`userData/dev-tokens/<service>__<username>.json`（0600 权限）
- Key 规则：service = `gitea-kanban@${hostURL}`（与 v1 相同）
- 铁律：token 永远不离开主进程内存 + 系统 keychain，**不**写到日志 / state.json / 前端

### 6.7 Wails 窗口安全

- 渲染端默认 `contextIsolation: true`、`nodeIntegration: false`
- v2 **不**用 Electron sandbox（WebView 自带安全模型）
- 前端通过 `window.go.main.App.*` 调用后端；没有 preload script（Wails 直接注入 bindings）
- 禁止 `v-html`，除非是明确审核过的 sanitize 场景

### 6.8 主题系统

- v2 沿用 v1 主题策略：**2 主题切换**（dark / light），默认 dark
  - dark 基底 `#0F1115`，主色 token `#74B830`
  - light 基底 `#E8F1F5`，主色 token `#466B16`
- 持久化走 `localStore.prefs['theme']`（前端用 localStorage 启动期 0 闪烁）
- 切换入口 3 处：StatusBar cycle 按钮 / 设置页"外观" / 命令面板 ⌘K

---

## 7. 测试策略

### 7.1 Go 单元测试

- **配置**：标准库 `testing` + `httptest`
- **覆盖目标**（当前 50+ 测试用例，9 个包）：
  - `app/config`：3 测试（数据目录解析 + 日志写入）
  - `app/git`：10 测试（clone 路径 / URL 构造 / sanitize / file:// clone / commit 遍历 / DAG log / layout 算法 / workspace / fetch / pull / 锁）
  - `app/git/graph`：5 测试（线性 / 分支+合并 DAG / 空图 / 排序）
  - `app/platform`：2 测试（Platform 常量 / IsValid）
  - `app/platform/gitea`：6 测试（httptest mock server 验证 HTTP 请求）
  - `app/platform/github`：5 测试（Bearer 鉴权 / NotSupported 场景）
  - `app/secret`：5 测试（dev 文件 fallback Set/Get/Delete + 0600 权限）
  - `app/store`：4 测试（默认状态 / Mutate+持久化 / 旧数据迁移 / workspace 路径）
  - `app/sync`：4 测试（Enqueue / LoadPending / MarkDone 去重 / GC）
- **运行**：`go test ./app/...`
- **覆盖率目标**：未设置硬阈值（迁移期不强制）

### 7.2 前端组件测试

- v2 沿用 v1 测试模式：Vitest + @vue/test-utils + @testing-library/vue
- 当前 0 个前端测试运行（v1 大量前端测试已随代码归档到 `legacy/electron/`）
- 计划恢复 v1 的关键测试：AuthView / BoardView / 拖拽链路（用 CDP 在真实 Electron renderer 验证）

### 7.3 E2E

- v1 计划用 Playwright + Electron（**已不适用**，v2 是 Wails）
- v2 E2E 计划：Playwright + Wails（**待规划**），关键路径必须覆盖：首次接入、Git Graph 渲染、平台选择、克隆、错误提示

### 7.4 其他验证

- `go vet ./...` 必须无 error
- `go test ./app/...` 必须全通过
- 前端 `pnpm build` 必须成功
- `wails build` 三端至少 macOS 通过

---

## 8. 安全与运维

### 8.1 鉴权铁律

- **token 永远不离开 Go 进程内存**。
- `App.VerifyToken` 是**唯一**接收 token 的入口。
- token 通过 `go-keyring` 存系统 keychain；**绝不**存到文件（生产）/ 日志 / state.json。
- 渲染进程通过 Wails bindings 调用，**拿不到**明文 token（只能看 `Account.UserInfo`）。
- `slog` 禁止把 `token` / `password` / `key` 等写入日志（不要在调用处显式 print 这些字段）。

### 8.2 数据与日志路径

- 数据根目录优先级：
  1. 环境变量 `GITEA_KANBAN_DATA_DIR`（必须是绝对路径）
  2. 兜底 `~/.gitea-kanban`
- 业务态：`${dataRoot}/state.json`（`app/store` 原子写）
- Workspace：`${dataRoot}/workspace/repos/${username}/${owner}__${repo}/`（v2.5 起按账号分层，go-git clone 目标）
  - 旧布局 `${dataRoot}/workspace/repos/${owner}__${repo}/` 启动期**自动迁移**（见 §6.5）
- 同步队列：`${dataRoot}/queue.jsonl`（append-only JSONL）
- 日志目录：`${dataRoot}/logs/main/main.log`（`slog` 写文件）
- 开发模式如遇 macOS SIP 写权限问题，会 fallback 到 `/tmp/gitea-kanban`。

### 8.3 输入与路径安全

- **MigrateRepo** 沙箱校验：`newWorkspacePath` 必须在 `allowedRoot` 之下（防系统目录逃逸）
- **CloneRepo** token 走 go-git `http.BasicAuth.Password`（内存态，不落盘到 `.git/config`）
- 禁止 `v-html`，除非是明确审核过的 sanitize 场景

### 8.4 启动调试

Wails v2 没有 Electron 那套 CDP 远程调试端口（v1 的 9492 端口已不适用）。

**v2 启动排查**：

```bash
# 1. 设独立 data dir 避免污染真实数据
export GITEA_KANBAN_DATA_DIR=/tmp/gitea-kanban-debug
rm -rf "$GITEA_KANBAN_DATA_DIR"

# 2. 后台跑 dev
GITEA_KANBAN_DATA_DIR="$GITEA_KANBAN_DATA_DIR" wails dev > /tmp/wails-dev.log 2>&1 &
echo "pid=$!"

# 3. 等 10 秒（Vite 编译 + Go 编译 + Wails 启动）
sleep 10

# 4. 三路看
echo "--- 1. slog 日志（Go 写文件，不是 stdout）---"
tail -50 "$GITEA_KANBAN_DATA_DIR/logs/main/main.log" 2>&1
echo "--- 2. wails dev 自身输出 ---"
tail -30 /tmp/wails-dev.log
echo "--- 3. Go 二进制是否启动 ---"
ps aux | grep -E "gitea-kanban|main" | grep -v grep
```

**常见启动问题**：
1. **CSP / 渲染端加载失败** — 罕见（Wails 自动处理 CSP）
2. **`app.setPath` 写入受限**（macOS SIP）— 走 `GITEA_KANBAN_DATA_DIR` 到 `/tmp`
3. **state.json 损坏** — 删 `state.json` 重启（localStore 初始化默认值）
4. **go-git clone 失败** — 网络问题或 token 无效；看 slog 日志中的 HTTP 错误
5. **wails 找不到 go / node** — `wails doctor` 诊断

### 8.5 沙箱/容器内启动

当 dev 环境是 AI agent 沙箱（reasonix / docker / k8s），默认 `~/.gitea-kanban` 写不进去时：

```bash
# 1. 选个沙箱可写的数据目录
export GITEA_KANBAN_DATA_DIR=/tmp/gitea-kanban-test
rm -rf "$GITEA_KANBAN_DATA_DIR"

# 2. 后台跑 dev（用环境变量彻底绕开 ~ 目录）
GITEA_KANBAN_DATA_DIR="$GITEA_KANBAN_DATA_DIR" wails dev > /tmp/wails-dev.log 2>&1 &
echo "pid=$!"

# 3. 等 10 秒
sleep 10

# 4. 看日志
tail -30 /tmp/wails-dev.log
tail -30 "$GITEA_KANBAN_DATA_DIR/logs/main/main.log" 2>&1
```

---

## 9. 关键产品约束

### 9.1 零术语

UI 文本禁止直接出现以下原词，必须走翻译表（与 v1 相同）：

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

### 9.2 危险操作二次确认

- 删分支 / 强推 / 合并冲突解决 / 关闭合并请求 / 合并到主线分支 → 弹窗二次确认

### 9.3 错误提示"人话"

- 统一 `IpcError` / `GoError` 格式：`code + message + hint`
- 前端 `lib/ipc-client.ts` 把错误码转成本地化中文类别前缀 + 建议
- 不暴露内部 stack trace 给最终用户
- GiteaAdapter / GitHubAdapter `mapHTTPError` 翻译 401/403/404/409/422/429/5xx

### 9.4 离线降级

- 平台 API 失败时降级到本地缓存（v2.1 计划加文件 KV 缓存层）
- 写操作离线时入队到 `queue.jsonl`，后台 runner 重试
- 状态栏显著提示"离线模式"（前端已实现）

---

## 10. 常见陷阱与专属注意

1. **Wails binding 签名**：所有 `(args struct) (result, error)` 形式，struct 字段名会原样生成 TS 类型。
2. **go-git clone URL**：go-git 的 auth 走 `http.BasicAuth`，URL **不**含 token（与 git 二进制不同——后者需要 set-url 清 token）。
3. **go-git 不提供 `--graph` 字形**：必须用 `app/git/graph/layout.go` 自研 lane 布局算法，输出结构化 `GraphNode + GraphEdge`。
4. **go-keyring 平台差异**：
   - macOS：可能弹出 keychain 授权弹窗
   - Linux：需要 `gnome-keyring` 或 `kwallet` 运行
   - dev fallback：文件（0600 权限）
5. **平台选择 UI**：GitHub 首期仅 Git Graph，其余入口（issue/PR/labels/members）必须 UI 隐藏 + 后端返 `ErrNotSupported`。
6. **Wails frontend:dist 必须存在**：`wails.json` 配置 `frontend:build = pnpm build`；CI 必须先 build 前端再 `wails build`。
7. **不要跨边界**：渲染端不写 `app/**/*.go`、主进程不写 Vue 组件 / CSS。
8. **Wails 跨平台构建限制**：
   - macOS 产 `.app`（dmg 在 macOS 上 `wails build` 自动生成）
   - Windows 产 `.exe`（必须在 Windows 机器上跑）
   - Linux 产 `AppImage`（必须在 Linux 机器上跑，需要 webkit2gtk-4.0）
9. **Edit 工具残段**：用 `edit_file` 替换时 `old_string` 尽量包整个函数或大段；替换后 `git diff` 确认无重复行。
10. **go-git AuthMethod 接口**：`transport.AuthMethod`（来自 `plumbing/transport`），不是 `http.BasicAuth` 直接传——后者只是 `AuthMethod` 的一种实现。

---

## 11. 关键文档索引

| 文档 | 路径 | 用途 |
|---|---|---|
| 设计综述 + 路线图 | `docs/design/00-overview.md` | 用户 review 入口（v2.4 增量已加横幅） |
| 架构 + 后端设计 | `docs/design/02-architecture.md` | **DEPRECATED**（基于 Electron IPC，v2 改为 Wails bindings） |
| 前端设计 | `docs/design/03-frontend.md` | UI/UX、路由、状态管理（v2 仍有效） |
| Git Graph 设计 | `docs/design/06-gitgraph.md` | Git Graph 设计（v2 仍有效） |
| **v2.4 迭代记录** | `docs/design/07-v24-iteration.md` | **v2.4 新增**：迁移后 6 类问题修复 + 决策总表 + 验证基线 |
| keychain 选型 | `docs/adr/0001-keychain.md` | v1 用 @napi-rs/keyring；v2 改 zalando/go-keyring 但设计理念一致 |
| board 数据模型 reset | `docs/adr/0002-board-data-source-reset.md` | 为什么卡片 = Gitea issue |
| **本地存储迁移 + 同步队列** | `docs/adr/0003-local-store-electron-store.md` | **ADR-0003（v1 完结）**：SQLite → electron-store + 文件 KV + queue.jsonl |
| **单一仓库专注模式** | `docs/adr/0004-single-repo-focus.md` | ADR-0004（v1.4 拍板）：每个 view 只看一个 project |
| **v2.0 迁移决策** | `docs/adr/0005-electron-to-go-wails-migration.md` | **v2.0 重大决策**：Electron→Go+Wails + 多平台 + go-git |
| **v2.4 迭代修复** | `docs/adr/0006-v24-iteration-fixes.md` | **v2.4 新增**：6 个决策（鉴权铁律 / binding 补全 / 数据目录 / 反查链路 / prefs / go-git 轻量） |
| **v2.5 workspace 按账号分层** | `docs/adr/0007-workspace-account-scoped.md` | **v2.5 新增**：repos 按账号 username 子目录分层 + 启动期自动迁移 + `_pre_v25_workspace` 备份 |
| 设计系统 | `design-system/gitea-kanban/OVERRIDE.md` | 颜色、字体、零术语、二次确认（v2 仍有效） |
| 本文件 | `AGENTS.md` | agent 入口规范 |

---

## 12. Agent 角色边界（参考）

> 项目使用 mavis team plan 时的角色分工。单人开发时也可作为代码组织参考。

- **后端 agent**：负责 `app/**`、`main.go`、`wails.json`、`go.mod`、打包配置。
- **前端 agent**：负责 `frontend/src/**`、wireframe、组件库；不碰 Go 后端 / binding schema。
- **verifier**：独立验证 Wails bindings 暴露数、零术语、错误码统一性、数据路径、go test 全过、wails build 成功。
- **orchestrator**：拆 plan、跑 cycle、统一 git commit。

---

## 13. 不决事项（必须推给用户拍板）

以下变更不准 agent 自决：
1. 改技术栈（Go / Wails / go-git / zalando-go-keyring / Vue 3 / Pinia 任一变更）
2. 改 Wails bindings 契约（`app.go` 的方法签名 / 字段类型）
3. 改数据模型（`LocalState` 结构 / 新增字段）
4. 改 PlatformAdapter interface（增减方法 / 改签名）
5. 改设计原则（零术语表、危险操作清单、错误码表）
6. 改设计系统 token（主色 / 强调色 / 字体 / 默认主题）
7. 改鉴权方式（PAT → OAuth2 / SSH key 等）
8. 改打包目标平台（新增 Android / iOS / Web）
9. 引入重大新依赖（如更换 go-git 为 git CLI wrapper / 改用 SQLite 等）

---

> **记住**：本文件是活的规范。当你修改了技术栈、构建流程、安全边界、目录结构或关键约定时，必须同步更新本文件。

## Notes

- MCP调试完成后，应该主动关闭由MCP拉起的浏览器进程，注意：不要错误关闭掉了用户启动的浏览器进程。
