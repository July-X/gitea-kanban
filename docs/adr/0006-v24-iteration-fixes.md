# ADR-0006: v2.4 迭代修复（迁移到 Go+Wails 后的工程化收尾）

> **状态**：✅ Accepted（2026-06-22）
> **触发**：v2.0 迁移完成（ADR-0005）后真实用户桌面跑暴露 6 类问题
> **影响范围**：鉴权铁律 / Wails binding 覆盖 / 数据目录 / go-git 同步策略 / 前端持久化
> **替代**：v2.0 迁移 commit `9fbb317`（业务 stub 残留 + 违反鉴权铁律）

---

## 1. 背景与动机

ADR-0005 把 v1 Electron 栈替换成 Go+Wails，9 个 Go 包 50+ 测试全过、Wails build 成功。但**真实用户点开桌面窗口**后立刻暴露 6 类问题：

| # | 症状 | 根因 |
|---|---|---|
| 2.1 | 端到端能跑通，但 token 走了 IPC 违反鉴权铁律 | `App.CloneRepo` 接受 `Token` 字段 |
| 2.2 | "填 token 无法使用" / "刷新仓库没反应" | 16 个 Wails binding 全是 stub |
| 2.3 | `~/.gitea-kanban/workspace/workspace` 嵌套目录 | v2.0 早期版本假设错位 |
| 2.4 | "更新失败：localPath 不在 workspace 下" / "选了仓库后 Git Graph 仍不能用" | 前端拼错 `~/.gitea-kanban/...`（带 `~`）+ `gitgraphLines` 是 stub |
| 2.5 | "选择完仓库应用没记住" | `user.prefs.set` 是 `notImplemented` |
| 2.6 | "workspace 50MB 太占盘" | go-git 默认 `PlainClone` 拉工作区文件 |

每条都对齐 AGENTS §13 第 1 / 2 / 4 / 5 类（改技术栈 / 改数据模型 / 改 Wails binding 契约 / 改设计原则），需要走 ADR 流程。

---

## 2. 决策

### 2.1 token 鉴权铁律（v2.3）

**采纳**：所有 Wails binding **不接受** token 字段，Go 端从 `secret.Store`（go-keyring + dev fallback）拿。

**实施**：
- `App.CloneRepoArgs` 删 `Token string` → 新签 `{Platform, HostURL, Username, Owner, Repo}`
- `App.PullRepoArgs` 删 `Token + Username` → 新签 `{LocalPath}`（Go 端从 localPath 反查）
- 新增 `App.PullRepoByProjectId({ProjectID})` —— **正路**：前端只传 projectId，Go 端按 owner+repo + workspacePath 算
- 新增内部 helper `resolveTokenByLocalPath(localPath)` 和 `findProjectAndAccount(projectID)` —— 统一反查入口

**理由**：AGENTS §8.2 鉴权铁律 + keychain 设计（ADR-0001）。即使 Wails 内部 IPC 安全，**架构上 token 不应离开 Go 进程内存**（除 keychain 写一次）。

**拒绝的替代**：
- ❌ 前端拿 token 显式注入到 `Authorization: Bearer` 头：安全 token 在 JS heap 暴露
- ❌ 用临时文件存 token 走 IPC：违反"不落盘"原则

**回归测试**：
- `app_clone_test.go::TestApp_CloneRepo_NoTokenInArgs`
- `app_clone_test.go::TestApp_ResolveTokenByLocalPath`

---

### 2.2 业务 binding 补全（v2.4）

**采纳**：把 v2.0 留的 16 个 stub binding 全补上 Go 端实现 + shim 转发。

**清单**（按命名空间）：
| 命名空间 | 新增 binding |
|---|---|
| `auth.*` | `AuthConnect` / `AuthStatus` / `AuthDisconnect` / `AuthDisconnectOne` / `AuthSwitchAccount` |
| `repos.*` | `ListRepos` / `AddProject` / `RemoveProject` |
| `commits.*` | `gitgraphCloneRepo` / `gitgraphIsRepoCloned` / `gitgraphPull`（projectId 模式） |
| `system.*` | `openPath` |
| 根级 | `GetUserPrefs` / `SetUserPrefs` / `OpenDataDir` / `GetGitGraph` / `GetRepoById` / `PullRepoByProjectId` |

