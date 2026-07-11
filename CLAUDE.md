# CLAUDE.md — gitea-kanban

> 这是给 Claude 的工作指引版摘要。若与 `AGENTS.md` 冲突，以 `AGENTS.md` 为准。
>
> **最后更新**：2026-07-12（v2.0 + v2.4 + v2.5 + v2.6 + v3.x + v0.3.0 + v0.5.3 + v0.6.0 + v0.7.0 + v0.7.1 + v0.7.2）。详细版本演进看 [AGENTS.md](./AGENTS.md) 顶部。

## 项目一句话

`gitea-kanban` 是一个基于 Gitea/GitHub 的桌面端看板 + Git Graph 工具，技术栈固定为 **Go + Wails v2 + Vue 3**（v1 时代的 Electron+TypeScript+SQLite 已迁移完成）。

目标用户包含非技术人员，所以 UI 必须零术语、危险操作二次确认、错误提示要人话。

## 固定技术栈（v2.0 + v2.4 + v2.5 + v2.6 + v3.x + v0.3.0 + v0.5.3 + v0.6.0 + v0.7.0 + v0.7.1 + v0.7.2）

> **v2.4 增量**：go-git 走 `NoCheckout=true` 轻量模式（只拉元信息，磁盘 -99%）；所有 Wails binding 接受 `projectId` / `owner+repo` 业务态概念（Go 端反查 `localPath + token`，AGENTS §8.1 鉴权铁律）
>
> **v2.5 增量**：workspace 按账号分层（旧布局自动迁移到 `_pre_v25_workspace` 备份）
>
> **v2.6 增量**：StatusBar 同步进度条（go-git sideband → EventsEmit → 前端 UI）
>
> **v0.5.0 增量**：PR 评论模块 M1-M4 完整交付。文件评论（PullFileComments.vue + 4 个 platform adapter 方法 + 4 个 bindings）、对话流融合 Review 事件系统消息、三 Tab PR 详情布局（概览/文件评论/对话），TS DTO + store + ipc-client 扩展。docs/adr/0008 + docs/releases/v0.5.0.md。
>
> **v0.6.0 增量**：app.go 9 文件拆分（主文件 226 行）+ MergesView 三 Tab 重构 + PR 属性编辑器（Milestone / Review 行内评论 / Assignee 多选）+ store-first 封装（`updateLabels / updateAssignees / updateReviewers / updateMilestone` actions）+ 提交签名验证 9 种状态 + commit 计数 badge + GitHub PR 闭环。docs/releases/v0.6.0.md。
>
> **v0.7.0 增量**：GitHub adapter 5 方法补全（`ListLabels` / `ListMembers` / `ListMilestones` / `UpdatePullMilestone` / `ListPullCommits`）+ 属性编辑器对 GitHub 数据源可用（放开 v-if）+ GitHub milestone 进入 PR 详情 + `CreatePullReview` 行内评论 + 跨平台 build CI。docs/releases/v0.7.0.md。
>
> **v0.7.1 增量**：PR 对话区对齐 Gitea web（评审拆 2 卡 / 合并检查警告区 toggle / 系统事件卡独立渲染）+ Timeline 数据源切换（`/issues/{index}/timeline` 端点 + TimelinePanel store）+ pnpm typecheck 60 → 0 错。docs/releases/v0.7.1.md。
>
> **v0.7.2 增量**：视觉 1:1 对齐 Gitea web —— 5 档颜色（success/danger/merge/warn/neutral）+ 21 个 lucide icon 替代 Unicode + 7 类系统事件二级详情块（label/milestone/assignees/title/branch/ref/dependency）+ 气泡左箭头 CSS 三角形 + Dismiss review 拆 2 卡。后端 `platform.TimelineItem` 加 12 个二级详情字段 + `IssueDTO` 加 3 个跨仓 ref 字段 + `TestGiteaAdapter_ListPullTimeline_DetailFields` 7 类系统事件解析测试。docs/releases/v0.7.2.md。
>
> **v3.0–v3.14 历史**：Git Graph 严格 1:1 复刻 vscode-git-graph（已上述 v0.5.3 为准）

