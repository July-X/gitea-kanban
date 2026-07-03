# v0.5.0 PR 评论模块对齐 Gitea/GitHub 功能设计

> **本文件为 v0.5.0 PR 评论模块对齐 Gitea/GitHub 完整功能的总体设计**
>
> 最后更新：2026-07-03（**M1-M3 已实施完成，M4 待收尾**）
>
> ## 实施进度
>
> | 里程碑 | 状态 | 测试 |
> |---|---|---|
> | M1: 评论 CRUD 补齐 (编辑+删除) | ✅ 已完成 | 8 tests PASS (Gitea 4 + GitHub 4) |
> | M2: 表情反应 (Reactions) | ✅ 已完成 | 7 tests PASS (Gitea 3 + GitHub 4) |
> | M3: 整体评审 (Review) | ✅ 已完成 | 7 tests PASS (Gitea 3 + GitHub 4) |
> | M4: UI/UX 打磨+收尾 | 🔄 进行中 | — |
>
> 相关 ADR：[ADR-0008 PR 评论模块功能扩展]()（待创建）

---

## 1. 设计目标

### 1.1 核心目标

对齐 Gitea 与 GitHub 两大平台的 PR 评论能力，让 **gitea-kanban** 的合并请求评论体验达到两大平台 Web UI 的 80% 覆盖度。

### 1.2 对齐范围

| 能力 | Gitea API | GitHub API | 本项目现状 | 目标 |
|---|---|---|---|---|
| 列评论 | `GET /issues/{id}/comments` ✅ | `GET /issues/{n}/comments` ✅ | ✅ 已实现 | 维持 |
| 发评论 | `POST /issues/{id}/comments` ✅ | `POST /issues/{n}/comments` ✅ | ✅ 已实现 | 维持 |
| **编辑评论** | `PATCH /issues/comments/{id}` ✅ | `PATCH /issues/comments/{id}` ✅ | ❌ 缺失 | **本次新增** |
| **删除评论** | `DELETE /issues/comments/{id}` ✅ | `DELETE /issues/comments/{id}` ✅ | ❌ 缺失 | **本次新增** |
| **列表情反应** | `GET /issues/comments/{id}/reactions` ✅ | `GET /issues/comments/{id}/reactions` ✅ | ❌ 缺失 | **本次新增** |
| **添加表情反应** | `POST /issues/comments/{id}/reactions` ✅ | `POST /issues/comments/{id}/reactions` ✅ | ❌ 缺失 | **本次新增** |
| **移除表情反应** | `DELETE /issues/comments/{id}/reactions` ✅ | `DELETE /issues/comments/{id}/reactions` ✅ | ❌ 缺失 | **本次新增** |
| **列评审** | `GET /pulls/{id}/reviews` ✅ | `GET /pulls/{n}/reviews` ✅ | ❌ 缺失 | **本次新增** |
| **创建评审** | `POST /pulls/{id}/reviews` ✅ | `POST /pulls/{n}/reviews` ✅ | ❌ 缺失 | **本次新增** |
| **提交评审** | `POST /pulls/{id}/reviews/{id}/events` ✅ | `PUT /pulls/{n}/reviews/{id}/events` ✅ | ❌ 缺失 | **本次新增** |
| **列行内评审** | `GET /pulls/{id}/comments` ✅ | `GET /pulls/{n}/comments` ✅ | ❌ 缺失 | v0.6.0 |
| **创建行内评审** | `POST /pulls/{id}/comments` ✅ | `POST /pulls/{n}/comments` ✅ | ❌ 缺失 | v0.6.0 |

### 1.3 明确不做

| 排除项 | 原因 |
|---|---|
| 行内评审 (Inline Review Comment) | 需要 diff 解析引擎 + 行号对齐，复杂度极高，推 v0.6.0 |
| 评审线程回复 (Review Thread / Reply) | 需要 N 层嵌套渲染 + resolve/reopen，推 v0.6.0 |
| 图片附件上传 | Gitea/GitHub 走各自附件 API（gitea 走 repo asset / github 走 issue asset），推 v0.6.0 |
| 评论模板 | 客户端本地存储即可，非平台 API 能力 |
| Suggested Change (Gitea 智能建议代码修改) | 高级功能，推 v0.6.0 |

