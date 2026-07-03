# ADR-0005: Electron→Go+Wails 迁移 + 多平台架构（v2.0）

> **状态**：✅ Accepted（2026-06-22 拍板 + 实施完成）
> **执行**：commit `9fbb317`（迁移实现）+ `e03d2d1`（review 风险点修复）
> **影响范围**：客户端技术栈 / git 客户端 / 凭证存储 / 平台支持 / 数据模型 / 部署形态
> **替代**：v1 时代的 Electron+TypeScript+SQLite 架构

---

## 1. 背景与动机

### 1.1 v1 痛点

v1 时代（commit `818891f` 及之前）使用 **Electron 41 + TypeScript + Vue 3 + better-sqlite3** 架构，经过 6+ 个月迭代，积累了一组难以解决的痛点：

| 痛点 | 表现 | 触发场景 |
|---|---|---|
| **包体过大** | `.dmg` 体积 100+ MB（Chromium 内嵌） | 用户反馈"拷个文件就要 1GB" |
| **原生 binding 维护成本** | `better-sqlite3` ABI 141/145 漂移，每次 Node 升级要 `rebuild-native.sh` | AGENTS §10.6 已踩坑 |
| **依赖用户环境 git** | `spawn('git', ...)` 假设本机有 git 二进制 | Docker 镜像、企业代理环境无 git 客户端 |
| **单一平台** | 只支持 Gitea；用户要求 GitHub 接入 | 用户实际工作在 GitHub + 自托管 Gitea 双平台 |
| **前端渗透到主进程** | `gitea-js` swagger TS 客户端，Zod schema 在 src/main 散落 55KB | 主进程越来越像前端 |
| **CDP 远程调试复杂** | 沙箱容器里 `~/.gitea-kanban` 写不进去（AGENTS §8.7.6） | 容器内开发体验差 |

### 1.2 迁移窗口

2026-06-20 用户在 `main` 分支拍板：

> "在 main 分支要做以下几件事：
> 1. 客户端技术从 Electron 切换到 go wails。
> 2. 支持多用户，不同平台（先支持 Gitea、Github）。
> 3. 核心功能，以 Git-graph 为主，然后衍生展开。
> 4. git 客户端不再依赖用户环境，使用 go-git。
> 请按照 1、4、2、3 来展开计划和设计。"

---

## 2. 决策

### 决策 1：客户端框架 = Go + Wails v2

**采纳**：**Go 1.22+ + Wails v2.12**（用系统 WebView，非 Chromium 内嵌）

**拒绝的替代**：
- ❌ **Tauri**（Rust）：团队无 Rust 积累，go-git 比 libgit2 Rust 绑定更接近 Git 协议
- ❌ **Electron 续命 + 移除 SQLite**：包体问题无解
- ❌ **纯 Web 部署**：用户明确要桌面端

**理由**：
- Wails v2 单二进制 17MB（macOS .app），对比 Electron 100+MB，体积缩小 80%
- Go 编译产物自包含，无 native binding 维护成本（ADR-0003 痛点彻底消失）
- go-git 纯 Go 实现，替代 spawn('git') 子进程调用
- 系统 WebView（macOS WKWebView / Windows WebView2 / Linux webkit2gtk）有平台安全模型，**不**需要 Chromium sandbox
- 团队 Go 经验比 Rust 多

**实施**：`main.go` + `app.go` + `app/` 包结构；Wails 自动生成 TS bindings 到 `frontend/wailsjs/`

### 决策 2：git 客户端 = go-git v5

**采纳**：**go-git v5.16.2**（github.com/go-git/go-git/v5）

**理由**：
- 纯 Go，无 CGO（关键：跨平台编译无需 toolchain）
- clone 鉴权走 `http.BasicAuth{Username, Password: token}`，token **仅内存态**，不写入 `.git/config`（go-git 不会像 git 二进制那样需要 set-url 清 token）
- Gitea 自身用 go-git（生产验证）

**关键限制 + 自研**：
- go-git **不提供** `git log --graph` 的 ASCII 字形生成（这是 git 二进制的 UI 功能）
- → 自研 `app/git/graph/layout.go` lane 布局算法，输出结构化 `GraphNode + GraphEdge`，前端直接消费（不再解析字形）

**实施**：
- `app/git/clone.go`：PlainClone + BasicAuth
- `app/git/log.go`：repo.Log 按 committer time 降序遍历 DAG
- `app/git/graph/layout.go`：lane 分配 + edge 生成（EdgeNormal / EdgeBranch / EdgeMerge）
- `app/git/workspace.go`：路径管理（mkdir / list / migrate / 沙箱校验）
- `app/git/sync.go`：FetchRepo + PullRepo（含 SHA 变化检测处理 force push 负数场景）
- `app/git/repo.go`：commit 详情 + diff（Parent Tree Diff）
- `app/git/lock.go`：per-repo `sync.Mutex` + `flock` 双重锁防并发竞态