- 运行时：Go 1.22+ + Wails v2.12（用系统 WebView，非 Chromium）
- git 客户端：go-git v5（纯 Go，无 CGO，替代旧的 spawn('git')；v2.4 走 NoCheckout 轻量模式）
- 凭证：zalando/go-keyring（纯 Go，替代旧的 @napi-rs/keyring napi 二进制）
- 本地库：**JSON 文件 + 文件 KV**（延续 ADR-0003 零 SQLite 决策）
- 同步队列：queue.jsonl（append-only JSONL）
- Gitea 集成：Go `net/http` 手写（替代旧的 gitea-js）+ `PlatformAdapter` 抽象层
- 日志：`log/slog` + 文件 transport
- 测试：Go 标准 `testing` + `httptest`（**60+ 测试用例覆盖 11 个 Go 包**，含 v2.4 新增 18+ 测试）
- 前端：Vue 3 + Vite + Pinia + Vue Router（**前端 v1 完全保留**）
- 打包：Wails build（macOS .app / Windows .exe / Linux AppImage）

## 多平台支持（v2.0 核心特性）

| 平台 | 鉴权 | 首期支持 |
|---|---|---|
| **Gitea** | `Authorization: token <pat>` | 完整：仓库/分支/Git Graph/议题/合并/标签/成员 |
| **GitHub** | `Authorization: Bearer [redacted]` | **PR 闭环 + 属性编辑器已完成**（v0.7.0 补 5 方法：ListLabels / ListMembers / ListMilestones / UpdatePullMilestone / ListPullCommits） |

GitHub Issue 暂不做（等 v0.7.x）；GitHub 看板暂不做。

## 关键产品约束

- Gitea/GitHub API 是 source of truth，本地只存偏好、缓存和必要的派生数据
- 不做 OAuth2，不做 nginx 反代，不做实时协作，不做 in-app 冲突解决
- token 只允许在 Go 进程内存和系统 keychain 中存在，不能写文件、state.json、日志、前端
- UI 文本禁止直接出现 `PR`、`merge`、`rebase`、`fork`、`repo`、`branch`、`maintainer` 等原词，必须走项目翻译表
- 危险操作必须二次确认，并说明影响
- 离线时降级到本地缓存（v2.1 计划加文件 KV 缓存层），写操作入队 queue.jsonl
- 主题策略按 v1.2 拍板的 2 主题方案（dark/light），不要自行改回多主题

## 目录边界

- `main.go` / `app.go` / `app/**`：Go 后端（Wails binding 入口 + 业务逻辑）
- `frontend/src/**`：Vue 3 渲染端
- `docs/design/**`：设计文档（部分已 deprecated，详见各文件顶部）
- `docs/adr/**`：架构决策记录
- `design-system/gitea-kanban/OVERRIDE.md`：当前生效设计系统

**不要跨边界写代码**：

- 不要在 Go 后端写 Vue 组件 / CSS
- 不要在渲染端调 Gitea API（必须走 Wails binding → Go 后端）
- 不要在渲染端改 `frontend/src/types/dto.ts` 的字段定义（DTO 是 binding 契约，前后端共享）

## 数据模型

- 业务态 8 张表（**全部**在 `${dataDir}/state.json`，由 `app/store/store.go` 的 `LocalState` 定义）
- v2 新增 `Platform` 字段（`gitea` / `github`），旧数据迁移默认 `gitea`
- 原子写（tmp + rename）+ 并发安全（`sync.RWMutex`）
- Workspace 路径：默认 `~/.gitea-kanban/workspace`，repos 存 `${workspace}/repos/${username}/${owner}__${repo}/`（v2.5 按账号分层；旧布局自动迁移到 `_pre_v25_workspace` 备份）
- 同步队列：`${dataDir}/queue.jsonl`（append-only + 崩恢复 + 30 天 GC）

## Wails Binding 模式

- 所有 Go → 渲染端的 binding 方法都集中在 `app.go` 的 `App` struct 上
- 签名：`(args struct) (result, error)`
- Wails 自动生成 TS bindings 到 `frontend/wailsjs/wailsjs/go/main/App.d.ts`
- 前端通过 `import { GetAppInfo } from '../wailsjs/go/main/App'` 调用
- 迁移期兼容：`frontend/src/lib/wails-api-shim.ts` 提供 `window.api.<namespace>.<method>()` 兼容层（旧 IPC 风格），逐步替换

## 安全与日志