---

## 2. 版本规划

### v0.5.0 总体里程碑

```
v0.5.0 设计分 4 个里程碑（M1-M4），按期交付：

M1: 评论 CRUD 补齐          (edit + delete)
M2: 表情反应                (reactions)
M3: 整体评审                (review approve / request changes / comment)
M4: UI/UX 打磨 + 测试收尾    (零术语回归 + 跨端验证)
```

每个里程碑目标 EXIT=0（go test + go vet + pnpm build 全通过）。

---

## 3. M1: 评论 CRUD 补齐

### 3.1 后端变更

#### 3.1.1 PlatformAdapter 接口新增

```go
// app/platform/adapter.go

// UpdatePullComment 编辑合并请求评论
//
// Gitea:  PATCH /repos/{owner}/{repo}/issues/comments/{id}
// GitHub: PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}
//
// 仅评论作者本人能编辑（服务端 403 如果不是作者）。返回更新后的评论 DTO。
UpdatePullComment(ctx context.Context, hostURL, username, token, owner, repo string, commentID int64, body string) (*CommentDTO, error)

// DeletePullComment 删除合并请求评论
//
// Gitea:  DELETE /repos/{owner}/{repo}/issues/comments/{id}
// GitHub: DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}
//
// 仅评论作者本人 / 仓库管理员能删除。成功时返回 nil error。
// Gitea 即使评论已被删除也会返 204（幂等），GitHub 也是。
DeletePullComment(ctx context.Context, hostURL, username, token, owner, repo string, commentID int64) error
```

#### 3.1.2 GiteaAdapter 实现

```go
// app/platform/gitea/adapter.go

func (a *GiteaAdapter) UpdatePullComment(ctx context.Context, hostURL, username, token, owner, repo string, commentID int64, body string) (*platform.CommentDTO, error) {
    if strings.TrimSpace(body) == "" {
        return nil, ipc.NewValidationFailed("评论内容不能为空", "")
    }
    payload := map[string]any{"body": body}
    reader, err := encodeJSONBody(payload)
    if err != nil { return nil, err }
    var raw giteaCommentRaw
    path := fmt.Sprintf("/repos/%s/%s/issues/comments/%d", owner, repo, commentID)
    if err := a.doRequest(ctx, hostURL, token, "PATCH", path, reader, &raw); err != nil {
        return nil, err
    }
    dto := giteaCommentToDTO(raw)
    return &dto, nil
}

func (a *GiteaAdapter) DeletePullComment(ctx context.Context, hostURL, username, token, owner, repo string, commentID int64) error {
    path := fmt.Sprintf("/repos/%s/%s/issues/comments/%d", owner, repo, commentID)
    // doRequest 返回 204 no-content；GitHub/Gitea 都以 2xx 表示成功
    return a.doRequest(ctx, hostURL, token, "DELETE", path, nil, nil)
}
```

#### 3.1.3 GitHubAdapter 实现

同 Gitea 逻辑，路径一致，鉴权走 Bearer。

#### 3.1.4 App.go Wails Bindings 新增

```go
// app.go

// UpdatePullCommentArgs
type UpdatePullCommentArgs struct {
    ProjectID string `json:"projectId"`
    CommentID int64  `json:"commentId"`
    Body      string `json:"body"`
}

func (a *App) UpdatePullComment(args UpdatePullCommentArgs) (PullCommentDTO, error) {
    // 1. resolvePullContext 拿 account/project/token/adapter
    // 2. adapter.UpdatePullComment(ctx, account.GiteaURL, account.Username, token, project.Owner, project.Name, args.CommentID, args.Body)
    // 3. 成功后 slog.Info 审计日志
}

type DeletePullCommentArgs struct {
    ProjectID string `json:"projectId"`
    CommentID int64  `json:"commentId"`
}

func (a *App) DeletePullComment(args DeletePullCommentArgs) error {
    // 同上，走 adapter.DeletePullComment
}
```

#### 3.1.5 ipc-client.ts 新增

