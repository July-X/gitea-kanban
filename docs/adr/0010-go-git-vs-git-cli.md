# ADR-0010 · git / gh / go-git 使用规范（v0.7.22）

> **状态**：已拍板（用户 2026-07-21 拍板）
> **决策日期**：2026-07-21
> **背景**：v0.4.0 起项目用 go-git 替代 `exec.Command("git", ...)` 子进程（AGENTS §6.5 记录），后续 v0.7.20 引入 gh CLI 路径补足 blobless clone / GitHub 认证。v0.7.22 用户报 Gitea 大仓库"100% 还在下载 + Git Graph 没信息"时复盘发现：go-git PlainClone 不支持 `--filter=blob:none`（下 blob），Gitea 走 go-git 链路会下 28GB blob，根因是工具选型没分场景。

## 背景

仓库内同时存在 3 个 git 工具，**当前没有规范说"什么场景用哪个"**，导致：
- Gitea 走 go-git PlainClone（不支持 blobless）→ UnrealEngine 级仓库下 28GB blob
- GitHub 走 gh + `--filter=blob:none`（blobless）→ 同一仓库只下 ~MB
- 读 DAG 走 go-git log（no checkout + 内存态遍历）

工具能力对比：

| 工具 | blobless | NoCheckout | sideband progress | GitHub 认证 | macOS / Windows | Linux |
|---|---|---|---|---|---|---|
| **`git` CLI** | ✅ `--filter=blob:none` | ✅ `--no-checkout` | ✅ 原生 | ❌ 需 token | 内嵌（v0.4.0）| PATH |
| **`gh` CLI** | ✅ 透传给 git | ✅ 透传给 git | ✅ 透传给 git | ✅ OAuth | 系统 PATH | 系统 PATH |
| **`go-git` v5** | ❌ 不支持 | ✅ `NoCheckout: true` | ⚠️ sideband 文本解析（输出格式不完整） | ✅ `http.BasicAuth` | go 库无系统依赖 | go 库无系统依赖 |

## 决策（用户拍板原则）

按**操作类型 + 平台**二分决策：

### Clone / Fetch（**写操作**——传输 bytes）

| 场景 | 工具 | 理由 |
|---|---|---|
| **GitHub 仓库** | `gh repo clone` / `gh fetch`（**优先**）→ fallback `git` CLI | gh 自带 OAuth 认证 + blobless + sideband 透传；系统无 gh 时降级 git |
| **Gitea 仓库** | `git` CLI | Gitea 不走 OAuth 走 PAT，git CLI 已内嵌；blobless + sideband 都支持 |

**Gitea 路径不再用 go-git**——go-git PlainClone 不支持 blobless，大仓库会下 28GB blob。

### 读 DAG（**读操作**——本地元数据遍历）

**统一用 go-git**：
- `git.PlainOpen` 打开仓库
- `repo.Log(...)` 遍历 commit DAG
- `repo.Storer.SetReference(...)` 写 HEAD ref
- `countCommitsWithLimit` 统计 commit 数
- `LogCommits` 拉 commit 列表给 graph layout
- `currentHeadInfo` / `resolveOriginHead` 解析 HEAD

go-git 的**优势**：
- 纯 Go，无 CGO，无外部 git 二进制依赖
- 内存态遍历，无 sideband 文本解析负担
- 跟 v0.4.0 之前 `spawn('git', ...)` 子进程方案解耦
- 写操作（clone / fetch）的失败模式不污染读路径

**go-git 的劣势**（仅在写操作路径体现）：
- 不支持 `--filter=blob:none` → 大仓库浪费磁盘
- sideband progress 输出不完整（部分 packfile 阶段不报百分比）→ 前端 progressByRepo 收不到最后几帧
- 跨平台 HTTP 鉴权绕不开系统 keyring（需要 go-keyring 注入）→ 复用 `app/secret` 包

### 进度回调（progress callback）

**所有写操作都通过 `git.ProgressCallback` 抽象回调**（`app/git/progress.go:75`）：
- `git.PlainClone` 走 `SidebandWriter` 包装 → `ParseProgress` 解析 sideband 文本 → `cb(SyncProgress)`
- `gh repo clone` / `gh fetch` / `git fetch --filter=blob:none` 走**不传** progress（gh 透传给 git 时无 progress 注入）
  - 写操作完成后**手动调** `EmitProgress(cb, StageDone/StageError, ...)` 显式发最终态

前端监听 `git:sync:progress` 事件（`frontend/src/stores/repo.ts:435`）→ 写 `progressByRepo` ref → `StatusBar.vue:536` 渲染进度条。

## 当前实现