**理由**：
- v2.0 迁移时只接通了"Git Graph 链路"（CloneRepo/LogGraph/PullRepo 三个）
- 业务侧（auth / repos / 系统）stub 完整但**真实跑就会爆**
- shim → Wails binding 这层是 v2.x 的强约束（AGENTS §6.2 binding 契约），不能跳过

**实施**：
- Go 端 App struct 上添加对应方法（按 Wails `Bind` 自动扫描）
- shim 用 `forwardToWails` helper（之前 v2.0 时已有，v2.4 复用）
- `wails generate module` 自动生成 `frontend/wailsjs/wailsjs/go/main/App.d.ts` + `models.ts`
- 前端通过 `import { AuthConnect } from '@main/wailsjs/go/main/App'` 强类型调用

**回归测试**：
- `app_repos_test.go::TestApp_ListRepos_BasicFlow` / `TestApp_ListRepos_MergesIsProject` / `TestApp_ListRepos_AccountNotFound`
- `app_repos_test.go::TestApp_AddProject_Idempotent` / `TestApp_RemoveProject`
- `app_prefs_test.go::TestApp_SetUserPrefs_ReconcilerForStatusbar`（**端到端 e2e**）

**拒绝的替代**：
- ❌ "不补，让用户等 v2.5"：v2.0 已经是 release 状态，9 个 Go 包测试都过，理论上能跑 —— 不补直接 release 是误导
- ❌ 用前端 IndexedDB / localStorage 替代 Go 端 binding：违背 Wails 架构

---

### 2.3 数据目录收尾（v2.2 + v2.4）

**采纳**：
- `~/.gitea-kanban/` 作为**根目录**（应用数据根）
- 直接子级 = 业务目录（state.json / logs/ / dev-tokens/ / workspace/）
- `~/.gitea-kanban/workspace/` 是**唯一** git repos 目录，**禁止嵌套** `workspace/workspace/`
- workspace 路径**不可改**（连接界面 / 设置界面都不暴露修改入口）
- 设置界面"打开应用数据目录"按钮 → `open` / `explorer` / `xdg-open`

**最终布局**：

```
~/.gitea-kanban/                  ← dataDir 根
├── state.json
├── logs/main/main.log
├── dev-tokens/
└── workspace/                    ← git repos 唯一
    └── repos/<owner>__<repo>/
```

跨平台默认：
- macOS/Linux: `~/.gitea-kanban/...`
- Windows: `%USERPROFILE%\.gitea-kanban\...`

**理由**：
- 用户明确拍板"根目录是 `~/.gitea-kanban`，子级直接放业务目录"
- 嵌套 `workspace/workspace` 视觉上像 bug 路径，容易误删
- 不可改 workspace 路径减少"我能不能换到 ~/Documents"这种无效功能维护成本
- "打开应用数据目录"按钮足够让用户做 git 操作（手动 reset / 看 log）

**拒绝的替代**：
- ❌ 沿用 v1 的 `app.getPath('userData')` 嵌套：v2.0 已经迁到 `GITEA_KANBAN_DATA_DIR`，不能回退
- ❌ 允许用户改 workspace：增加 IPC 接口和测试矩阵，对应"git 元信息够画图"的轻量模式来说不必要

**实施**：
- `app/config/config.go::NewLogger` 写 `${dataDir}/logs/main/main.log`
- `app/git/workspace.go::NewWorkspaceManager.defaultPath = ${home}/.gitea-kanban/workspace`（无嵌套）
- `app.go::OnStartup` 计算 `a.workspacePath = ${dataDir}/workspace`（单层）
- `App.SetWorkspace` 改成"永远返 ValidationFailed + slog.Warn"（保留 binding 兼容旧前端）
- `App.OpenDataDir()` 跨平台实现（`open` / `explorer` / `xdg-open`）
- 前端 `AuthView` 删 workspace path 输入框
- 前端 `SettingsView` 工作区 section 改成只读 + "打开应用数据目录"按钮
- 删 `WorkspaceMigrateDialog.vue` 相关代码（workspace 不可改，迁移没意义）