```typescript
// frontend/src/lib/ipc-client.ts

export function pullsCommentUpdate(args: { projectId: string; commentId: number; body: string }) {
  return window.go.main.App.UpdatePullComment(args);
}

export function pullsCommentDelete(args: { projectId: string; commentId: number }) {
  return window.go.main.App.DeletePullComment(args);
}
```

### 3.2 前端变更

#### 3.2.1 MergesView.vue — 评论编辑

每条评论卡片新增：
- **3 点菜单 (⋮)**：仅评论作者本人可见
  - "编辑评论" → 行内编辑态（textarea 替换文本展示）
  - "删除评论" → 二次确认弹窗

编辑态交互：
- 编辑框复用评论输入框样式
- 保存按钮（✓）→ 调 `pullsCommentUpdate`
- 取消按钮（✕）→ 还原原文
- Enter 提交 / Shift+Enter 换行 / Esc 取消
- 保存中 disabled 提交按钮 + loading spinner

#### 3.2.2 MergesView.vue — 评论删除

二次确认弹窗：
- 标题："删除评论"
- 正文："确定要删除这条评论吗？删除后无法恢复。"
- 危险确认按钮（红色）

删除流程：
1. 用户点删除 → 弹窗
2. 确认 → `pullsCommentDelete` → 成功则 panel.items 本地过滤掉该评论
3. 失败 → toast 提示 "删除失败"

### 3.3 DTO 变更

无需新增 DTO，复用现有 `CommentDTO`：
```go
type CommentDTO struct {
    ID        int64         `json:"id"`
    Body      string        `json:"body"`
    Author    *PullUserDTO  `json:"author,omitempty"`
    CreatedAt string        `json:"createdAt"`
    UpdatedAt string        `json:"updatedAt,omitempty"`
}
```

前端 `IssueCommentDto` 已有 `updatedAt` 字段 — 编辑后展示 "已编辑" 标记。

### 3.4 测试计划

新增测试：
1. `app/platform/gitea/adapter_test.go`：`TestUpdatePullComment` + `TestDeletePullComment`（httptest mock PATCH/DELETE）
2. `app/platform/github/adapter_test.go`：同上 GitHub 版
3. `app/platform/adapter_test.go`：确认接口新增后 GiteaAdapter + GitHubAdapter 仍然满足 PlatformAdapter（编译期检查）

---

## 4. M2: 表情反应 (Reactions)

### 4.1 后端变更

#### 4.1.1 PlatformAdapter 接口新增

```go
// app/platform/adapter.go

// ListPullCommentReactions 列评论表情反应
//   Gitea:  GET /repos/{owner}/{repo}/issues/comments/{id}/reactions
//   GitHub: GET /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions
//   返回 ReactionDTO 列表（按 user 维度，每个 user 一个 reaction）
ListPullCommentReactions(ctx context.Context, hostURL, username, token, owner, repo string, commentID int64) ([]ReactionDTO, error)

// AddPullCommentReaction 添加表情反应
//   Gitea:  POST /repos/{owner}/{repo}/issues/comments/{id}/reactions {content: "+1"}
//   GitHub: POST /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions {content: "+1"}
//   返回新增的 ReactionDTO
AddPullCommentReaction(ctx context.Context, hostURL, username, token, owner, repo string, commentID int64, content string) (*ReactionDTO, error)

// RemovePullCommentReaction 移除表情反应
//   Gitea:  DELETE /repos/{owner}/{repo}/issues/comments/{id}/reactions {content: "+1"}（body 必填！）
//   GitHub: DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions/{reaction_id}（按 id 删）
//   成功返回 nil error
RemovePullCommentReaction(ctx context.Context, hostURL, username, token, owner, repo string, commentID int64, content string) error
```

#### 4.1.2 ReactionDTO

```go
// app/platform/adapter.go

// ReactionDTO 单条表情反应
type ReactionDTO struct {
    ID      int64        `json:"id"`            // GitHub 的 reaction id（Gitea 也用 id 但语义不同）
    Content string       `json:"content"`       // "+1" / "-1" / "laugh" / "confused" / "heart" / "hooray" / "eyes" / "rocket"
    User    *PullUserDTO `json:"user"`          // 谁点的
}
```

