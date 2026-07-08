# ADR-0007 · workspace 按账号分层（v2.5）

> 决策日期：2026-06-22
> 决策者：用户拍板

## 背景

v2.4 之前的 workspace 布局是单层：

```
${dataDir}/workspace/repos/${owner}__${repo}/
```

当用户同时连接多个账号（如 Gitea 实例 A 上的 alice + GitHub 上的 july-x，
或同一 Gitea 实例上的 alice / bob 两个账号）时，**同名 username 在不同平台 / 账号下会撞目录名**。
具体场景：

1. **多平台同名**：alice 在 gitea.example.com 和 github.com 都连账号 → 两边 clone `octocat/hello-world` 都会落到 `${ws}/repos/octocat__hello-world/`，互相覆盖
2. **多账号同名 owner**：alice 和 bob 各连 gitea.example.com，alice clone `acme/internal-tool`，bob 也有权限看 `acme/internal-tool`（同一 Gitea 实例同一 owner）→ 同样冲突
3. **清理困难**：删一个账号想清掉它的所有仓库 → 没有"按账号"的概念，必须按 project 一一删

## 决策

新布局按账号 username 再做一层：

```
${dataDir}/workspace/repos/
├── alice/                    ← 账号 1 的 username
│   ├── org1__repo1/
│   └── myorg__repo2/
├── bob/                      ← 账号 2 的 username
│   └── shared__alice-repo/
└── _pre_v25_workspace/       ← 旧布局备份（迁移完成后保留，不读）
```

### 设计要点

1. **账号目录名 = `account.Username`**（login），不是 account.ID（UUID）
   - 前端 UI 展示的就是 username，从路径能直接看懂"这个仓库属于哪个账号"
   - 重命名账号时同步搬家（一次性 mv）也是合理代价
   - `_unknown` 是 fallback（resolver 找不到归属的仓库）

2. **保留 `RepoLocalPath(workspacePath, owner, repo)`**（旧版路径函数）
   - 仅供测试 / 迁移期 fallback 使用
   - 新代码一律走 `RepoLocalPathForAccount(workspacePath, accountUsername, owner, repo)`

3. **`IsRepoClonedArgs` 新增 `username` 字段**
   - 旧版 `IsRepoCloned({ owner, repo })` 仍兼容（fallback 到旧路径）
   - 新版 `IsRepoCloned({ username, owner, repo })` 按账号分层查
   - 前端 `refreshClonedStatus` 必须传 `accounts[0].username`

4. **启动期一次性自动迁移**
   - 用户拍板：同步执行（一次性，不需要后台 goroutine）
   - 旧布局存在 → 触发迁移，否则 no-op
   - 迁移策略：用 `${ws}/_v25_migration_staging/` 临时目录 + `os.Rename` 原子切换
     - 全部成功 → mv 旧 repos 为 `_pre_v25_workspace` 备份 + mv staging 为新 repos
     - 任一失败 → 清 staging + mv 旧 repos 为 `_pre_v25_workspace` 备份 + 重建空 repos
   - 备份目录冲突时自动加 `.1` / `.2` 后缀

5. **失败行为**：旧布局整目录 mv 到 `_pre_v25_workspace` 保留（user 决定：失败用 `_legacy` 而不是 `_pre`）
   - 用户可手动从备份恢复任何丢迁的仓库

## 反查逻辑（resolveTokenByLocalPath）

新增对三层路径的识别：

```go
// v2.5 三层：repos/<username>/<owner>__<repo>
parts := strings.Split(filepath.ToSlash(rel), "/")
if len(parts) == 3 {
    accountUsername = parts[1]  // 用于过滤同名 project 的归属
    repoDirName = parts[2]
}

// v2.4 旧两层：repos/<owner>__<repo>（fallback 兼容）
if len(parts) == 2 {
    repoDirName = parts[1]
    accountUsername = ""  // 不限定账号
}
```

多账号同 owner/repo 场景：path 里的 username 与 project 关联账号不匹配时**跳过**，避免拿错 token。

## 实施文件

| 文件 | 变更 |
|---|---|
| `app/git/clone.go` | 新增 `AccountDirName`、`RepoLocalPathForAccount`；`CloneOptions.AccountUsername` 字段 |
| `app/git/workspace.go` | 新增 `AccountResolver` 类型、`LegacyMigrationResult` 结构、`MigrateLegacyWorkspaceLayout` 方法；`ListRepos` 改为扫两层目录 |
| `app/platform/adapter.go` + `gitea/adapter.go` + `github/adapter.go` | `CloneRepo` 接口新增 `accountUsername` 参数 |
| `app.go` | `App.CloneRepo` / `GetGitGraph` / `GetRepoById` / `PullRepoByProjectId` / `IsRepoCloned` / `resolveTokenByLocalPath` / `ListWorkspaceRepos` 全部走新布局；新增 `runLegacyWorkspaceMigration` 在 OnStartup 触发 |
| `app/git/workspace_test.go` | 新增 9 个迁移测试（happy / multi-account / unknown / non-repo / target-exists / backup-unique / empty / no-repos / no-legacy） |
| `app/git/clone_test.go` | `TestCloneRepo_FilePath` 增加新布局断言 + `AccountDirName` 测试 |
| `app_clone_test.go` | `TestApp_IsRepoCloned` 适配新布局；新增 `TestApp_ResolveTokenByLocalPath_V25Layout` 和 `_V25AccountMismatch` |
| `app_gitgraph_test.go` | `TestApp_GetRepoById` 期望新路径 |
| `frontend/src/lib/ipc-client.ts` | `commitsGitgraphIsRepoCloned` 新增 `username?` 字段 |
| `frontend/src/stores/repo.ts` | `refreshClonedStatus` 传当前账号 username |
| `frontend/src/lib/wails-api-shim.ts` | 兼容层同步 |

## 测试覆盖

- 9 个迁移路径测试覆盖：happy / multi-account / unknown-account / non-repo-skipped / target-exists-failure / backup-name-unique / empty-repos / no-repos-dir / no-legacy
- 端到端验证：3 个旧布局仓库（不同 owner/repo）+ 2 个账号 → 正确归到 alice / bob 子目录
- 所有原有测试通过 `go test -race ./...`

## 回归风险

| 风险 | 缓解 |
|---|---|
| 启动期迁移阻塞 | 旧布局仓库数通常 < 50，单次 mv < 10ms，可接受 |
| staging 崩溃残留 | 不主动清理；用户可手动 rm `${ws}/_v25_migration_staging/` |
| 备份目录占空间 | 用户可手动删 `_pre_v25_workspace/`；不在 UI 暴露删除入口避免误操作 |
| 用户从 v2.4 之前直接升级 | 走迁移路径（已验证） |
| 用户从 v2.5 之后降级到 v2.4 | v2.4 的 resolveTokenByLocalPath 已兼容三层路径，但仍需走 `RepoLocalPathForAccount` 算出路径——v2.4 的 `RepoLocalPath` 不识别，**降级场景暂不支持**（属预期：用户升级到 v2.5 后不应降级） |

## 不决事项（后续 v2.5.x 单独任务）

- UI 显示"工作区迁移失败"提示（仅当 `BackupKept=true` 时）
- `_pre_v25_workspace` 的清理入口（设置页"释放旧版工作区备份"按钮）
- 多账号同 owner/repo 场景下前端 UI 区分展示（现在两者都会被列在 `ListWorkspaceRepos` 里，需要标账号 username）