**回归测试**：
- `app_data_layout_test.go::TestApp_OnStartup_DataLayout` —— 断言 4 个目录 + **反嵌套断言**（`workspace/workspace` 不存在）
- `app_data_layout_test.go::TestApp_GetWorkspace_ReturnsRepoWorkspace` —— 默认路径 = `${dataDir}/workspace`
- `app_data_layout_test.go::TestApp_SetWorkspace_AlwaysRejects` —— v2.2 后永远拒绝
- `app_data_layout_test.go::TestApp_DataDir_ResolveConsistency` —— workspace 是 dataDir 直接子级

---

### 2.4 StatusBar 反查链路（v2.4）

**采纳**：前端 StatusBar 操作（同步/更新/查看）只传 `projectId`，Go 端反查 localPath + token。

**链路**：
```
StatusBar.onSyncClick(r)
  → repo.cloneRepo(owner, name)
    → ipc-client.commitsGitgraphCloneRepo({owner, repo})
      → shim.gitgraphCloneRepo(args)
        → window.go.main.App.CloneRepo({platform, hostUrl, username, owner, repo})
          → findProjectByAccountId → secretStore.Get(token) → adapter.CloneRepo
            → git.PlainClone(localPath, {NoCheckout: true}, ...)
              → 返 {localPath}
```

**理由**：
- v2.3 早期 `onUpdateClick` 用 `import.meta.env.VITE_GITEA_KANBAN_WORKSPACE` 拼 `~/.gitea-kanban/workspace/...`（带 `~`）
- Go 端 `filepath.Rel(a.workspacePath, localPath)` 拒绝 `~` 路径（`~` 在 `filepath.Rel` 不展开为 `$HOME`）
- 修法 A（前端不拼 `~`）：用 `process.env.HOME` 替换 → 又依赖前端 env
- 修法 B（前端传 owner+repo）：Go 端 `git.RepoLocalPath(workspacePath, owner, repo)` 算 → 跨平台一致
- 修法 C（前端传 projectId）：Go 端 `findProjectAndAccount` + `git.RepoLocalPath` → 更进一步，前端不用知道任何路径细节

**选 C** + 新增 `GetRepoById` 让前端"一次拿齐 project + account + localPath + cloned"

**新增 binding**：
- `App.GetGitGraph({projectId, branches?, maxCount?})` —— Git Graph 业务
- `App.GetRepoById({projectId})` —— 状态查询
- `App.PullRepoByProjectId({projectId})` —— pull 业务

**新增内部 helper**：
- `findProjectAndAccount(projectID) → (*RepoProject, *GiteaAccount, error)`
  - localStore.Projects 找 project
  - localStore.Accounts 找关联 account
  - 任一缺失返 NotFound（带具体 cause）
- 复用 `resolveTokenByLocalPath(localPath)` —— 老的 `PullRepo(localPath)` 也用

**拒绝的替代**：
- ❌ 前端维护 `{fullName → localPath}` 缓存：跟 localStore 重复源，且 workspace 路径不可改后没必要
- ❌ 暴露 workspacePath 给前端（违反 2.3 决策）：前端就拼不出 `~` 的坑

**回归测试**（`app_gitgraph_test.go`）：
- `TestApp_FindProjectAndAccount` —— project 找不到 / account 找不到 / 正常 三种 case
- `TestApp_GetRepoById` —— clone 前 cloned=false + 手动建 .git → cloned=true
- `TestApp_GetGitGraph` —— 空 projectId / 找不到 project / 正常路径（fake localPath → 走 adapter.LogGraph）
- `TestApp_PullRepoByProjectId` —— **关键反例断言**：错误**不是** `"localPath 不在 workspace 下"` / `"token 为空"` / `"未找到 project"`

---

### 2.5 用户偏好持久化（v2.4）

**采纳**：Go 端实现 `App.GetUserPrefs` / `App.SetUserPrefs`，读写 `state.Prefs`（`map[string]any`）；前端 `repo.persistLastSelected` / `restoreLastSelected` 改为 IPC 优先 + localStorage 兜底。

**理由**：
- v2.0 `shim.user.prefs.set = notImplemented` / `get = stubEmpty(null)` —— 双层死链
- 前端 `repo.persistLastSelected` 写 prefs 永远失败，只有 localStorage 兜底
- 重启 `restoreLastSelected` 读 prefs 永远 null，只能从 localStorage 恢复
- 跨设备 / 跨域 / Safari ITP / 隐私模式下 localStorage 失效 → "应用没记住"

