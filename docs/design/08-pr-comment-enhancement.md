# PR 评论模块功能对齐设计（v0.5.0）

> **负责人**：工程 agent
> **决策日期**：规划中（待用户拍板）
> **背景**：v0.4.0 完成了 PR 基础能力（列表 / 详情 / 合并 / 关闭 / 评论 CURD 一半）。当前评论模块只支持「列评论」+「发评论」，缺少编辑、删除、表情反应 (reaction)、PR review 能力。本设计把 PR 评论模块对齐到 Gitea 1.21+ 与 GitHub REST API v3 的完整能力。

---

## 1. 现状盘点（截至 v0.4.0 / v0.5.0-m9）

### 1.1 已实现

| 能力 | Gitea | GitHub | 前端 UI |
|---|---|---|---|
| 列 PR 评论 (issue-style) | ✅ `GET /repos/{owner}/{repo}/issues/{index}/comments` | ✅ `/repos/{owner}/{repo}/issues/{number}/comments` | ✅ MergesView.vue 1209-1247 行 |
| 发 PR 评论 | ✅ `POST /repos/{owner}/{repo}/issues/{index}/comments` | ✅ 同上 | ✅ `@mention` + 引用 + Enter 提交 |
| 评论 markdown 渲染 | — | — | ✅ `renderMarkdown()` |
| 评论数角标 | ✅ `PullDTO.commentsCount` | ✅ 异步补全 | ✅ 行卡 + 对话标题 |

### 1.2 后端分层现状

```
PlatformAdapter interface (adapter.go)
  ├── ListPullComments   ✅
  └── CreatePullComment  ✅
  └── UpdatePullComment  ❌ 缺
  └── DeletePullComment  ❌ 缺
  └── ListPullCommentReactions    ❌ 缺
  └── AddPullCommentReaction      ❌ 缺
  └── RemovePullCommentReaction   ❌ 缺
  └── ListPullReviews             ❌ 缺
  └── CreatePullReview            ❌ 缺
  └── SubmitPullReview            ❌ 缺
  └── GetPullReview               ❌ 缺
```

`app.go` 里 current 只 binding 了 `ListPullComments` + `CreatePullComment`（2795-2870 行）。
`test/git/git-graph/` 里有 10 个 Go 测试，但 PR 评论一个单测都没有。
前端 `lib/ipc-client.ts` 只暴露 `pullsCommentList` + `pullsCommentCreate`。

### 1.3 DTO / Types 现状

**`CommentDTO` (Go)** — `app/platform/adapter.go:345`：
```go
type CommentDTO struct {
    ID        int64        `json:"id"`
    Body      string       `json:"body"`
    Author    *PullUserDTO `json:"author,omitempty"`
    CreatedAt string       `json:"createdAt"`
    UpdatedAt string       `json:"updatedAt,omitempty"`
}
```
缺字段：`userID`（判断作者 = 当前用户，显示编辑/删除按钮）、`reactionSummary`（展现条形 reaction）。

**`IssueCommentDto` (TS)** — `frontend/src/types/dto.ts:412`：
```typescript
interface IssueCommentDto {
  id: number;
  body: string;
  author: IssueAuthorDto;
  createdAt: string;
  updatedAt: string;
}
```
缺同上。

---

## 2. 目标能力（对齐 Gitea 1.21+ + GitHub REST v3）

### 2.1 评论完整生命周期（CURD）

| 能力 | Gitea API | GitHub API | 优先级 |
|---|---|---|---|
| 编辑评论 | `PATCH /repos/{owner}/{repo}/issues/comments/{id}` body: `{body}` | `PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}` | **P0 必做** |
| 删除评论 | `DELETE /repos/{owner}/{repo}/issues/comments/{id}` | `DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}` | **P0 必做** |

### 2.2 评论表情反应 (Reactions)

| 能力 | Gitea API | GitHub API | 优先级 |
|---|---|---|---|
| 列反应 | `GET /repos/{owner}/{repo}/issues/comments/{id}/reactions` | `GET /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions` | **P1 重要** |
| 增反应 | `POST .../reactions` body: `{content: "+1"}` | `POST .../reactions` body: `{content: "heart"}` | **P1 重要** |
| 删反应 | `DELETE .../reactions` body: `{content}` | `DELETE .../reactions/{reaction_id}` | **P1 重要** |

**Gitea 支持 emoji 表（`+1` / `-1` / `laugh` / `confused` / `heart` / `hooray` / `eyes` / `rocket`）**——与 GitHub 同名。前端可做一个「常用 6 件套」选择器（`+1` `heart` `laugh` `eyes` `rocket` `hooray`）。

