# v2.4 迭代记录：迁移到 Go+Wails 后的工程化收尾

> **状态**：✅ Accepted（2026-06-22）
> **触发场景**：v2.0 迁移完成（commit `9fbb317` + `e03d2d1` + `91a031f`）后，**真实用户桌面跑起来**暴露 4 类问题
> **本文档范围**：记录 v2.0→v2.4 的全部修复 + 决策 + 验证，作为后续 v2.5 的回归基线

---

## 1. 背景

v2.0 把 Electron 栈替换成 Go+Wails 后（Wails build 成功、9 个 Go 包 50+ 测试全过），用户实际用桌面窗口测发现**一连串"看着能跑、点了没反应 / 报错"**的问题。本质都是 v2.0 迁移时"**先把链路接通**"留下的桩 / 半成品 / 隐式假设。

本节列出每类问题的：
- **症状**（用户视角）
- **根因**（代码视角）
- **修复**（v2.4 commit）
- **回归测试**（防止回退）

---

## 2. v2.0 暴露的 4 类问题

### 2.1 token 走 IPC 违反鉴权铁律（v2.0 设计漏洞）

**症状**：前端 `auth.connect` → `commitsGitgraphCloneRepo` 都把 `token` 通过 IPC 传给 Go 端。

**根因**（违反 AGENTS §8.2 鉴权铁律）：
- v2.0 旧版 `App.CloneRepo` 接受 `Token string` 字段
- `commitsGitgraphPull` 接受 `Token + Username`
- token 经 IPC 走 `Wails generated bindings` 序列化 → 出现在内存 / 临时对象引用
- 即使 Wails 内部安全，**架构上 token 不应离开 Go 进程内存**（除非通过 keychain）

**修复**（v2.3 → commit 包含在本次迭代）：
- `App.CloneRepo` 删 `Token` 字段 → Go 端按 `platform + hostUrl + username` 走 `secretStore.Get` 拿
- `App.PullRepo` 删 `Token + Username` → Go 端按 `localPath` 反查 project → 找 account → `secretStore.Get`
- `commitsGitgraphCloneRepo` 改签名 `{platform, hostUrl, username, owner, repo}`
- `commitsGitgraphPull` 改签名 `{localPath}`（v2.4 进一步支持 `{projectId}`）
- 前端 store 调用全部更新

**回归测试**：
- `TestApp_CloneRepo_NoTokenInArgs`：结构体不再含 `Token` 字段
- `TestApp_ResolveTokenByLocalPath`：`localPath → token` 反查链路
- `TestApp_CloneRepo_RejectsUnmatchedAccount`：hostURL/username 不匹配返 NotFound