**实施**：
- `App.GetUserPrefs({keys})` —— 返指定 key 的 map；不传 keys 返全部
- `App.SetUserPrefs({entries})` —— merge 写；`null` value 删 key；返 `{written, deleted}`
- shim 转发到 Wails binding
- 前端 `repo.persistLastSelected` 路径不变（写 prefs + localStorage 双源）
- 前端 `repo.restoreLastSelected` 路径不变（读 prefs 优先，fallback localStorage）

**回归测试**（`app_prefs_test.go`）：
- `TestApp_GetUserPrefs_All` / `TestApp_GetUserPrefs_ByKeys`
- `TestApp_SetUserPrefs_DeleteKey`
- `TestApp_SetUserPrefs_ReconcilerForStatusbar` —— **端到端 e2e**：app1 写 prefs → 杀 app1 → app2 读 prefs 验证

**拒绝的替代**：
- ❌ 纯 localStorage 持久化：跨设备/隐私模式失效
- ❌ 写文件到 workspace 根（`workspace/.last_selected`）：污染 git 目录，违反 v2.3 轻量模式
- ❌ 引入 SQLite：违反 ADR-0003 零 SQLite 决策

---

### 2.6 go-git 轻量模式（v2.4）

**采纳**：`git.CloneOptions.NoCheckout = true`，go-git 拉完整 `.git/objects/` 但**不** checkout 工作区文件。

**理由**（用户拍板 2026-06-22）：
> "go-git 同步逻辑应该是只拉取仓库的基础信息，用于渲染 git-graph 就足够了，而不是全部 clone 仓库文件。"

业务分析：
- 本应用**只**用 commit / tree / branch 元信息画 Git Graph
- 工作区文件（README / src/）**无业务需求**（没有"打开本地编辑器"功能）
- 典型仓库：50MB → 500KB（节省 99% 磁盘）
- Git Graph 业务**不受影响**（`LogCommits` + 自研 layout 走 `.git/objects/`，不读 worktree）

**实施**：
- `app/git/clone.go::CloneOptions` 删 `Bare` 字段，加 `NoCheckout bool` + `Depth int`（预留浅 clone）+ `URL string`（测试用）
- `app/git/clone.go::CloneRepo` 调 `git.PlainClone(localPath, false, &CloneOptions{NoCheckout: true})`
- `app/platform/{gitea,github}/adapter.go::CloneRepo` 显式 `NoCheckout: true`
- `app/git/sync.go::PullRepo` 适配 NoCheckout：fetch 后**主动**更新本地 HEAD ref 指向新 remote HEAD
  - 用 `repo2.Storer.SetReference(plumbing.NewHashReference(ref.Name(), remoteHead))`
  - 旧版 fetch 不 merge → HEAD 不动 → `AddedCommits` 永远 0
  - 新版 HEAD 推进 → 统计 commit 数能反映远端变化
- `app/git/sync.go::resolveOriginHead` helper：先读 `refs/remotes/origin/HEAD`，fallback 用 `refs/remotes/origin/{branch}`

**未启用** `Depth` 浅 clone：
- 浅 clone 会丢早期 commit → Git Graph lane 错位
- 不浅 clone 元信息也只占 ~MB 级（NoCheckout 后）

**回归测试**：
- `app/git/clone_test.go::TestCloneRepo_NoCheckout_NoWorktreeFiles` —— push README.md + main.go → clone → worktree **没有**这两个文件 + `LogCommits` 仍能跑（说明 .git/objects/ 完整）
- `app/git/sync_test.go::TestPullRepo` 升级 —— 验证新行为：`AfterCount` 1→2 / `AddedCommits`=1 / `HeadChanged`=true

**拒绝的替代**：
- ❌ 用 `Bare: true` 纯裸仓库：完全无 worktree 概念，但 go-git fetch 时 `repo.Head()` 行为不一样，适配更复杂
- ❌ `Depth: 100` 浅 clone：早期 commit 缺失 → 用户看到的 Git Graph 不完整
- ❌ 全 clone 工作区文件：磁盘占用大，无业务收益

---

## 3. 决策总表

