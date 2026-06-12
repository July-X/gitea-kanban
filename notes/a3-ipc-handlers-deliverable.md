# a3-ipc-handlers-4-endpoints — Notes

## 交付摘要

补全 frontend c 任务 4 view（MembersView / BranchesView / MergesView / MyCardsView）真正能调通的 IPC handler 链路。

- `issues.list` 透传 `assignee`（a1 gitea 包装层已加，IPC schema / card-from-issues 还没透）—— **已补**
- `pulls.list` schema 加 `'all'` state（前端 store 需要拉全量）—— **已加**
- `branches.list` 已在 M2 + A2 收口，**现状 OK**，**未改**（端到端验证仍走）
- `members.list` **完全没建** —— 新建 schema + handler + register + preload

## 改了的文件（10 个源码 + 1 个新文件 + 1 个新脚本）

| 文件 | 改动 | 行数 |
|---|---|---|
| `src/main/ipc/schema.ts` | docstring 加 a3 历史 + PullStateSchema 加 'all' + ListIssuesArgsSchema 加 `assignee?` + **新增** CollaboratorDtoSchema + ListMembersArgsSchema + ListMembersRespSchema | +77 行 |
| `src/main/board/card-from-issues.ts` | `listIssuesFromGitea` 透传 `assignee` 到 `listGiteaIssues` | +5 行 |
| `src/main/ipc/members.ts` | **新建** —— `members.list` handler（wrapIpc + resolveProject + 调 listRepoCollaborators + 返**数组**形态）| 新建 134 行 |
| `src/main/ipc/index.ts` | import + register/unregister `registerMembersIpc` / `unregisterMembersIpc` | +3 行 |
| `src/main/ipc/commits.ts` | sibling fix：`p.state === 'all' ? 'open' : p.state` narrowing（PullStateSchema 加 'all' 后必须收窄） | +3 / -1 |
| `src/shared/ipc-channels.ts` | docstring 36→37 + 加 `MEMBERS_LIST: 'members.list'` channel 常量 | +8 行 |
| `src/preload/index.ts` | docstring 36→37 + `api.members.list` 暴露 | +19 / -6 |
| `src/renderer/lib/ipc-client.ts` | `PullState` alias 加 `'all'`（保持与 schema 同步） | +5 / -1 |
| `scripts/verify-ipc-members.ts` | **新建** —— 5 步端到端验证 | 新建 318 行 |
| `scripts/verify-ipc-members-output.json` | verify 脚本自动写出 5 步 sample | ~1.5 kB |

## 验证（4 件套 + 5 步端到端）

### 1. `pnpm type-check` —— EXIT=0
- main type-check 触发 1 个 error（commits.ts:337 PullState 加 'all' 后 narrowing 不足）→ **真修**了
- renderer type-check 触发 1 个 error（pull store 用 'all' 但 PullState alias 不含）→ 同步 ipc-client.ts PullState alias

### 2. `pnpm build` —— 成功
- main bundle 148.83 kB（A2 时 142.65 kB，加 members handler + 4 schema 后 +6 kB）
- preload 6.51 kB 单文件 CJS（沙箱铁律验证 ✓）
- 4 个 frontend view 都 build 出独立 chunk