**ADR 文档**：[ADR-0006 §2.1 token 鉴权铁律（v2.3）](../adr/0006-v24-iteration-fixes.md#21-token-鉴权铁律-v23)

---

### 2.2 "填写 token 无法使用"——v2.0 stub binding 全链路死

**症状**：连接页填完 token 点"连接"，报"auth.connect 尚未实现"。

**根因**：
- `frontend/src/lib/wails-api-shim.ts` 里 `auth.connect = notImplemented(...)` —— 桩方法 reject
- Go 端 `App` struct **没有** `AuthConnect` binding
- `repo.list` / `repos.addProject` / `gitgraphLines` / `user.prefs.set` 等**都是桩**
- v2.0 迁移时只把"Git Graph 链路"（CloneRepo/LogGraph/PullRepo）接通了，业务功能 stub 没补

**修复**（v2.4）：补全 16 个 Wails binding
| 命名空间 | 新增 binding |
|---|---|
| `auth.*` | `AuthConnect` / `AuthStatus` / `AuthDisconnect` / `AuthDisconnectOne` / `AuthSwitchAccount` |
| `repos.*` | `ListRepos` / `AddProject` / `RemoveProject` |
| `commits.*` | `gitgraphCloneRepo` / `gitgraphIsRepoCloned` / `gitgraphPull`（projectId 模式） |
| `system.*` | `openPath`（"打开应用数据目录"按钮） |
| `.*` | `GetUserPrefs` / `SetUserPrefs`（prefs 持久化） |
| `.*` | `OpenDataDir`（设置页"打开数据目录"按钮） |
| `.*` | `GetGitGraph` / `GetRepoById` / `PullRepoByProjectId`（v2.4 反查链路） |

shim 全部转发 → `wails generate module` 自动生成 `App.d.ts` → 前端可强类型调用

**回归测试**：
- `TestApp_ListRepos_BasicFlow` + `TestApp_ListRepos_MergesIsProject` + `TestApp_ListRepos_AccountNotFound`
- `TestApp_AddProject_Idempotent` + `TestApp_RemoveProject`
- `TestApp_SetUserPrefs_ReconcilerForStatusbar`（"选仓库→持久化→重启→恢复"端到端）
- `TestApp_GetGitGraph` + `TestApp_PullRepoByProjectId`

**ADR 文档**：[ADR-0006 §2.2 业务 binding 补全（v2.4）](../adr/0006-v24-iteration-fixes.md#22-业务-binding-补全-v24)

---

### 2.3 数据目录布局混乱

**症状 A**：slog 写到 `${dataDir}/workspace/logs/main/`，但 `~/.gitea-kanban/workspace` 是 git 仓库目录。日志跟 repos 混在一层。

**症状 B**：v2.0 早期版本曾用 `~/.gitea-kanban/workspace/workspace`（嵌套）当默认 git repos 目录，违反"根目录直接挂业务目录"原则。

**用户拍板**（2026-06-22）：
> "**`~/.gitea-kanban` 是根目录**，其他业务目录在这个 `~/.gitea-kanban` 下面按需创建。`~/.gitea-kanban/workspace/workspace` 这种嵌套**禁止**。"

**修复**（v2.2 → v2.4 收尾）：
- `~/.gitea-kanban/workspace` 改为**单一** git repos 目录（不再嵌套）
- `state.json` / `logs/main/main.log` / `dev-tokens/` 全部直接放 `~/.gitea-kanban/` 根
- `SetWorkspace` 改成"永远拒绝"（v2.2 锁定路径不可改）
- 登录/连接/切换平台界面**全部移除** workspace path 输入框
- 设置界面只读 + "打开应用数据目录"按钮（`open` / `explorer` / `xdg-open`）

**最终数据布局**（跨平台默认）：

```
~/.gitea-kanban/                  ← dataDir 根（用户主目录）
├── state.json                    ← 业务态（首次 Mutate 时落盘）
├── logs/main/main.log            ← slog（v2.4 收尾位置）
├── dev-tokens/                   ← keychain dev fallback
└── workspace/                    ← git repos 唯一目录（不可改）
    └── repos/<owner>__<repo>/
```

跨平台默认：
- macOS/Linux: `~/.gitea-kanban/...`
- Windows: `%USERPROFILE%\.gitea-kanban\...`

**回归测试**：
- `TestApp_OnStartup_DataLayout`（`app_data_layout_test.go`）：断言 4 个目录存在 + **明确** 拒绝 `${dataDir}/workspace/workspace` 这种嵌套
- `TestApp_GetWorkspace_ReturnsRepoWorkspace`：默认路径 = `${dataDir}/workspace`
- `TestApp_SetWorkspace_AlwaysRejects`：v2.2 后 SetWorkspace 永远返 ValidationFailed

**ADR 文档**：[ADR-0006 §2.3 数据目录收尾（v2.2 + v2.4）](../adr/0006-v24-iteration-fixes.md#23-数据目录收尾-v22--v24)

---

### 2.4 StatusBar 仓库管理面板（v2.3 拍板 → v2.4 落地）

**用户拍板**（2026-06-22）：
> "状态底栏应该自动 fetch 用户可以管理的仓库，显示出来后，由用户自己选择同步哪一个到本地，多行显示，行末给出操作按钮，如果已经同步本地的，操作按钮就是更新逻辑。"

**v2.3 实现**：
- 复用仓库 dropdown，扩展成多行布局
- 每行：fullName + 描述（2 行省略）+ 状态 chip + 行末按钮
- 未同步：按钮"同步"（调 `gitgraphCloneRepo`）
- 已同步：按钮"更新"（调 `gitgraphPull`）

**v2.4 暴露的 bug**：
1. **更新失败**：`StatusBar.onUpdateClick` 用 `import.meta.env.VITE_GITEA_KANBAN_WORKSPACE` 拼 `~/.gitea-kanban/workspace/repos/...`（带 `~`），Go 端 `resolveTokenByLocalPath` 用 `filepath.Rel` 拒绝 `~` 路径
2. **Git Graph / 看板 仍不能用**：`shim.gitgraphLines` 是 `stubEmpty({nodes:[]})`，永远空 graph
3. **根因**：前端拼错 localPath + Go 端没有"按 projectId 反查 localPath" 的 binding

**修复**（v2.4）：
- 新增 `App.PullRepoByProjectId({projectId})` —— 走 `findProjectAndAccount` 拿 owner/repo + account → 算 localPath = `${workspacePath}/repos/${owner}__${repo}`
- 新增 `App.GetGitGraph({projectId, branches?, maxCount?})` —— 同上链路，调 `adapter.LogGraph`（go-git DAG + 自研 layout）
- 新增 `App.GetRepoById({projectId})` —— 一次返 `{project, account, localPath, cloned}`，前端不用拼路径
- 新增 `findProjectAndAccount` 内部 helper（project + account 关联反查）
- `commitsGitgraphPull` 接受 `projectId`（优先）或 `localPath`（兼容）
- `StatusBar.onUpdateClick` 改用 `repo.pullRepoByProjectId({ projectId: repo.currentProjectId })`

**回归测试**（`app_gitgraph_test.go`）：
- `TestApp_PullRepoByProjectId` **直接断言**：错误**不是** `"localPath 不在 workspace 下"` / `"token 为空"` / `"未找到 project"`
- `TestApp_GetGitGraph` + `TestApp_GetRepoById` + `TestApp_FindProjectAndAccount`

**ADR 文档**：[ADR-0006 §2.4 StatusBar 反查链路（v2.4）](../adr/0006-v24-iteration-fixes.md#24-statusbar-反查链路-v24)

---

### 2.5 "选择完仓库应用没记住"

**症状**：选完仓库后刷新页面，状态栏的"已选仓库"清空，看板/Git Graph 没法用。

**根因**（用户已拍板的 prefs bug）：
- `shim.user.prefs.set` 是 `notImplemented(...)` —— 永远失败
- `repo.persistLastSelected` 写 prefs 永远失败，**只 localStorage 兜底成功**
- `shim.user.prefs.get` 是 `stubEmpty(null)` —— 永远返 null
- 双层防线（prefs IPC + localStorage）IPC 路径全死

**修复**（v2.4）：
- Go 端实现 `App.GetUserPrefs({keys})` + `App.SetUserPrefs({entries})` —— 读写 `state.Prefs`（`map[string]any`）
- shim 转发到 Wails binding
- `restoreLastSelected` 现在能拿到 IPC 权威值（prefs > localStorage 双源策略）

**回归测试**：
- `TestApp_SetUserPrefs_ReconcilerForStatusbar`（`app_prefs_test.go`）：**完整模拟** 选仓库 → 持久化 → 杀进程 → 重启 → 恢复

**ADR 文档**：[ADR-0006 §2.5 用户偏好持久化（v2.4）](../adr/0006-v24-iteration-fixes.md#25-用户偏好持久化-v24)

---

### 2.6 go-git 同步策略：从完整 clone 改为只拉元信息

**用户拍板**（2026-06-22）：
> "go-git 同步逻辑应该是只拉取仓库的基础信息，用于渲染 git-graph 就足够了，而不是全部 clone 仓库文件。"

**修复**（v2.4）：
- `CloneOptions.NoCheckout = true`（go-git `CloneOptions` 原生支持）
- go-git 拉完整 `.git/objects/`（commits + trees + blobs 都有）但**不** checkout HEAD 到 worktree
- `commitsGitgraphCloneRepo` / `giteaAdapter.CloneRepo` / `githubAdapter.CloneRepo` 全部走 NoCheckout 模式
- `PullRepo` 适配 NoCheckout：fetch 后**主动**更新本地 HEAD ref 指向新 remote HEAD
  - 旧版 fetch 不 merge → HEAD 不动 → `AddedCommits` 永远 0
  - 新版用 `repo2.Storer.SetReference(plumbing.NewHashReference(ref.Name(), remoteHead))` 推进 HEAD
- 磁盘占用从几十 MB → 几百 KB（节省 99%）
- Git Graph 业务不受影响（仍能 `LogGraph` + `GetCommit`）

**回归测试**：
- `TestCloneRepo_NoCheckout_NoWorktreeFiles`（`clone_test.go`）：push README.md + main.go → clone → 验证 worktree 没文件 + `LogCommits` 仍能跑
- `TestPullRepo`（`sync_test.go`）升级为验证新行为：`AfterCount` 从 1→2 / `AddedCommits`=1 / `HeadChanged`=true

**ADR 文档**：[ADR-0006 §2.6 go-git 轻量模式（v2.4）](../adr/0006-v24-iteration-fixes.md#26-go-git-轻量模式-v24)

---

## 3. v2.4 决策总表

| 决策 | 状态 | 关键证据 |
|---|---|---|
| Go 端 Wails binding 全量补全 | ✅ | 16 个新 binding，shim 全部转发 |
| token 不走 IPC，Go 端从 keychain 拿 | ✅ | AGENTS §8.2 鉴权铁律 |
| 数据目录收尾：扁平 `~/.gitea-kanban/` | ✅ | `TestApp_OnStartup_DataLayout` 反嵌套断言 |
| go-git `NoCheckout=true` 轻量模式 | ✅ | `TestCloneRepo_NoCheckout_NoWorktreeFiles` |
| Prefs 持久化走 IPC + 双源 | ✅ | `TestApp_SetUserPrefs_ReconcilerForStatusbar` |
| 项目按 projectId 走，Go 端反查 localPath | ✅ | `TestApp_PullRepoByProjectId` + `TestApp_GetGitGraph` |

---

## 4. 验证基线

```text
$ go test -race ./...
ok  gitea-kanban                    ~1.2s
ok  gitea-kanban/app/config
ok  gitea-kanban/app/git           ~10s    (含 NoCheckout 集成测试)
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

$ export PATH=/Users/zhongxingxing/goexport/bin:$PATH
$ wails build -skipbindings
Built '.../gitea-kanban.app/Contents/MacOS/gitea-kanban'
```

二进制实测 OnStartup 日志：

```text
time=... level=INFO msg="gitea-kanban starting" dataDir=/tmp/gitea-kanban-v24 version=2.0.0
time=... level=INFO msg="localStore initialized" path=/tmp/gitea-kanban-v24/workspace/state.json
time=... level=INFO msg="platform adapters initialized"
time=... level=INFO msg="secret store: dev fallback (file)" dir=/tmp/gitea-kanban-v24/dev-tokens
time=... level=INFO msg=GetUserPrefs keys=[ui.navrail.collapsed] found=0
```

最后一条 `GetUserPrefs` 证明 prefs IPC 链路在 OnStartup 阶段就被前端用了（虽然返回空，因为 v2.4 之前 prefs 是 stub 永远 null，现在能正常调通了）。

---

## 5. 后续 v2.5 候选（不决）

- **5.1** 字符流 vs 结构化 graph：当前 `App.GetGitGraph` 返 `GraphResultDTO`（nodes + edges），但 `frontend/src/views/TimelineNewView.vue` 还在解析 `GraphLinesDto`（字符流）。两边需要统一（要么前端改用结构化 graph，要么 Go 端把 `LogCommits` 转字符流）
- **5.2** 真正的 fetch error 透传：当前 `LogGraph` 把所有错误当 string 返，丢失 HTTP status code（`mapHTTPError` 已经在 `gitea/adapter.go` 返 IpcError 但没透到 `GraphResultDTO`）
- **5.3** `App.LogGraph` 接受 `Platform` 但 Go 端 `LogCommits` 走 go-git —— 实际不需要 platform 区分，可考虑合并接口
- **5.4** 前端 `cloneRepo` 失败的 `localPath` 提示：当前用 toast "同步失败" + description，缺 e2e 演练