### 2.3 PR Review（审阅）—— Gitea v1.21+

| 能力 | Gitea API | GitHub API | 优先级 |
|---|---|---|---|
| 列已提交的 Review | `GET /repos/{owner}/{repo}/pulls/{index}/reviews` | `GET /repos/{owner}/{repo}/pulls/{number}/reviews` | **P1 重要** |
| 发 Review（整体） | `POST .../pulls/{index}/reviews` body: `{body, commit_id, event: APPROVE|REQUEST_CHANGES|COMMENT}` | `POST .../pulls/{number}/reviews` body: `{body, comments, event}` | **P1 重要** |
| 提交 Review（从 pending → 正式） | Gitea 直接 POST 即提交 | `PUT .../reviews/{review_id}/events` | P2 阶段 |
| 列出 Review 行内评论 | `GET .../pulls/{index}/comments` | `GET .../pulls/{number}/comments` | P2 阶段 |

### 2.4 暂不做（out of scope）

| 能力 | 说明 |
|---|---|
| 行内 diff 附加评论（代码行级 inline comment） | 需要完整 diff 渲染前端 + 行号定位，留作 v0.5.5+ 专项 |
| 草稿 Review（PR v4 draft review） | GitHub draft review 需要多次 PUT 才能暂存，首版做简化版直接提交 |
| `Dismiss a review` | 高权限操作，低频，本期不做 |
| `List pull requests files` / diff | 前置大工程，留作单独专项 |

---

## 3. 整体架构

### 3.1 后端 DTO 扩展

**`app/platform/adapter.go`**：

```go
// CommentReactionDTO 单条 reaction（含用户摘要 + emoji 计数）
//
// Gitea 返回：user (object) + content (string) + created_at (string)
// GitHub 返回：user (object) + content (string) + id (int) + created_at (string)
type CommentReactionDTO struct {
    Content   string       `json:"content"`            // +1 / -1 / laugh / heart / ...
    Count     int          `json:"count,omitempty"`    // 汇总计数（前端直接展示 "12"）
    Users     []PullUserDTO `json:"users,omitempty"`   // 反应用户（前 N 个做 tooltip）
    Reacted   bool         `json:"reacted"`            // 当前登录用户是否已反应用于前端高亮
}

// PullReviewDTO PR 整体审阅
//
// 对应 Gitea /repos/{owner}/{repo}/pulls/{index}/reviews 列表项
// 对应 GitHub /repos/{owner}/{repo}/pulls/{number}/reviews 列表项
type PullReviewDTO struct {
    ID          int64         `json:"id"`
    State       string        `json:"state"`          // APPROVE / REQUEST_CHANGES / COMMENTED / PENDING
    Body        string        `json:"body,omitempty"`
    Author      *PullUserDTO  `json:"author,omitempty"`
    SubmittedAt string        `json:"submittedAt,omitempty"`
    CommitID    string        `json:"commitId,omitempty"`
}
```

**`CommentDTO` 扩字段**（向后兼容，原字段不动）：

```go
type CommentDTO struct {
    ID        int64         `json:"id"`
    Body      string        `json:"body"`
    Author    *PullUserDTO  `json:"author,omitempty"`
    CreatedAt string        `json:"createdAt"`
    UpdatedAt string        `json:"updatedAt,omitempty"`
    UserID    int64         `json:"userId,omitempty"`       // ✅ 新增：当前作者 user id（判等）
    Reactions []CommentReactionDTO `json:"reactions,omitempty"` // ✅ 新增：reaction 摘要（可选列）
}
```

### 3.2 PlatformAdapter interface 扩展

```go
// app/platform/adapter.go —— 追加到 interface

// UpdatePullComment 编辑 PR 评论
//   Gitea  PATCH /repos/{owner}/{repo}/issues/comments/{id}   body: {body}
//   GitHub  PATCH /repos/{owner}/{repo}/issues/comments/{comment_id} body: {body}
//   owner/repo/index 三元组用于权限二次校验（删除时前端不必传）
UpdatePullComment(ctx, hostURL, username, token, owner, repo string, commentID int64, body string) (*CommentDTO, error)

// DeletePullComment 删除 PR 评论
//   Gitea  DELETE /repos/{owner}/{repo}/issues/comments/{id}
//   GitHub  DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}
DeletePullComment(ctx, hostURL, username, token, owner, repo string, commentID int64) error

// ListPullCommentReactions 列评论表情（按计数 + 当前用户反應）
ListPullCommentReactions(ctx, hostURL, username, token, owner, repo string, commentID int64) ([]CommentReactionDTO, error)

// AddPullCommentReaction 加表情
AddPullCommentReaction(ctx, hostURL, username, token, owner, repo string, commentID int64, content string) error

// RemovePullCommentReaction 删表情
RemovePullCommentReaction(ctx, hostURL, username, token, owner, repo string, commentID int64, content string) error

// ListPullReviews 列 PR Review 列表
ListPullReviews(ctx, hostURL, username, token, owner, repo string, index int) ([]PullReviewDTO, error)

// CreatePullReview 发 PR Review
//   event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"
//   body: 可选 review 总结文本
//   comments: 行内评论数组（首版暂不实现传空切片即可）
CreatePullReview(ctx, hostURL, username, token, owner, repo string, index int, body string, event string) (*PullReviewDTO, error)
```