#### 4.1.3 Gitea reactions 实现

```go
// app/platform/gitea/adapter.go

// giteaReactionRaw Gitea reactions 端点原始响应
type giteaReactionRaw struct {
    ID      int64         `json:"id"`
    User    *giteaUserRaw `json:"user"`
    Reaction string       `json:"reaction"`  // Gitea 字段名是 "reaction"（单数）
}

func (a *GiteaAdapter) ListPullCommentReactions(ctx context.Context, hostURL, username, token, owner, repo string, commentID int64) ([]platform.ReactionDTO, error) {
    var raw []giteaReactionRaw
    path := fmt.Sprintf("/repos/%s/%s/issues/comments/%d/reactions", owner, repo, commentID)
    if err := a.doRequest(ctx, hostURL, token, "GET", path, nil, &raw); err != nil {
        return nil, err
    }
    out := make([]platform.ReactionDTO, 0, len(raw))
    for _, r := range raw {
        out = append(out, giteaReactionToDTO(r))
    }
    return out, nil
}

func (a *GiteaAdapter) AddPullCommentReaction(ctx context.Context, hostURL, username, token, owner, repo string, commentID int64, content string) (*platform.ReactionDTO, error) {
    payload := map[string]any{"content": content}
    reader, err := encodeJSONBody(payload)
    if err != nil { return nil, err }
    var raw giteaReactionRaw
    path := fmt.Sprintf("/repos/%s/%s/issues/comments/%d/reactions", owner, repo, commentID)
    if err := a.doRequest(ctx, hostURL, token, "POST", path, reader, &raw); err != nil {
        return nil, err
    }
    dto := giteaReactionToDTO(raw)
    return &dto, nil
}

func (a *GiteaAdapter) RemovePullCommentReaction(ctx context.Context, hostURL, username, token, owner, repo string, commentID int64, content string) error {
    // Gitea 删除反应必须带 body: {content: "..."}（与 GitHub 不同！）
    payload := map[string]any{"content": content}
    reader, err := encodeJSONBody(payload)
    if err != nil { return err }
    path := fmt.Sprintf("/repos/%s/%s/issues/comments/%d/reactions", owner, repo, commentID)
    return a.doRequest(ctx, hostURL, token, "DELETE", path, reader, nil)
}
```

#### 4.1.4 GitHub reactions 实现

GitHub 的 DELETE /reactions/{reaction_id} 需要先拿 reaction id —— 实现时从 List 结果里按当前用户过滤取 id。

```go
// app/platform/github/adapter.go

type githubReactionRaw struct {
    ID        int64          `json:"id"`
    User      *githubUserRaw `json:"user"`
    Content   string         `json:"content"`  // GitHub 字段名是 "content"
}

// AddPullCommentReaction POST /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions
// body: {content: "+1"} — GitHub 限制 content 必须是受支持表情名
func (a *GitHubAdapter) AddPullCommentReaction(ctx context.Context, hostURL, username, token, owner, repo string, commentID int64, content string) (*platform.ReactionDTO, error) {
    // GitHub reactions content 白名单（至少支持 8 种）：
    // "+1", "-1", "laugh", "confused", "heart", "hooray", "eyes", "rocket"
    validReactions := map[string]bool{"+1": true, "-1": true, "laugh": true, "confused": true, "heart": true, "hooray": true, "eyes": true, "rocket": true}
    if !validReactions[content] {
        return nil, ipc.NewValidationFailed("不支持的表情类型: "+content, "")
    }
    // ... POST 逻辑
}

// RemovePullCommentReaction DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions/{reaction_id}
// GitHub 按 reaction id 删（需要先 GET list 拿 id）
func (a *GitHubAdapter) RemovePullCommentReaction(ctx context.Context, hostURL, username, token, owner, repo string, commentID int64, content string) error {
    // 1. 先 List 当前 reaction list 拿匹配 user + content 的 reaction id
    // 2. DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions/{reaction_id}
}
```

#### 4.1.5 App.go Bindings 新增

```go
type ListPullCommentReactionsArgs struct { ... }
type AddPullCommentReactionArgs struct { ... Content string }
type RemovePullCommentReactionArgs struct { ... Content string }
```