| 路径 | 工具 | 文件 |
|---|---|---|
| Gitea `CloneRepo` | **go-git PlainClone**（**未切到 git CLI，**待迁移） | `app/git/clone.go:240` |
| GitHub `CloneRepo` (走 `UseGitHubCLI=true`) | `gh repo clone -- --filter=blob:none --no-checkout --no-single-branch` | `app/git/clone.go:184` → `app/git/native.go:CloneWithFilter` |
| `FetchRepo` go-git 路径 | `remote.FetchContext` + sideband | `app/git/sync.go:177` |
| `FetchRepo` gh 路径 | `gh auth git-credential` + `git fetch --filter=blob:none` | `app/git/sync.go:129` → `app/git/native.go:FetchWithFilter` |
| `LogCommits` / `CountCommits` / 读 HEAD | **go-git** | `app/git/log.go` / `app/git/repo.go` |
| Graph layout（vscode-git-graph 复刻） | **go-git** 输入 + 自研 layout | `app/git/graph/layout.go` |

## 迁移计划（Gitea 切到 git CLI）

> 用户已拍板"go-git 只做它擅长的部分"（Gitea 不再用 PlainClone），但**当前未实施**。本节是未来 PR 的实施约束。

### 新增 helpers

`app/git/native.go` 末尾新增：

```go
// gitClone 用 git CLI clone 仓库（blobless + NoCheckout）
//
// 替代 go-git.PlainClone 的统一方案：
//   - git CLI 对 HTTP progress 支持更好（sideband progress 输出稳定）
//   - Gitea / GitHub 统一走此路径，行为一致
//   - git clone --filter=blob:none --no-checkout 不下载 blob + 不写 worktree
//
// 参数：
//   - url: 仓库 URL（HTTPS / SSH）
//   - localPath: 本地目标路径
//   - depth: 深度限制（0 = 无限制）
//   - token: HTTPS 认证 token（SSH 不需要）
//
// 错误处理：
//   - 超时（5 min）：返回 timeout 错误
//   - 失败：清理半成品目录（`os.RemoveAll(localPath)`）
//   - SSH 失败：自动回退 HTTPS（仿 go-git 链路 clone.go:243-275 的回退逻辑）
func gitClone(url, localPath string, depth int, token string) error { ... }

// waitForCommitsAvailable 轮询 git rev-list --all --count，直到 commit 数 > 0 才返回。
//
// 用于 gh partial clone / git fetch 场景：命令退出只代表 refs 拉完，commit 对象懒加载。
// 大仓库（UnrealEngine 264k commits）懒加载可能持续几分钟。
//
// 参数：
//   - localPath: 本地仓库路径
//   - timeout: 最长等待时间
func waitForCommitsAvailable(localPath string, timeout time.Duration) error { ... }
```

### `CloneWithFilter` / `fetchRemoteWithFilter` 加 wait

成功后调 `waitForCommitsAvailable(localPath, 20*time.Minute)` 确认 commit DAG 真正可用再返回。

### `app/git/clone.go` 替换

`CloneRepo` 的 go-git PlainClone 块（`clone.go:211-308`）整体替换为 `gitClone(finalURL, localPath, opts.Depth, opts.Token)` 调用 + `waitForCommitsAvailable` 等待。

清理 import：`"github.com/go-git/go-git/v5"`、`plumbing`、`transport/http`（仅 PlainClone 用的话）。

### 进度回调迁移

`git.Clone` / `git.Fetch` 不传 sideband 进度（git CLI 原生 progress 输出格式不固定）——改为：
- 写操作前后**手动调** `EmitProgress(cb, StageCounting/Receiving/...)`（粗粒度阶段）+ `StageDone`（最终）
- 前端 progress 仍走 `git:sync:progress` 事件 + `progressByRepo` ref

**详细事件序列**：
1. 写操作开始前 → `cb({Stage: counting, Percent: 0})`
2. 写操作进行中 → 通过 `gitbinary.RunGitWithEnv` 的 stderr parser 解析 `Receiving objects: N%` 行 → `cb({Stage: receiving, Percent: N})`
3. 写操作完成 → `cb({Stage: done, Percent: 100})`

## 测试覆盖

| 测试 | 现状 | 迁移后 |
|---|---|---|
| `app/git/clone_test.go:TestCloneRepo_FilePath` | 测 `RepoLocalPath` 路径 | 不变 |
| `app/git/clone_test.go:TestCloneWithFilter_GhNotInstalled` | gh 缺失 → IpcError | 不变 |
| `app/git/sync_test.go:TestFetchWithFilter_GhNotInstalled` | gh 缺失 → IpcError | 不变 |
| `app/git/clone_test.go:TestCloneRepo_E2E*` | 走 go-git PlainClone + LocalStack Gitea | **改**：走 git CLI + Gitea docker |
| `app/git/clone_test.go:TestCloneRepo_BloblessNotInGitHub` | 验 GitHub 走 gh | 不变 |
| `app/git/clone_test.go:TestCloneRepo_LocalStack_Gitea` | go-git PlainClone + LocalStack | **改**：git CLI + LocalStack |
| `app/git/sync_test.go:TestPullRepo_LocalStack_Gitea` | go-git remote.FetchContext | **改**：git CLI fetch + LocalStack |