### 3.3 Gitea 实现

文件：`app/platform/gitea/adapter.go`

```go
// UpdatePullComment PATCH /repos/{owner}/{repo}/issues/comments/{id}
func (a *GiteaAdapter) UpdatePullComment(ctx context.Context, hostURL, username, token, owner, repo string, commentID int64, body string) (*platform.CommentDTO, error) {
    if strings.TrimSpace(body) == "" {
        return nil, ipc.NewValidationFailed("评论内容不能为空", "")
    }
    payload := map[string]any{"body": body}
    reader, _ := encodeJSONBody(payload)
    var raw giteaCommentRaw
    path := fmt.Sprintf("/repos/%s/%s/issues/comments/%d", owner, repo, commentID)
    if err := a.doRequest(ctx, hostURL, token, "PATCH", path, reader, &raw); err != nil {
        return nil, err
    }
    dto := giteaCommentToDTO(raw)
    return &dto, nil
}

// DeletePullComment DELETE /repos/{owner}/{repo}/issues/comments/{id}
func (a *GiteaAdapter) DeletePullComment(ctx context.Context, hostURL, username, token, owner, repo string, commentID int64) error {
    path := fmt.Sprintf("/repos/%s/%s/issues/comments/%d", owner, repo, commentID)
    return a.doRequest(ctx, hostURL, token, "DELETE", path, nil, nil)
}
```

Reactions / Review 同理 —— 都是对 Gitea REST 的简单包裹，不再逐行列出（见 §5 commit 落地）。

### 3.4 GitHub 实现

文件：`app/platform/github/adapter.go`

GitHub 的 reaction content 名与 Gitea 完全一致（`+1` / `-1` / `laugh` / `confused` / `heart` / `hooray` / `eyes` / `rocket`），但 delete 方式不同：
- Gitea：`DELETE .../reactions` + body `{content: "+1"}`
- GitHub：`DELETE .../reactions/{reaction_id}`（需先列拿到 reaction_id）

所以 `RemovePullCommentReaction` 内部逻辑分支：
```go
// Gitea: DELETE + body {content}
// GitHub: GET 列表取 reaction_id → DELETE .../reactions/{id}
```

Review (POST) 时：
```
GitHub: { "body": "LGTM", "event": "APPROVE" }
Gitea:  { "body": "LGTM", "comments": [], "commit_id": "<sha>", "event": "approve" }
```
注意 Gitea 的 event 名小写（`approve`），GitHub 大写（`APPROVE`）。实现时各自适配。

### 3.5 后端 App bindings 扩展

文件：`app.go`（追加，仿 `ListPullComments` / `CreatePullComment` 范式）

```go
// UpdatePullComment (args: projectID / commentID / body) → CommentDTO
// DeletePullComment  (args: projectID / commentID)      → error
// ListPullCommentReactions (args: projectID / commentID) → []CommentReactionDTO
// AddPullCommentReaction    (args: projectID / commentID / content) → error
// RemovePullCommentReaction (args: projectID / commentID / content) → error
// ListPullReviews  (args: projectID / index)     → []PullReviewDTO
// CreatePullReview (args: projectID / index / body / event) → PullReviewDTO
```

每个 binding 复用现成的 `resolvePullContext` helper（从 projectID → account + token + adapter）。

### 3.6 前端扩展

文件：
- `frontend/src/lib/ipc-client.ts` —— 追加 8 个 IPC 方法
- `frontend/src/views/MergesView.vue` —— 评论 UI 扩展 + Review 操作区
- `frontend/src/types/dto.ts` —— `IssueCommentDto` 扩字段 + 新 `CommentReactionDto` / `PullReviewDto`
- `frontend/src/lib/markdown.ts` 已支持 review body 渲染，无需改动