### 决策 3：多平台 = PlatformAdapter interface

**采纳**：**`app/platform/PlatformAdapter` interface** 隔离 Gitea / GitHub 差异

**拒绝**：
- ❌ **if-else 散落各 handler**：无法扩展新平台
- ❌ **统一 API 转换层（如 OneDev 等）**：YAGNI，先支持 Gitea + GitHub 即可

**Interface 设计**：
```go
type PlatformAdapter interface {
    Platform() Platform
    VerifyToken(ctx, hostURL, token) (*UserDTO, error)
    ListRepos(ctx, hostURL, username, token, opts) ([]RepoDTO, error)
    ListBranches(ctx, hostURL, username, token, owner, repo) ([]BranchDTO, error)
    CloneRepo(ctx, hostURL, username, token, owner, repo, workspacePath) (string, error)
    LogGraph(ctx, localPath, opts) (*GraphResult, error)
    ListIssues / ListPulls / ListLabels / ListMembers（仅 Gitea 实现）
}
```

**实现**：
- **`GiteaAdapter`**（`app/platform/gitea/`）：完整 9 类方法，鉴权 `Authorization: token <pat>`，走 `/api/v1`
- **`GitHubAdapter`**（`app/platform/github/`）：**仅**实现 `VerifyToken` + `CloneRepo` + `LogGraph`，其余 6 个方法返回 `platform.ErrNotSupported`（v1 用户决定范围："先支持 Gitea、Github"）

**错误码统一**：两个 Adapter 各自有 `mapHTTPError` 把 401/403/404/409/422/429/5xx 翻译为"人话"中文，对齐 v1 OVERRIDE.md §"本项目专属规则 #3 错误人话"

### 决策 4：凭证存储 = go-keyring（纯 Go 替代 @napi-rs/keyring）

**采纳**：**zalando/go-keyring v0.2.6**（纯 Go，跨平台 keychain）

**拒绝**：
- ❌ 续用 @napi-rs/keyring（Rust napi，跨平台编译需 CGO + 平台包，v1 已踩坑）
- ❌ 自研 OS 系统调用（macOS Security framework / Windows CredWrite）：跨平台成本高

**理由**：
- 纯 Go，**无 CGO**，跨平台编译无坑
- API 简洁：`keyring.Set(service, username, password)` / `keyring.Get` / `keyring.Delete`
- 平台覆盖：macOS Keychain / Windows Credential Vault / Linux Secret Service

**dev fallback**（macOS sandbox 限制）：文件 `userData/dev-tokens/<service>__<username>.json`（0600 权限）—— 对齐 v1 模式

### 决策 5：业务态存储 = JSON 文件（延续 ADR-0003 决策）

**采纳**：**JSON 文件 + 文件 KV**（`app/store/store.go` 的 `LocalState` + 原子写 `tmp+rename`）

**拒绝**：
- ❌ **modernc.org/sqlite（纯 Go SQLite）**：包体 +7-15MB，且当前数据量未达 SQL 瓶颈
- ❌ **BoltDB / BadgerDB**：无 SQL 能力

**理由**：
- v1 ADR-0003 完结后已是无 SQLite 依赖（"Electron 升级不再需要 rebuild native binding"）
- 当前数据量（< 10MB 业务态 JSON）下 JSON 性能足够
- 零包体增量
- 原子写 + `sync.RWMutex` 并发安全已验证（4 个测试）

**v2 增量**：`GiteaAccount` + `RepoProject` 加 `Platform` 字段（旧数据迁移默认 `gitea`），由 `LocalStore.load()` 自动处理。

### 决策 6：前端保留 Vue 3（不重写）

**采纳**：**完整保留 v1 Vue 3 前端**（9 视图 + 10 store + 组件库 + 78 个文件）

**理由**：
- v1 前端代码量大（BoardView 38KB / MergesView 95KB / TimelineNewView 38KB），重写 ROI 为负
- Vue 3 / Pinia / Vue Router / lucide-vue-next 在 Go 侧无替代需求
- 通过 `frontend/src/lib/wails-api-shim.ts` 兼容层让旧 `window.api.<namespace>.<method>()` 调用方式不变

**实施**：
- `frontend/` 目录结构与 v1 `src/renderer/` 对齐
- 旧 `src/main/ipc/schema.ts` 的 DTO 类型提取为 `frontend/src/types/dto.ts`（纯 TS）
- `@shared/errors` + `ipc-channels` 复制到 `frontend/src/shared/`
- `window.api` 桩化层在 `wails-api-shim.ts`（逐步替换为 `window.go.main.App.*`）
- 平台选择器 UI 已在 AuthView 扩展（Gitea / GitHub tab）

