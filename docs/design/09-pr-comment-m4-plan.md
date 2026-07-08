# v0.5.0 M4 实施计划 — PR 对话区 UI 重设计

> **创建日期**：2026-07-04
> **分支**：feat/v0.5.0
> **目标**：三 Tab 布局（概览/文件评论/对话） + 文件评论 UI + Review 事件消息
> **预估工时**：~40-50h（后端 12h + 前端 25h + 测试文档 8h）

---

## 1. 当前能力盘点（已完成 ✅ / 待补 ❌）

### 1.1 PlatformAdapter interface

| 方法 | Gitea | GitHub | app.go binding | ipc-client | 前端 UI |
|---|---|---|---|---|---|
| ListPullComments | ✅ | ✅ | ✅ | ✅ | ✅ 对话流 |
| CreatePullComment | ✅ | ✅ | ✅ | ✅ | ✅ |
| UpdatePullComment | ✅ | ✅ | ✅ | ✅ | ✅ |
| DeletePullComment | ✅ | ✅ | ✅ | ✅ | ✅ |
| Reactions (List/Add/Remove) | ✅ | ✅ | ✅ | ✅ | ✅ ReactionBar |
| ListPullReviews | ✅ | ✅ | ✅ | ✅ | ✅ 审查区 |
| CreatePullReview | ✅ | ✅ | ✅ | ✅ | ✅ |
| **ListPullReviewComments** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **CreatePullReviewComment** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **ListPullFiles** | ❌ | ❌ | ❌ | ❌ | ❌ |
| **GetPullFileDiff** | ❌ | ❌ | ❌ | ❌ | ❌ |

### 1.2 DTO（types/dto.ts）

| DTO | 状态 |
|---|---|
| PullReviewCommentDto | ✅ 已有 |
| CreatePullReviewCommentArgs | ✅ 已有 |
| PullFileDTO | ❌ 需新增 |
| PullFileDiffDTO | ❌ 需新增 |

### 1.3 前端 MergesView.vue

| 功能 | 状态 |
|---|---|
| 概览 meta 行 | ✅ |
| 审查区 (reviews 列表 + 编辑器) | ✅ |
| 对话区 (issue comments + 编辑/删除/reaction) | ✅ |
| 三 Tab 布局 | ❌ |
| 文件评论 (按文件分组/行号/reaction) | ❌ |
| Review 事件消息插入对话流 | ❌ |

---

## 2. API 参考

### 2.1 Gitea REST API

| 能力 | 端点 | 方法 |
|---|---|---|
| 列行内评审评论 | `/repos/{owner}/{repo}/pulls/{index}/comments` | GET |
| 发行内评审评论 | `/repos/{owner}/{repo}/pulls/{index}/comments` | POST |
| 列 PR 修改文件 | `/repos/{owner}/{repo}/pulls/{index}/files` | GET |
| 获取 PR diff | `/repos/{owner}/{repo}/pulls/{index}.diff` | GET |

### 2.2 GitHub REST API

| 能力 | 端点 | 方法 |
|---|---|---|
| 列行内评审评论 | `/repos/{owner}/{repo}/pulls/{number}/comments` | GET |
| 发行内评审评论 | `/repos/{owner}/{repo}/pulls/{number}/comments` | POST |
| 列 PR 修改文件 | `/repos/{owner}/{repo}/pulls/{number}/files` | GET |
| 获取 PR diff | `/repos/{owner}/{repo}/pulls/{number}` (Accept: application/vnd.github.v3.diff) | GET |

---

## 3. 实施步骤

### Phase A: 后端扩展

#### Step A1: GitHubAdapter 补全 ReviewComments

- `ListPullReviewComments` (GET /repos/{owner}/{repo}/pulls/{number}/comments)
- `CreatePullReviewComment` (POST /repos/{owner}/{repo}/pulls/{number}/comments)

#### Step A2: 新增 ListPullFiles + GetPullFileDiff

- PlatformAdapter interface 加 2 方法
- GiteaAdapter 实现
- GitHubAdapter 实现
- 新 DTO: PullFileDTO, PullFileDiffDTO

#### Step A3: app.go Wails bindings