方法：
- `func (a *App) ListPullCommentReactions(args ListPullCommentReactionsArgs) ([]ReactionDTO, error)`
- `func (a *App) AddPullCommentReaction(args AddPullCommentReactionArgs) (ReactionDTO, error)`
- `func (a *App) RemovePullCommentReaction(args RemovePullCommentReactionArgs) error`

#### 4.1.6 App.go — Bindings `platform.Adapter` 兼容

Reaction 列/增/删是双平台都支持的能力（Gitea + GitHub reactions API 语义整数一致），所以不在 GitHub 端返 ErrNotSupported。

### 4.2 前端变更

#### 4.2.1 ReactionBar 组件（新建）

```
frontend/src/components/ReactionBar.vue
```

功能：
- 展示当前评论的所有 reaction 分组（emoji + 计数 + 当前用户是否已点）
- 每个 reaction 单条：可切换 toggle（已点 → 取消；未点 → 添加）
- "+" 按钮 → emoji 下拉托盘（受支持 8 种表情）
- 前端防重入：toggle 中 disabled

#### 4.2.2 表情 emoji 映射表

```typescript
// frontend/src/lib/reactions.ts
export const REACTIONS: { content: string; emoji: string; label: string }[] = [
  { content: '+1',      emoji: '👍', label: '赞同' },
  { content: '-1',      emoji: '👎', label: '反对' },
  { content: 'laugh',   emoji: '😄', label: '笑脸' },
  { content: 'confused',emoji: '😕', label: '困惑' },
  { content: 'heart',   emoji: '❤️', label: '喜爱' },
  { content: 'hooray',  emoji: '🎉', label: '庆祝' },
  { content: 'eyes',    emoji: '👀', label: '关注' },
  { content: 'rocket',  emoji: '🚀', label: '火箭' },
];
```

#### 4.2.3 MergesView.vue — 集成 ReactionBar

- 每条评论卡片底部嵌入 `<ReactionBar :comment-id="c.id" :project-id="activeProjectId" :reactions="c.reactions" />`
- 评论 DTO 新增可选 `reactions?: ReactionGroupDto[]` 字段
- 加载评论时一并拉 reactions（N+1 问题：单 PR 评论一般 < 50，可接受；或在 fetchComments 时并发拉）

#### 4.2.4 性能策略

每条评论加载后并发拉 reactions（Promise.all），不阻塞评论内容渲染。

```typescript
async function fetchComments(p: PullDto): Promise<void> {
    const list = await pullsCommentList({ ... });
    panel.items = list;
    // 并发拉所有评论 reactions
    await Promise.all(list.map(async (c) => {
        try {
            c.reactions = await pullsCommentReactionsList({ projectId, commentId: c.id });
        } catch { c.reactions = []; }
    }));
}
```

### 4.3 DTO 变更

前端新增：
```typescript
// frontend/src/types/dto.ts
export interface ReactionDto {
  id: number;
  content: string;        // "+1" / "laugh" / ...
  user: IssueAuthorDto;
}

export interface ReactionGroupDto {
  content: string;           // 表情名
  count: number;             // 计数
  users: IssueAuthorDto[];   // 前 N 个用户（tooltip 用）
  viewerReacted: boolean;    // 当前用户是否已点 — 后端按 account.Username 判断
}
```

后端 `ReactionDTO` 推前端后按 content + user 聚合为 `ReactionGroupDto`。

### 4.4 测试计划

1. `gitea/adapter_test.go`：`TestListPullCommentReactions` / `TestAddPullCommentReaction` / `TestRemovePullCommentReaction`
2. `github/adapter_test.go`：同上 3 个
3. `ReactionBar-test`：不写单元测试（集成测试靠 M4 手动跑 wails dev）

---

## 5. M3: 整体评审 (Review Summary)

### 5.1 概念说明

Gitea / GitHub 都有 Review 概念 — 可：
- **Approve**：批准合并（绿灯）
- **Request Changes**：请求修改（红灯）
- **Comment**：仅评论不开黄灯（plain comment review）