| 决策 | 状态 | 关键反例测试 | 替换的 v2.0 行为 |
|---|---|---|---|
| 2.1 token 鉴权铁律 | ✅ | `TestApp_CloneRepo_NoTokenInArgs` | `CloneRepoArgs.Token = ""` 错误 |
| 2.2 业务 binding 补全 | ✅ | `TestApp_SetUserPrefs_ReconcilerForStatusbar` | `shim.auth.connect = notImplemented` |
| 2.3 数据目录收尾 | ✅ | `TestApp_OnStartup_DataLayout`（反嵌套） | `workspace/workspace` 嵌套 |
| 2.4 StatusBar 反查链路 | ✅ | `TestApp_PullRepoByProjectId` | `~/.gitea-kanban/...` 拼错 |
| 2.5 用户偏好持久化 | ✅ | `TestApp_SetUserPrefs_ReconcilerForStatusbar` | `user.prefs.set = notImplemented` |
| 2.6 go-git 轻量模式 | ✅ | `TestCloneRepo_NoCheckout_NoWorktreeFiles` | `git.PlainClone` 默认拉 worktree |

---

## 4. 影响

### 4.1 鉴权铁律强制

所有 Wails binding 的 token 字段全部删除。AGENTS §8.2 锁死。

### 4.2 前端 shim 全部转发

`frontend/src/lib/wails-api-shim.ts` 没有任何 `notImplemented` / `stubEmpty` 留在业务关键路径上。`forwardToWails` helper 统一处理降级（Wails 未启动时返合理 stub）。

### 4.3 数据布局单一性

`~/.gitea-kanban/` 根 + 直接子级业务目录。`workspace/workspace` 嵌套有专门测试断言禁止。

### 4.4 反查链路

所有 Wails binding 都接受业务态概念（`projectId` / `owner+repo`），不传路径细节。前端不再拼 `~/.gitea-kanban/workspace/...`。

### 4.5 持久化双源

prefs IPC（权威） + localStorage（兜底）。重启时优先 IPC，失败 fall back localStorage。

### 4.6 go-git 轻量

`PlainClone(_, false, {NoCheckout: true})` 替代 `PlainClone(_, false, {})`。磁盘占用 -99%。

---

## 5. 验证

```text
$ go test -race ./...
ok  gitea-kanban                    ~1.2s    ← 18+ 新测试（clones/repos/prefs/gitgraph）
ok  gitea-kanban/app/config
ok  gitea-kanban/app/git           ~10s     ← NoCheckout 集成测试
ok  gitea-kanban/app/git/graph      ~2s
ok  gitea-kanban/app/ipc
ok  gitea-kanban/app/platform
ok  gitea-kanban/app/platform/gitea
ok  gitea-kanban/app/platform/github
ok  gitea-kanban/app/secret
ok  gitea-kanban/app/store
ok  gitea-kanban/app/sync

$ cd frontend && pnpm build         ✓
$ pnpm typecheck                    0 错误（改过的文件）

$ wails build -skipbindings
Built '.../gitea-kanban.app/Contents/MacOS/gitea-kanban'
```

OnStartup 日志（实际跑）：

```text
time=... msg="gitea-kanban starting" dataDir=/tmp/gitea-kanban-v24 version=2.0.0
time=... msg="localStore initialized" path=/tmp/gitea-kanban-v24/workspace/state.json
time=... msg="platform adapters initialized"
time=... msg="secret store: dev fallback (file)" dir=/tmp/gitea-kanban-v24/dev-tokens
time=... msg=GetUserPrefs keys=[ui.navrail.collapsed] found=0
```

最后一条 `GetUserPrefs` 证明 prefs IPC 链路在 OnStartup 阶段就被前端调用（之前 stub 永远 null，现在能正常调通）。

---

## 6. 后续 v2.5 候选（不决）

- 字符流 vs 结构化 graph 协议统一（`App.GetGitGraph` 返 `GraphResultDTO`，但 `TimelineNewView` 还在解析 `GraphLinesDto`）
- 真正的 HTTP error 透传（`LogGraph` 错误丢失 HTTP status）
- 浅 clone `Depth` 选项（v2.6+ 看业务）
- 字符流 graph 与 go-git DAG 的混合 fallback
- 多账号时 `findProjectAndAccount` 性能（`O(N*M)` 现状，N 项目 M 账号可接受）
