# ADR-0008: v0.5.0 PR 评论模块对齐 Gitea/GitHub

> **状态**：已实施
> **决策日期**：2026-07-04
> **背景**：v0.4.0 完成了 PR 基础能力（列表/详情/合并/关闭/评论一半），本期扩展为完整评论能力，对齐 Gitea 1.21+ 与 GitHub REST v3

---

## 1. 现状盘点

v0.4.0 已实现：

| 能力 | 后端 | 前端 |
|---|---|---|
| 列评论 | ✅ `ListPullComments` | ✅ 对话流 |
| 发评论 | ✅ `CreatePullComment` | ✅ |
| 编辑/删除评论 | ✅ M1 | ✅ |
| 表情反应 | ✅ M2 | ✅ ReactionBar |
| 整体评审 | ✅ M3 | ✅ |

**缺失**（本次补齐）：

| 能力 | 后端接口 | 前端 UI |
|---|---|---|
| 按文件取 diff 文件列表 | ❌ | ❌ |
| 按文件取 diff 内容 | ❌ | ❗需要按行解析 Hunk |
| 列 review comments（按文件） | ❌ | ❌ |
| 创建行内 review comment | ❌ | ❌ |
| Review 事件系统卡片（对话流） | ❌ | └── |

---

## 2. 技术决策

### 2.1 API 设计

**本次新增 PlatformAdapter 方法（6 个）：**

| 方法 | 用途 | 兼容性策略 |
|---|---|---|
| `ListPullReviewComments` | 按文件取行内评审评论 | 全版本支持 |
| `CreatePullReviewComment` | 发行内评审评论 | 全版本支持 |
| `ListPullFiles` | 按 PR 取修改文件列表 | 低版本返 `ErrNotSupported` |
| `GetPullFileDiff` | 取单个文件 unified diff | 低版本返 `ErrNotSupported` |
| `ListPullFiles` (GitHub) | 同，per_page=100 | 前端分页一次拉 |
| `GetPullFileDiff` | 同 | 直接 Accept: application/vnd.github.v3.diff |

**Gitea 与 GitHub 差异处理：**

| 差异 | Gitea | GitHub |
|---|---|---|
| reactions 删除方式 | DELETE + body `{content}` | DELETE `/reactions/{id}` |
| review event 值 | 小写 `approve` | 大写 `APPROVE` |
| pulls/files 端点 | Gitea 1.21+ 支援 |  siempre |
| pulls/files 分页 | page+limit | per_page+page |

### 2.2 前端架构

**三 Tab 布局（PR 详情区）：**
- **概览**：meta + 评审区（compatible with v1.x existing）
- **文件评论**：PullFileComments 组件（按文件分组/行号/reaction）
- **对话**：issues 评论 + review 事件系统卡片混合时间线

**对话流合并算法（`timelineItems`）：**

```ts
// 每次新增评论/评审后，按 createdAt/submittedAt 升序合并
items.sort((a, b) => {
  dateA = a.source === 'comment' ? a.createdAt : a.submittedAt;
  dateB = b.source === 'comment' ? b.createdAt : b.submittedAt;
  return dateA.localeCompare(dateB);
});
```

**Review Event 卡片样式：**
- 虚线边框 + 左色边（green/orange/gray）
- 系统 avatar（状态图标：✓ / 💬）
- 中间对齐，弱化 opacity 0.85

### 2.3 DTO 分层

**PlatformAdapter DTO：**
- `PullReviewCommentDto` — Gitea/GitHub 共用
- `PullFileDto` — 文件变更统计
- `PullFileDiffDTO` — 按 hunks 拆分的文件 diff

**App-level DTO：**
- 通过 `App.ListPullReviewComments` 等 bindings 暴露
- frontend `ipc-client.ts` 透传（无 DSL 转换）

---

## 3. 实施顺序

### Phase A: 后端接口扩展
1. `PlatformAdapter` 加 4 个方法
2. `GiteaAdapter` 实现 4 个方法
3. `GitHubAdapter` 实现 4 个方法
4. `app.go` 加 4 个 Wails bindings
5. Go 单测

### Phase B: 前端数据层
1. `types/dto.ts` 加 3 个 DTO
2. `ipc-client.ts` 加 4 个方法
3. `stores/pull.ts` 扩展：4 个新 actions + 3 个新面板状态
4. `stores/pull.ts` 新增 `timelineItems` 计算属性

### Phase C: 前端 UI
1. `PullFileComments.vue` — 文件折叠展开组件
2. `MergesView.vue` — 三 Tab 切换
3. `MergesView.vue` — 对话 Tab 按 `timelineItems` 混合渲染
4. Review Event 卡片 CSS（虚线 + 左色边 + 弱化）

### Phase D: 打磨
1. 零术语回归
2. 错误处理全覆盖（404 / 422 / 403）
3. 乐观更新回滚策略

---

## 4. 验收标准

### 后端
- [x] PlatformAdapter interface compilation
- [x] GiteaAdapter 4 个方法 httptest mock
- [x] GitHubAdapter 4 个方法 httptest mock
- [x] app.go 4 个 bindings 编译

### 前端
- [x] `PullFileComments.vue` 渲染按文件分组
- [x] `MergesView.vue` 三 Tab 切换
- [x] `timelineItems` 按时间升序混合
- [x] Review Event 卡片样式渲染

### 质量
- [x] `go build` 无错误
- [x] `go test ./app/...` 除无关 logexport flakey 外全绿
- [x] `pnpm build` 成功（3.89s）
- [x] `pnpm typecheck` 零错误

---

## 5. 工时估算

| 子项 | 预估 | 实际 |
|---|---|---|
| 后端接口扩展 | 12h | 10h |
| 前端数据层 | 8h | 6h |
| 前端 UI 三 Tab | 15h | 12h |
| Review 事件卡片 | 5h | 4h |
| 文档 + Tag | 5h | 5h |
| **合计** | **45h** | **~37h** |

---

## 6. 相关文档

- 设计文档：`docs/design/08-pr-comment-design.md`
- Wireframe：`docs/design/wireframe/pr-comment.html`
- 实施计划：`docs/design/09-pr-comment-m4-plan.md`
- 测试计划：`app/platform/gitea/adapter_test.go` + `app/platform/github/adapter_test.go`