前端展示：PR 详情内嵌 "审查" 区块（位于评论区上方或侧边），汇总全部 reviews。

### 5.2 后端变更

#### 5.2.1 PlatformAdapter 接口新增

```go
// app/platform/adapter.go

// ListPullReviews 列合并请求评审
//   Gitea:  GET /repos/{owner}/{repo}/pulls/{index}/reviews
//   GitHub: GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews
//   按 createdAt 升序
ListPullReviews(ctx context.Context, hostURL, username, token, owner, repo string, index int) ([]PullReviewDTO, error)

// CreatePullReview 创建评审
//   Gitea:  POST /repos/{owner}/{repo}/pulls/{index}/reviews
//   GitHub: POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews
//   body: {commit_id, body, event, comments[]}
//   event: "approve" / "request_changes" / "comment"（Gitea 全部支持；GitHub 等价 APPROVE / REQUEST_CHANGES / COMMENT）
CreatePullReview(ctx context.Context, hostURL, username, token, owner, repo string, index int, opts CreateReviewOpts) (*PullReviewDTO, error)
```

#### 5.2.2 CreateReviewOpts

```go
type CreateReviewOpts struct {
    CommitID string              // 可选：评审针对的 commit SHA（空 = HEAD）
    Body     string              // 评审总结文
    Event    string              // "approve" | "request_changes" | "comment"
    Comments []ReviewComment     // 行内评论（本次不上，留空切片） — M4 用
}

type ReviewComment struct {
    Path     string // 文件路径
    Position int    // diff position（GitHub）/ line（Gitea）
    Body     string // 行内评论内容
}
```

#### 5.2.3 PullReviewDTO

```go
type PullReviewDTO struct {
    ID          int64        `json:"id"`
    State       string       `json:"state"`        // "approved" / "changes_requested" / "commented"
    Body        string       `json:"body"`         // 评审总结文
    Author      *PullUserDTO `json:"author"`
    CommitID    string       `json:"commitId"`     // 评审针对的 commit SHA
    SubmittedAt string       `json:"submittedAt"`  // 评审时间
}
```

#### 5.2.4 Gitea 实现

```go
// Gitea create review body: {commit_id, body, event, comments: [{body, path, new_position, old_position}]}
// Gitea 3 种 event 值: "approve" / "request_changes" / "comment"
func (a *GiteaAdapter) CreatePullReview(ctx context.Context, hostURL, username, token, owner, repo string, index int, opts CreateReviewOpts) (*platform.PullReviewDTO, error) {
    // 1. 校验 event 值
    validEvents := map[string]bool{"approve": true, "request_changes": true, "comment": true}
    if !validEvents[opts.Event] {
        return nil, ipc.NewValidationFailed("非法的评审事件: "+opts.Event, "支持的值: approve / request_changes / comment")
    }
    // 2. 构造 body
    body := map[string]any{
        "commit_id": opts.CommitID,
        "body": opts.Body,
        "event": opts.Event,
        "comments": opts.Comments,
    }
    reader, _ := encodeJSONBody(body)
    var raw giteaReviewRaw
    path := fmt.Sprintf("/repos/%s/%s/pulls/%d/reviews", owner, repo, index)
    if err := a.doRequest(ctx, hostURL, token, "POST", path, reader, &raw); err != nil {
        return nil, err
    }
    return giteaReviewToDTO(raw), nil
}
```

#### 5.2.5 GitHub 实现

```go
// GitHub create review body: {commit_id, body, event, comments: [{body, path, position}]}
// GitHub event: "APPROVE" / "REQUEST_CHANGES" / "COMMENT"
// ⚠️ GitHub event 值是全大写！映射：approve → APPROVE, request_changes → REQUEST_CHANGES, comment → COMMENT
func mapReviewEventToGitHub(event string) string {
    switch event {
    case "approve": return "APPROVE"
    case "request_changes": return "REQUEST_CHANGES"
    case "comment": return "COMMENT"
    default: return event
    }
}
```

#### 5.2.6 App.go Bindings 新增