- Go 端无 Electron sandbox；Wails 用系统 WebView 自带安全模型
- 渲染端默认 `contextIsolation: true`、`nodeIntegration: false`
- token 走 `go-keyring` 写系统 keychain（macOS Keychain / Windows Credential Vault / Linux Secret Service）
- dev fallback：文件 `userData/dev-tokens/<service>__<username>.json`（0600 权限）
- 主进程文件 I/O 走白名单，不接受用户绝对路径作为任意输入
- `MigrateRepo` 沙箱校验：`newWorkspacePath` 必须在 `allowedRoot` 之下
- `slog` 禁止把 `token` / `password` / `key` 等写入日志

## 路径规则

- 数据根目录：`GITEA_KANBAN_DATA_DIR` 环境变量 → 兜底 `~/.gitea-kanban`
- 日志目录：`${dataRoot}/logs/main/main.log`
- 不要再回到 `app.getPath('userData')`（Electron 概念，已不适用）

## 测试与验证

- Go 后端：`go test ./app/...`（9 个包 50+ 测试）
- 渲染端：Vitest（**当前 0 个运行**，v1 测试已归档）
- 关键 Go 测试：
  - `go test ./app/git/...`（clone/log/workspace/sync/lock）
  - `go test ./app/platform/...`（gitea+github adapter）
  - `go test ./app/secret/...`（凭证 fallback）
  - `go test ./app/store/...`（业务态）
  - `go test ./app/sync/...`（队列）
- `go vet ./...` 必须无 error
- `go build -o /dev/null .` 必须通过
- 前端类型检查走 `cd frontend && pnpm typecheck`；不要临时手写后台 `npx vue-tsc --noEmit &` + `sleep/kill/ps` 脚本，容易拿错 `$!` 并误判卡住
- `wails build` 至少 macOS 通过

## 启动调试（Wails v2，没有 Electron CDP）

Wails v2 没有 Electron 那套 CDP 远程调试端口（v1 的 9492 已不适用）。

```bash
# 设独立 data dir 避免污染
export GITEA_KANBAN_DATA_DIR=/tmp/gitea-kanban-debug
rm -rf "$GITEA_KANBAN_DATA_DIR"

# 后台跑 dev
GITEA_KANBAN_DATA_DIR="$GITEA_KANBAN_DATA_DIR" wails dev > /tmp/wails-dev.log 2>&1 &
sleep 10

# 看日志（slog 写文件，stdout 看不到）
tail -50 "$GITEA_KANBAN_DATA_DIR/logs/main/main.log"
```

常见启动问题：
1. macOS SIP 写权限 → 用 `GITEA_KANBAN_DATA_DIR=/tmp/...`
2. state.json 损坏 → 删 `state.json` 重启
3. go-git clone 失败 → 网络/token 问题，看 slog
4. wails 找不到 go/node → `wails doctor`

## 提交规范

- commit message 必须中文
- 格式：`<type>: <中文一句话描述>`
- type 只用 `feat / fix / refactor / perf / chore / test / docs / style`
- 阶段性交付要有 commit 和 hash
- 不要加 `Co-Authored-By`
- 当前单分支 `main`（v1 是 `master`，v2 已迁回 `main`）

## 常用文档入口

- `AGENTS.md`（**最权威**）
- `docs/adr/0005-electron-to-go-wails-migration.md`（v2.0 迁移决策）
- `docs/adr/0006-v24-iteration-fixes.md`（**v2.4 迭代修复**：鉴权铁律 / binding 补全 / 数据目录 / 反查链路 / prefs / go-git 轻量模式 6 个决策）
- `docs/design/07-v24-iteration.md`（v2.4 迭代记录：6 类问题的症状/根因/修复/回归测试）
- `docs/design/00-overview.md`（v1 综述，**部分已 deprecated**，v2.0/v2.4 横幅已加）
- `docs/design/02-architecture.md`（**DEPRECATED**，基于 Electron）
- `docs/design/03-frontend.md`（前端设计，v2 仍有效）
- `docs/design/06-gitgraph.md`（Git Graph 设计，v2 仍有效）
- `design-system/gitea-kanban/OVERRIDE.md`（当前生效设计系统）

## 实际工作提醒

- 任何开始前，先确认当前上下文是否已经有相关实现或历史决策
- 遇到不确定的库、框架、CLI、SDK，用官方文档确认，不要凭记忆
- 如果要改 UI，优先保持本项目已有的设计系统和零术语规则
- Go 代码优先用标准库 + go-git + zalando/go-keyring，不要引入新依赖除非必要
- 后端方法签名（含参数/返回 struct 字段）变化会同时影响 Wails 生成的 TS 类型和前端调用，要同时改两端并测试