## 回归风险

| 风险 | 缓解 |
|---|---|
| `git` CLI 跨平台差异（macOS / Windows / Linux） | 走 `gitbinary.RunGitWithEnv` 统一包装（v0.4.0 已建），统一路径解析 + env 注入 |
| 用户在 SettingsView 自定义 git 路径 | 走 `gitbinary.ResolveGitBinaryPath` 解析（v0.4.0 兼容） |
| SSH 鉴权失败 | `gitClone` 内部 try SSH → fallback HTTPS（同 go-git 链路 clone.go:243-275 行为） |
| blobless 懒加载期间 loadGraph 拿到 truncated=true | `waitForCommitsAvailable` 阻塞等 commit DAG 就绪再返回 |
| 进度事件格式不固定（git CLI 原生 progress） | 维护 `gitProgressParser` helper 解析 `Receiving objects: N%` 行 |
| 现有 go-git 测试用例全要改 | 评估测试投入：~3-5 天迁移 LocalStack Gitea e2e |
| go-git 完全退场风险 | go-git 仍用于读 DAG（`log.go` / `repo.go` / `graph/`），写操作只用 git CLI |

## 不决事项（不在本 ADR 范围）

1. **进度事件 schema 变更**（v0.8.x）：是否在 `SyncProgress` 加 `bytesReceived` / `bytesTotal` 字段？当前只有 percent + stage + cur + total
2. **进度回调注入点**：`gitClone` helper 的 `cb` 是函数参数 vs 全局 var？当前是参数（更易测试），不动
3. **blobless 模式的可配置性**：用户可能需要"全量 clone 看代码"——加 `NoFilter: bool` 字段？当前一律 blobless
4. **macOS 沙箱 vs git CLI 调用**：用户在沙箱（reasonix）内 clone 时 git CLI 需要 `PATH` 可达 + 读 .ssh 权限；当前依赖内嵌 git 二进制，绕过系统 PATH
5. **GitHub Enterprise / 自托管 Gitea 的 OAuth 配置**：gh 需要 `GH_HOST` env，git CLI 需要 token；当前用 token 路径，OAuth 是后续工作

## 关键文件清单

| 文件 | 角色 |
|---|---|
| `app/git/clone.go` | `CloneRepo` 入口，v0.7.22 改造后只调 `gitClone` + `waitForCommitsAvailable` |
| `app/git/sync.go` | `FetchRepo` / `PullRepo` 入口，v0.7.22 改造后只调 `fetchRemoteWithFilter` + `waitForCommitsAvailable` |
| `app/git/native.go` | git CLI / gh CLI 调用封装 + `gitClone` / `waitForCommitsAvailable` helper |
| `app/gitbinary/runner.go` | 跨平台 git 二进制路径解析 + `RunGitWithEnv` 统一包装 |
| `app/git/progress.go` | `ProgressCallback` 抽象 + `SidebandWriter`（go-git 用）+ `EmitProgress`（手动发事件） |
| `app/git/log.go` / `app/git/repo.go` | 读 DAG，全 go-git |
| `app/git/graph/layout.go` | Graph 布局，输入是 go-git LogCommits 输出 |
| `frontend/src/stores/repo.ts:435` | 订阅 `git:sync:progress` 事件 → `progressByRepo` ref |
| `frontend/src/components/StatusBar.vue:536` | 渲染进度条 + 按钮文字 |
| `AGENTS.md §6.5` | 旧版"go-git 替代 spawn('git')"规范（本 ADR 扩展） |
| `AGENTS.md §8.5` | 沙箱/容器内启动注意事项（与本 ADR 风险 4 相关） |

## 后续 PR 计划

1. **v0.7.23**：新增 `gitClone` / `waitForCommitsAvailable` helper + 单元测试（不替换 PlainClone）
2. **v0.8.0**：Gitea 路径切到 `gitClone`（保留 SSH 回退）+ `CloneWithFilter` / `fetchRemoteWithFilter` 加 wait
3. **v0.8.x**：e2e 测试迁移（LocalStack Gitea + Docker Gitea）+ 进度回调 schema 扩展
4. **v0.9.0**：go-git 完全退场写路径；read 路径保留（无迁移计划，DAG 遍历内存态最稳定）