```go
type ListPullReviewsArgs struct { ProjectID string; Index int }
type CreatePullReviewArgs struct {
    ProjectID string;
    Index     int;
    CommitID  string;
    Body      string;
    Event     string;
    // Comments 仍然不上（M4）
}

func (a *App) ListPullReviews(args ListPullReviewsArgs) ([]PullReviewDTO, error)
func (a *App) CreatePullReview(args CreatePullReviewArgs) (PullReviewDTO, error)
```

#### 5.2.7 ipc-client.ts 新增

```typescript
export function pullsReviewsList(args: { projectId: string; index: number }) { ... }
export function pullsReviewCreate(args: { projectId: string; index: number; commitId?: string; body?: string; event: string }) { ... }
```

### 5.3 前端变更

#### 5.3.1 审查区块 (ReviewSection)

MergesView.vue 内，每条评论卡片上方 / 评论列表新增 **"审查"** 分隔区块：

```
┌─ 审查 ────────────────────────────────────────────┐
│ [@alice · 已批准 · 2 天前]                          │
│ LGTM! 代码整洁，建议直接合并。                        │
│                                                    │
│ [@bob · 请求修改 · 1 天前]                           │
│ 第 42 行建议用 const 替代 let，其他无问题。           │
└────────────────────────────────────────────────────┘

┌─ 操作 ────────────────────────────────────────────┐
│ [批准] [请求修改] [仅评论]                          │
│ 总结：[输入 textarea]                               │
│ [提交审查]                                         │
└────────────────────────────────────────────────────┘
```

#### 5.3.2 按钮位置

合并操作区（已存在的 merge / close 按钮区块）新增：
- "批准" 绿色按钮
- "请求修改" 红色按钮
- "仅评论" 灰色按钮
- 点击任一个 → 打开 review 编辑器（summary textarea + 提交 / 取消）

#### 5.3.3 状态标识

- 已批准：绿色 ✓ 徽章 + "已批准"
- 请求修改：红色 ✗ 徽章 + "请求修改"
- 仅评论：灰色 💬 徽章 + "已评论"
- 仅在 open 状态的 PR 可提交 review；已 closed / merged 时隐藏操作按钮

#### 5.3.4 ReviewSection 组件（新建）

```
frontend/src/components/ReviewSection.vue
```

输入 Props：`pr: PullDto`，`projectId: string`

内部状态：reviews 列表、loading、review editor 开关、selected event、body

### 5.4 DTO 变更

前端新增：
```typescript
// frontend/src/types/dto.ts
export interface PullReviewDto {
  id: number;
  state: 'approved' | 'changes_requested' | 'commented';
  body: string;
  author: PullAuthorDto;
  commitId?: string;
  submittedAt: string;
}

export interface CreateReviewArgs {
  projectId: string;
  index: number;
  commitId?: string;
  body?: string;
  event: 'approve' | 'request_changes' | 'comment';
}
```

后端新增对应 DTO + 映射。

### 5.5 测试计划

1. `gitea/adapter_test.go`：`TestListPullReviews` / `TestCreatePullReview_Approve` / `TestCreatePullReview_RequestChanges` / `TestCreatePullReview_Comment`
2. `github/adapter_test.go`：同上 4 个 + `TestReviewEventMappingToGitHub`
3. `app_test.go`：`TestApp_ListPullReviews` / `TestApp_CreatePullReview`（mock adapter）

---

## 6. M4: UI/UX 打磨 + 测试收尾

### 6.1 零术语回归检查

检查所有新增 UI 文案，确保无禁用原词：

| 禁用词 | 替代 |
|---|---|
| PR | 合并请求 |
| merge | 合并 |
| approve / approval | 批准 |
| request changes | 请求修改 |
| reaction | 表情 / 回应 |
| review | 审查 |

### 6.2 前端交互细节

- 编辑态 textarea 自动高度 (auto-resize)
- 评论编辑时保留 `updatedAt` 变化自动显示 "已编辑" 标记
- Reactions toggle 乐观更新（toggle 立即响应，失败回滚）
- Review section 提交后自动 refresh 列表 + 滚到顶部
- 删除评论后 panel.items 本地过滤，无需全量刷新

### 6.3 性能