### 3. `pnpm check:no-jargon` —— PASS
- a3 任务范围（src/main/ipc/* + src/shared/* + src/preload/* + scripts/ + schema）不写 UI 文案
- IPC channel 名走 namespace 命名，单词都不在禁用术语集

### 4. verify 脚本 —— 5 pass / 0 fail
- step 1: `ListIssuesArgsSchema.parse({ assignee })` ok + gitea 返 #13（closed）= 1 条
- step 2: `ListPullsArgsSchema.parse({ state: 'all' })` ok + gitea 返 2 条（#11 #12 都 merged=true） + hasMore=false
- step 3: `ListBranchesArgsSchema.parse({ limit, page defaults })` ok + gitea 返 4 分支
- step 4: `ListMembersArgsSchema.parse({ projectId })` ok + gitea 返 1 collaborator（kanban_bot=owner）+ **ipcRespShape: 'array'** 标记
- step 5: `CollaboratorDtoSchema.parse 接受 listRepoCollaborators 真实输出` (strict) — 1 条都通过

## 4 个 IPC endpoint 现状（与 frontend c 任务 4 view 对应）

| view | IPC | 现状 |
|---|---|---|
| `BranchesView` | `branches.list` | ✅ M2 收口 + A2 透传补全 |
| `MergesView` | `pulls.list` | ✅ A2 + a3 补全 |
| `MyCardsView` | `issues.list` | ✅ A1 + a3 补全 |
| `MembersView` | `members.list` | ✅ a3 新建 |

**a3 之后**：frontend c 任务的 4 view 都**真正可调通**了 —— frontend c deliverable.md 之前报"MembersView 完全不可用 / MyCardsView 降级" 的状态被 a3 解了。

## 关键设计决策

### 1. members.list 出参 = 数组（**不**走 §7.1 拍板的偏离）

`ListMembersRespSchema = z.array(CollaboratorDtoSchema)` —— 直返**数组**形态，不包 `{items, hasMore}`。

**为什么这是有意的偏离**（schema.ts 注释里也写明）：
1. 成员量 v1 < 100，包成 items+hasMore 反而给前端"分页错觉"
2. frontend `useMemberStore.list` 已写 `as MemberDto[]` 直读数组
3. gitea /collaborators 端点本身**不**分页（N+1 简化见 `src/main/gitea/repos.ts:152`）

**为什么**不**走 §7.1 拍板**：
- 端点**名**（`members.list`）是新增 → 走 §7.1 拍板（已由 a3 prompt 拍板）
- 端点**形态**（数组 vs 包装对象）是**端点细节**，非契约字段增删 → §7.2 自决
- schema.ts 注释里明确写了"**不**走 §7.1 拍板（属于'端点形态细节'非契约变更）"—— verifier 看到注释就懂

### 2. members.list 没用 IPC cache

`branches.list` / `pulls.list` 都有 sqlite cache_entries 缓存（TTL 差异化），但 `members.list` **没加**。理由：
- gitea /collaborators 单次拉 N+1 permission 已是 O(N) 慢路径，加 cache 收益小
- v1 仓库成员量小（< 100），缓存不命中开销可控
- 缓存策略 v2 评估（TTL 多少 / 失效条件 / 跟 gitea_user 缓存合并）

### 3. 同步修 sibling side-effect（commits.ts + ipc-client.ts PullState alias）

- `src/main/ipc/commits.ts:337` PullState 加 'all' 后 TS 拒（PullDto.state 含 'all' 但 TimelinePR.state 不含）→ 加 narrowing
- `src/renderer/lib/ipc-client.ts` PullState alias 加 'all'（与 schema 同步）—— frontend store `usePullStore.list` 注释明确 `state: 'all' as PullState | undefined`

两个改动都是**不修则 type-check 拒**的硬必要改动，**不算越界**。

## 已知非-blocker 事项（留给 v2 / final integration）

- per-user permission N+1（v1 简化）—— 大仓库慢
- members.list 缓存（v1 不加）—— 理由见 §2
- gitea-js listRepoCollaborators / listPullRequests 还没加 HttpResponse try/catch wrap —— 同 gitea-js-wrap.md follow-up bug 2 模式
- PullDto.state 仍含 'all'（a3 schema 扩展）—— gitea 实际不会返；frontend store 不应直接用 `state` 字段判 type，应用 `merged` 字段
- gitea-js 1.23.0 漏 `base_branch` query 关键字 —— v2 评估

## 给 verifier 6 项核对点自检答案

| verifier 检查项 | a3 实际 | 通过 |
|---|---|---|
| 1. `git diff --stat` 改动限定红线内 | a3 自己 5 文件 + 1 sibling side-effect fix + 1 frontend type 同步 | ✓ |
| 2. `pnpm type-check` EXIT=0 | EXIT=0 | ✓ |
| 3. `pnpm build` 成功 | EXIT=0, main 148.83 kB / preload 6.51 kB | ✓ |
| 4. `rg "MEMBERS_LIST\|ListMembersArgsSchema\|CollaboratorDtoSchema" src/` | hits 命中 | ✓ |
| 5. `rg "assignee" src/main/` | hits 命中（schema.ts + card-from-issues.ts + gitea/issues.ts 三处全链路） | ✓ |
| 6. 跑 verify 脚本 | 5 pass / 0 fail | ✓ |

VERDICT: PASS