---

## 3. 实施计划

按用户指定的 **1→4→2→3** 顺序：

| 阶段 | 内容 | 关键 commit |
|---|---|---|
| **1. 客户端切换** | Go+Wails 骨架（main.go + app.go + app/）；Vue 3 前端迁移 + window.api 桩化层；wails build 三端验证 | `9fbb317` |
| **4. go-git 集成** | clone 封装（token 鉴权，不落盘）+ commit DAG 遍历 + **自研 lane 布局算法** + workspace 管理 + fetch/pull + 前端 Graph 渲染适配（消费结构化 GraphResult） | `9fbb317` |
| **2. 多平台** | 账号模型加 Platform 字段（迁移默认 gitea）；`PlatformAdapter` interface（9 类方法 + ErrNotSupported）；`GiteaAdapter`（Go net/http + token <pat>）；`GitHubAdapter`（仅 Git Graph，Bearer 鉴权）；`go-keyring` 凭证存储（含 dev fallback）；AuthView 扩展平台选择器 | `9fbb317` |
| **3. Git Graph 主视图 + 衍生** | Git Graph 主视图：CloneRepo/LogGraph/GetWorkspace/ListWorkspaceRepos 暴露为 Wails bindings；衍生：ListBranches/StarBranch、GetCommitDetail、PullRepo/FetchRepo、ListIssues/ListColumns（仅 Gitea）、同步队列（append-only + 崩恢复 + 30 天 GC） | `9fbb317` |
| **review 修复** | 修复 6 个风险点：误入仓清理（22K swagger）、PullRepo.Updated 永远 true → 改 SHA 变化判断、queue.go 写后 Sync 防崩后丢 op、CloneRepo 加 per-repo 锁防竞态、MigrateRepo 加 dataDir 沙箱、secret 错误信息分层 | `e03d2d1` |

---

## 4. 验证与回归

| 维度 | v1 状态 | v2 状态 |
|---|---|---|
| 打包体积 | 100+ MB（macOS .dmg） | **17 MB**（macOS .app universal binary） |
| 跨平台编译 | Electron 需按平台重打包 | Go `CGO_ENABLED=0 GOOS=linux` 可交叉编译 |
| 凭证存储 | Rust napi 二进制（@napi-rs/keyring） | 纯 Go（go-keyring） |
| git 客户端 | spawn('git', ...) 依赖本机 | go-git 自包含 |
| Go 测试 | 仅 `isoDateSchema.test.ts` 1 个 | **50+ 测试 / 9 个包** |
| 前端构建 | 包含 24 个 .ts/.vue 文件 | 同等规模，window.api 兼容层保 0 改动 |
| 数据目录 | `~/.gitea-kanban` | 同（无变化） |
| 平台支持 | Gitea 单平台 | **Gitea 完整 + GitHub 仅 Git Graph** |

**测试覆盖**（迁移后）：
```bash
$ go test ./app/...
ok  	gitea-kanban/app/config       (3 tests)
ok  	gitea-kanban/app/git          (10 tests)
ok  	gitea-kanban/app/git/graph    (5 tests)
ok  	gitea-kanban/app/platform     (2 tests)
ok  	gitea-kanban/app/platform/gitea  (6 tests)
ok  	gitea-kanban/app/platform/github (5 tests)
ok  	gitea-kanban/app/secret       (5 tests)
ok  	gitea-kanban/app/store        (4 tests)
ok  	gitea-kanban/app/sync         (4 tests)
```

**wails build** 验证：
```bash
$ wails build -platform darwin/universal
✓ built '/Users/.../build/bin/gitea-kanban.app' in 13.96s
# 产物：gitea-kanban.app 17MB（含 x86_64 + arm64）
```

**code review 标记的 6 个风险点**（commit `e03d2d1` 修复）：
1. `docs/plugin-redoc-2.yaml` 误入仓（22K swagger） → 恢复 .gitignore 忽略 + `git rm --cached`
2. `frontend/package.json.md5` 误入仓（pnpm build 产物） → 加忽略规则
3. `App.PullRepo` 永远 `Updated: true` → 改用 SHA 变化判断 `HeadChanged`（处理 force push 负数）
4. `queue.go` 写后不 `Sync()` → `Enqueue/MarkDone/MarkFailed` 都加 `file.Sync()` 防崩后丢 op
5. `CloneRepo` stat+race 竞态 → 新建 `app/git/lock.go` per-repo `sync.Mutex` + `flock` 跨进程锁，失败时 `RemoveAll` 清理半成品
6. `MigrateRepo` 无沙箱 → 新增 `allowedRoot` 参数 + 校验 `newWorkspacePath` 必须在 allowedRoot 之下