**UI 改动点**：

| 位置 | 原状 | 目标 |
|---|---|---|
| 评论气泡（`merge-item__comment`） | 静态只读 | 本人评论显示 `⋮` 菜单 → 编辑 / 删除；hover 显示 `+` emoji 按钮 |
| 列表底部 | 无 Review 操作 | 新增「审查」折叠区：批准 / 请求修改 / 评论 三按钮 + 近 5 条 Review 摘要列表 |
| 空评论区 | 空态文案 | 批准 / 请求修改按钮独立入口（PM 不写评论也能 express 意见） |

### 3.7 鉴权铁律（AGENTS §8.1）延续

- token 仍然只走 Go 端 keychain → adapter 内部 `Authorization: token` / `Bearer`
- 编辑/删除 Review/Comment 都用 `resolvePullContext`（前端不传 token/hostURL）
- 所有写操作走 slog.Info 审计日志（复用 `CreatePullComment` 范式）

---

## 4. 版本规划（v0.5.0 拆分）

基于 v0.5.0-m9 已 tag，新一轮拆为 m10-m13 四个子里程碑：

### v0.5.0-m10 · 评论完整 CURD（编辑 + 删除）

**范围**：
- `PlatformAdapter` interface 加 `UpdatePullComment` / `DeletePullComment`
- Gitea + GitHub 双实现
- `App.UpdatePullComment` / `App.DeletePullComment` bindings
- `ipc-client.ts` 加 `pullsCommentUpdate` / `pullsCommentDelete`
- MergesView.vue：评论气泡 `⋮` 菜单 + 编辑 inline textarea + 删除 AlertDialog
- 单元测试：`gitea/adapter_test.go` 加 httptest mock 验证 PATCH + DELETE

**验证**：
- `go test ./app/platform/...` PASS（≥ 8 个新测试）
- `pnpm build` PASS
- `wails dev` 实测：编辑一条评论 → PATCH 200 → 前端刷新；删除 → DELETE 204

**预估 commit 数**：5-8（铁律：每个阶段性交付打一次）

### v0.5.0-m11 · 评论表情反应 (Reactions)

**范围**：
- DTO 加 `CommentReactionDTO` + `CommentDTO.Reactions` / `UserID`
- interface 加 `List/Add/Remove PullCommentReaction`
- Gitea + GitHub 双实现
- App binding × 3
- `ipc-client.ts` × 3
- MergesView.vue：评论下方 emoji 选择器（常用 6 件套），每个 emoji 旁显示计数 + 高亮已反應
- 单元测试：httptest 验证 +1 / -1 / heart 三个 content 双端

**验证**：
- 新测试 ≥ 6
- 前端点击 emoji → reaction 立即数 +1 并高亮；点同 emoji 再减回去（toggle）

**预估 commit 数**：4-6

### v0.5.0-m12 · PR Review 列 + 发

**范围**：
- DTO 加 `PullReviewDTO`
- interface 加 `ListPullReviews` / `CreatePullReview`
- Gitea + GitHub 双实现（注意 event 名大小写差异）
- App binding × 2
- `ipc-client.ts` × 2
- MergesView.vue：「审查」折叠区（三按钮：批准绿 / 请求修改橙 / 评论灰）+ Review 历史列表
- PullDTO 展示旁显示 badge「已审阅 N」
- 行内 diff 评论本期不做（out of scope，见 §2.4）

**验证**：
- 新测试 ≥ 4
- 批准 → PR review 状态 APPROVE → review 列表行显示绿色 ✓
- 请求修改 → REQUEST_CHANGES → 橙色 ⚠ + 评论必填校验

**预估 commit 数**：4-6

### v0.5.0-m13 · 整体验收 + 性能测试 + 文档收尾

**范围**：
- `docs/releases/v0.5.0.md` 写完整 release note（仿 v0.4.0.md 格式）
- AGENTS.md 更新 milestone 章节，把 M10-M12 落进去
- `docs/adr/0008-pr-comment-v05-enhancement.md` 写 ADR 把设计最终化
- 前端全平台 E2E：Gitea + GitHub 双端 CURD + reactions + review smoke
- `go test ./...` 全绿 + `pnpm build` 通过
- tag `v0.5.0`

**验证**：
- 三端（GO / 前端 / 文档）全绿
- 打 `v0.5.0` annotated tag

**预估 commit 数**：3-5

---

## 5. 实现顺序与技术守恒

### 5.1 严格实现顺序（每步 TDD）