- `ListPullReviewComments(args) → []PullReviewCommentDTO`
- `CreatePullReviewComment(args) → PullReviewCommentDTO`
- `ListPullFiles(args) → []PullFileDTO`
- `GetPullFileDiff(args) → PullFileDiffDTO`

#### Step A4: Go 单测

- `github/adapter_test.go` 加 ReviewComments / Files / Diff 测试
- `gitea/adapter_test.go` 加 Files / Diff 测试

### Phase B: 前端扩展

#### Step B1: ipc-client.ts + dto.ts 扩展

- 新增 `pullsReviewCommentsList` / `pullsReviewCommentCreate` / `pullsFilesList` / `pullsFileDiffGet`
- dto.ts 新增 PullFileDTO / PullFileDiffDTO

#### Step B2: pull store 扩展

- `reviewCommentsByPR: Map<number, PullReviewCommentDto[]>`
- `filesByPR: Map<number, PullFileDTO[]>`
- `loadReviewComments(projectId, index)`
- `loadFiles(projectId, index)`

#### Step B3: MergesView.vue 三 Tab 布局

- PR 详情顶部加 Tab 条：「概览」「文件评论 (N)」「对话 (N)」
- 默认 active = 「概览」
- Tab 切换只改显示区域，不重建数据

#### Step B4: 文件评论 UI

- 按文件分组，每个文件可折叠
- 文件 header: `path` + `+N / -N` status 色 + 评论数
- 文件下方行内评论列表: 头像 + 用户名 + 「第 N 行」 + 正文 + Reaction

#### Step B5: Review 事件消息

- 对话流中按 submittedAt 时间线插入 review 事件卡片
- 虚线边框 + 绿色(approved) / 橙色(changes_requested) / 灰色(commented)
- 从已有的 ListPullReviews 数据衍生

### Phase C: 打磨 + 发布

#### Step C1: 零术语回归
- 「批准」「请求修改」保持中文
- 文件评论中的术语（diff, commit, etc）处理

#### Step C2: 交互细节
- 编辑态 textarea auto-resize
- Reaction toggle 乐观更新
- Review 提交后自动刷新
- 错误处理全覆盖

#### Step C3: 文档 + 发布
- ADR-0008 PR 评论模块 v0.5.0 设计决策
- docs/releases/v0.5.0.md
- AGENTS.md 更新
- tag v0.5.0

---

## 4. 文件变更清单

### Go 后端
- `app/platform/github/adapter.go` — 加 ReviewComments + Files + Diff (约 +80 行)
- `app/platform/gitea/adapter.go` — 加 Files + Diff (约 +60 行)
- `app/platform/adapter.go` — interface + DTO 扩展 (约 +40 行)
- `app.go` — 4 个 Wails bindings (约 +120 行)
- `app/platform/github/adapter_test.go` — 加测试 (约 +150 行)
- `app/platform/gitea/adapter_test.go` — 加测试 (约 +100 行)

### 前端 TypeScript/Vue
- `frontend/src/types/dto.ts` — 加 2 DTO (约 +20 行)
- `frontend/src/lib/ipc-client.ts` — 加 4 方法 (约 +40 行)
- `frontend/src/stores/pull.ts` — 扩展 state + actions (约 +80 行)
- `frontend/src/views/MergesView.vue` — 三 Tab + 文件评论 + Review 事件 (+300 行 HTML/CSS)

### 文档
- `docs/adr/0008-pr-comment-v05-enhancement.md` — 约 +300 行
- `docs/releases/v0.5.0.md` — 约 +200 行
- `AGENTS.md` — 更新里程碑章节

---

## 5. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| GitHub file diff 格式与 Gitea 不同 | 解析失败 | 抽象 DiffParser 接口，各自适配 |
| 大 PR 修改 100+ 文件 | 前端卡顿 | 虚拟滚动 + 折叠默认只展开前 5 个文件 |
| review event 混入对话流导致时间线混乱 | UX 混乱 | 用虚线边框+系统头像明确区分 |
| GitHub API 对 review comments 分页 | 遗漏数据 | 前端一次请求 per_page=100 兜底 |
| Gitea low version 不支援 pulls/files | 404 | 前端 fallback 隐藏文件评论 Tab |