---

## 5. 兼容性 / 迁移路径

### 5.1 数据兼容

- `state.json` 格式不变（`schemaVersion: 1` 不 bump）
- `LocalStore.load()` 自动迁移：旧 `accounts[]` 无 `Platform` 字段 → 默认 `"gitea"`
- 旧 `prefs['app.workspacePath']` 不变（Go 侧 `app/store` 兼容读）

### 5.2 前端兼容

- `window.api.<namespace>.<method>(args)` 调用方式不变（`wails-api-shim` 桩化层）
- 旧 `from '../../main/ipc/schema.js'` 类型 import 改为 `from '@renderer/types/dto'`
- 旧 DTO 类型在 `dto.ts` 完整保留 + 61 个新类型
- 旧 `src/renderer/*` 代码原样复制到 `frontend/src/*`（无任何代码修改）

### 5.3 旧代码归档

- 任何 v1 文档（`docs/design/01-research.md`、`02-architecture.md`）标注 deprecated

### 5.4 增量迁移（v2.0 → v2.1 计划）

- **Gitea 缓存层**：从 v1 文件 KV 移植到 `app/cache/` 包（cache-aside + TTL + LRU）
- **GitHub 完整支持**：GitHubAdapter 实现 `ListIssues` / `ListPulls` / `ListLabels` / `ListMembers`
- **前端类型检查**：当前 `pnpm typecheck` 跳过（旧代码 strict 报错）；v2.0.1 修复 strict 模式
- **E2E**：Playwright + Wails（v1 计划 Playwright + Electron 已不适用）

---

## 6. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| Wails v2 仍在活跃开发（v3 在 RC） | 框架未来兼容性 | 用 v2.12 LTS；v3 稳定后单独 ADR |
| go-git 不支持全部 git CLI 功能 | 用户需要高级 git 操作 | 提供 "Open in Gitea/GitHub" 跳网页；后续可加 git 二进制 fallback |
| Wails 系统 WebView 平台差异 | macOS/Win/Linux 渲染差异 | 用标准 web API（CSS Grid / Flexbox）；避免依赖 WebKit-only 特性 |
| Go 编译时间 | 改一行要等几秒 | `wails dev` 增量编译 + 前端 HMR；CI 缓存 `~/.cache/go-build` |
| 跨平台打包 | Linux 需 webkit2gtk | 在 Linux 机器/CI runner 跑 `wails build -platform linux/amd64` |
| 沙箱容器内 `~/.gitea-kanban` 写不进去 | 容器开发体验 | `GITEA_KANBAN_DATA_DIR=/tmp/...` env 绕过 |

---

## 7. 文档影响

| 文档 | 影响 | 处理 |
|---|---|---|
| `AGENTS.md` | 完全重写 | v1 → v2.0 技术栈/架构/命令 |
| `CLAUDE.md` | 完全重写 | v1 摘要 → v2.0 摘要 |
| `docs/design/00-overview.md` | 顶部加 v2.0 横幅 | 部分章节仍反映 v1 现状，待 v2.0.1 完整重写 |
| `docs/design/02-architecture.md` | **DEPRECATED** | 顶部标注，基于 Electron IPC；引用此 ADR |
| `docs/design/03-frontend.md` | 不变 | v2 仍用 Vue 3 |
| `docs/design/06-gitgraph.md` | 不变 | Git Graph 设计 v2 仍有效 |
| `docs/adr/0001-keychain.md` | 不变 | 设计理念一致（虽然库换了） |
| `docs/adr/0003-local-store-electron-store.md` | 不变 | 零 SQLite 决策 v2 沿用 |
| **新增 `docs/adr/0005-...md`** | **本文件** | v2.0 重大决策 |

---

## 8. 决策记录

- **2026-06-20**：用户拍板"main 分支做迁移，按 1→4→2→3 顺序"
- **2026-06-22**：实施完成（commit `9fbb317`，379 files changed，55,546 insertions）
- **2026-06-22**：review 修复完成（commit `e03d2d1`，15 files changed，22,462 deletions 主要是 22K swagger）
- **2026-06-22**：AGENTS.md / CLAUDE.md / 00-overview.md 同步更新（commit 待补）
- **2026-06-22**：本 ADR-0005 创建

---

## 9. 后续 ADR 候选

- ADR-0006：Gitea 缓存层文件 KV 设计（v2.1）
- ADR-0007：GitHub 完整支持范围（v2.1+）
- ADR-0008：Wails v3 迁移路径（待 v3 稳定）