```
1. 改 interface (adapter.go) → 双 adapter → App binding → ipc-client → DTO 扩字段
2. Go 单测先写 (Red) → 实现 (Green) → commit
3. ipc-client.ts + 前端 UI (inline 编辑 + ⋮ 菜单) → pnpm build
4. wails dev 手动 smoke → commit
```

### 5.2 技术守恒

| 约定 | 实际 |
|---|---|
| 语言 | Go 单测中文描述 / commit 中文 / 注释中文 |
| 命名 | Go: 大驼峰 export + godoc; TS: camelCase; IPC: `pulls.comment.xxx` |
| 测试 | Go: `httptest` mock server (不要真打外网)；前端: Vitest component test 做评论 bubble 编辑态 |
| 安全 | token 不走前端；所有做操作走 `resolvePullContext` |
| 零术语 | UI 用「批准」「请求修改」不出现 "Approve" "Request changes" |
| gofmt | 每个 commit 前 `gofmt -w` |

### 5.3 风险与缓解

| 风险 | 缓解 |
|---|---|
| Gitea reaction 低版本不支持 | `doRequest` 404 → 返 ErrNotSupported，前端隐藏 emoji 区 |
| GitHub review event 名称差异 | GitHub 大写 (APPROVE)、Gitea 小写 (approve)，adapter 内部各转 |
| 编辑评论后 websocket 不存事件 | 编辑/删除后显式调 `fetchComments(p)` 强制刷新（同 m9 已用模式） |
| 安全：删错他人评论 | 后端 `resolvePullContext` + 评论 `UserID` 校验；前端菜单只显示本人评论 |
| 前端 inline textarea 多 PR 并发编辑 | `Map<idx, editing: boolean>` 防重入 |

---

## 6. 里程碑验收清单

### m10 验收

- [ ] `go test ./app/platform/...` 含 ≥ 8 单测；`go vet` 干净
- [ ] 前端：自己发的评论 hover 出现 `⋮` → 编辑态（textarea + 保存/取消）
- [ ] 前端：删除按钮 → ConfirmDialog（文案："确定要删除这条吗？删除后不可恢复"）
- [ ] `pnpm build` / `go build` 无 error

### m11 验收

- [ ] `CommentDTO.UserID` 字段返前端，用于按钮权限判断
- [ ] 前端：emoji 工具栏（6 件套）显示在每条评论下方，数量 badge 右对齐
- [ ] toggle 语义：已反應时再点 → 减反应
- [ ] `go test ./app/platform/gitea` + `github` 含 reaction 测试

### m12 验收

- [ ] 前端：PR 卡片展开 →「折叠操作头」+ 批准 / 请求修改 / 评论三按钮
- [ ] 前端：Review 历史列表显示 state badge（绿 / 橙 / 灰）
- [ ] Gitea `event=approve` vs GitHub `event=APPROVE` 被隐式适配
- [ ] `go test ./app/platform/...` 含 review 测试用例

### m13 验收

- [ ] `go test ./...` 全绿
- [ ] 前端 `pnpm build` 无 error
- [ ] `docs/releases/v0.5.0.md` 完整 chapter
- [ ] `docs/adr/0008-pr-comment-v05-enhancement.md` 写 commit
- [ ] AGENTS.md 更新（v0.5.0 摘要 + M10-M12 细项）
- [ ] `git tag -a v0.5.0 -m "v0.5.0 release: PR comment enhancement + reactions + reviews"`

---

## 7. 工时预估（粗）

| 子项 | Go 单测 + 实现 | 前端 | 联调 + 文档 | 合计 |
|---|---|---|---|---|
| m10 CURD | 4h | 6h | 2h | 12h |
| m11 Reactions | 3h | 5h | 2h | 10h |
| m12 Reviews | 3h | 6h | 2h | 11h |
| m13 验收 | 1h | 2h | 4h | 7h |
| **总计** | | | | **~40h** |

> 以上为单次串行估。多 agent 并行（Go + 双 platform + 前端 + 文档）可压缩到 2-3x。

---

## 决策开口（待用户拍板）

本设计已准备好进入实施。请确认：

1. **Scope**：40h / 4 子里程碑 OK？还是先只做 m10+m11（约 22h，涵盖编辑/删除/reactions）？
2. **并行深度**：m10/m11 同时双线开工，还是严格串行 TDD？
3. **先跑哪个**：m10（CURD）还是从 m11（reactions）切入，PR 评论利用率最高？
4. **零术语**：文案 checklist（批准 / 请求修改 / 回复 / 删除）— 是否就按这个来，还是 PM 另有措辞偏好？

---