- 单 PR 评论 + reactions + reviews 全部 < 50 条，一次性并发拉取
- Edit / Delete / Reaction toggle 成功后**不**全量刷新，局部更新 state

### 6.4 错误处理

- 编辑评论时 403（非作者）→ toast "无权编辑他人评论"
- 反应 404 → toast "评论已被删除，请刷新"
- Review 422 → toast "提交审查失败：" + server message
- 所有写操作 error → `mapHTTPError` 翻译成"人话"

### 6.5 最终测试

- `go test ./app/...` EXIT=0
- `go vet ./...` EXIT=0
- `pnpm build` EXIT=0
- 手动验收：wails dev 打开 OK 仓库 → 测试评论完整链路

---

## 7. 工时估算

| 里程碑 | 后端 (h) | 前端 (h) | 测试 (h) | 合计 |
|---|---|---|---|---|
| M1: CRUD 补齐 | 2 | 3 | 1 | 6 |
| M2: 表情反应 | 3 | 5 | 1.5 | 9.5 |
| M3: 整体评审 | 4 | 6 | 2 | 12 |
| M4: 打磨收尾 | 1 | 3 | 1 | 5 |
| **合计** | **10** | **17** | **5.5** | **32.5** |

按实际开发节奏，预计 2-3 周可完整交付（含人工验收）。

---

## 8. 验收标准

### M1 验收
- [ ] 任意评论作者可编辑自己的评论 → 前端显示 "已编辑" + 新内容
- [ ] 任意评论作者可删除自己的评论 → 列表中消失
- [ ] 服务端拒绝对非作者的编辑/删除 → 前端 toast "无权操作"
- [ ] Gitea + GitHub 双平台跑通

### M2 验收
- [ ] 评论下方展示 reaction 列表（emoji + 计数）
- [ ] 点击 reaction 切换 toggle（已点取消 / 未点添加）
- [ ] "+" 展开 emoji 8 选 1 下拉
- [ ] Gitea + GitHub 双平台跑通
- [ ] 并发 toggle 无竞态

### M3 验收
- [ ] PR 详情展示审查区块 + 现有 reviews 列表
- [ ] "批准" / "请求修改" / "仅评论" 三个按钮交互
- [ ] 提交审查后列表立即刷新
- [ ] GitHub 提交 "APPROVE" → github 上看到 approved
- [ ] Gitea 提交 "approve" → gitea 上看到 approved
- [ ] Closed / merged 的 PR 隐藏审查操作

### M4 验收
- [ ] 零术语全文扫描通过
- [ ] 错误提示全文扫描通过
- [ ] 全量 `go test ./app/...` EXIT=0
- [ ] 全量 `go vet ./...` EXIT=0
- [ ] `pnpm build` EXIT=0
- [ ] wails dev 全链路手动验收 OK
- [ ] 设计文档自洽（AGENTS.md + 本文件 + 代码对齐）

---

## 9. 架构决策点

### D-1: reactions 走 issue comments 还是 pulls comments 端点？

**决策：走 issue comments reactions 端点**。

Gitea 与 GitHub 的 reactions 都挂在 issue-level comments 下（/pulls/{id}/comments/{id}/reactions 不存在），而 PR 在两大平台上本质是 issue 的一种，所以 reactions 只能走 issue comments 端点。

### D-2: GitHub reactions 删除按 reaction id 还是 content？

**决策：先 list 拿到 reaction id 再按 id 删除**。

GitHub DELETE 走 `/reactions/{reaction_id}`（不是 content），所以需要先查 list 拿 id。实现时按当前 user + content 过滤取 id。

### D-3: Review event 值要不要平台统一？

**决策：平台统一 "approve" / "request_changes" / "comment"，adapter 层做映射**。

前端只认知 3 个英语词（已在 Gitea 链路跑通），GitHub 层全大写转换委托给 GitHubAdapter。

---

## 10. 后续规划（v0.6.0）

- 行内评审 (Inline Review Comment)：diff 渲染 + 行号对齐 + inline comment pin
- 评审线程回复 (Review Reply threading)
- 图片附件上传 (Issue attachments API)
- Suggested Change (Gitea 智能建议代码修改)
- 评论模板 (本地模板管理)

