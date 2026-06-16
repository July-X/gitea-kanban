# ADR-0004: 单一仓库专注模式（不跨仓库聚合）

- **Status**: Accepted
- **Date**: 2026-06-16
- **Deciders**: xingxing.zhong
- **Related**:
  - `docs/design/00-overview.md` §1 一句话定位、§2 核心特性
  - `docs/design/03-frontend.md` §4 各 view 数据流
  - `src/renderer/stores/repo.ts` currentProject / currentProjectId（单一引用，无聚合）
  - `src/renderer/stores/my-card.ts` §"跨 project 聚合" 段（v1 简化的明示）

## Context

gitea-kanban 定位是"给 gitea 用户的桌面端看板 + 时间轴工具"，目标用户**包含**非技术人员（PM / 设计师 / 运营，AGENTS §1 + 00-overview §1）。

候选"我的视角 / 团队视图 / 跨仓库聚合"在 2026-06-16 user 拍板时浮现——这类设计**假设**用户需要"在一个屏幕看到所有项目进度"。user **明确反对**：

> "不要考虑并发拉所有仓库。我们现在这个选仓库只选一次，让用户专注到单一仓库比较合适。"

## 决策

**gitea-kanban v1.x 不做跨仓库聚合。** 每个 view 只围绕 `useRepoStore().currentProjectId` 单一仓库渲染，用户必须**先选仓库**才能看到该 view 的内容。

### 具体含义

| 维度 | 拍板 |
|---|---|
| 跨仓库聚合视图（"我的视角 = 全部 project 的 issue 合并"） | ❌ 不做 |
| 跨仓库轮询/推送（同时拉 N 个 project 的 IPC） | ❌ 不做 |
| 多仓库 dashboard（顶栏显示"5 个 project 状态概览"） | ❌ 不做 |
| 跨仓库切换提示（"你切到 project B 会丢失 A 的未保存内容"） | ❌ 不做（v1 切仓库不保留 A 上下文） |
| 单一仓库内的多 view 协作（Board / Time / Merges / Cards / Members 互相联动） | ✅ 核心能力 |

### 现状（拍板前已经满足）

v1 代码**已经**是单一仓库模式（无回归风险）：

- `repo.ts:18-50` `currentProject` 状态：单 ref，**不**支持多选
- `repo.ts:40` `currentProjectId` 是**单一** computed（`currentProject.value?.id`）
- 5 个 view（`BoardView` / `MembersView` / `MergesView` / `MyCardsView` / `TimelineView`）**全部** `useRepoStore().currentProjectId` 作为入参，无跨仓库拉取
- `my-card.ts:11` 注释明示："v1 简化 —— 走当前 active project 拉一次，**不**做'全账号下所有仓库聚合'。PM 用户看'我手头有哪些活儿' —— 一开始就 1-3 个活跃仓库，足够"
- 路由 `routes/index.ts:85-95` 守卫"未连接 + 进 requiresAuth 路由 → 跳 /auth"，**不**做"先选仓库再进"

## 拍板理由（user 角度）

1. **认知负担**：跨仓库聚合 = "用户得先想清楚 5 个项目之间怎么对比"——非技术用户**更**做不好
2. **单仓库专注**：选仓库是**用户的明确意图**——PM 切到 "周一的活动" 项目 = "我今天只看这件事"
3. **IPC 性能**：Gitea 自托管实例普遍 4-8 核，跨 N 个仓库并发拉 issue 列表会让主进程打满
4. **离线降级清晰**：单仓库 = "这个仓库的缓存"，跨仓库 = "5 个仓库的缓存混合显示"——用户**无**法判断"现在看到的数据新不新"
5. **Trello / Linear 范式**：行业标准是"先选 workspace → 选 project → 看板"，**不**是"dashboard 里混着看"

## 后续设计边界

- **v1.x**：保持当前 5 view 单仓库模式，**禁止**新增"跨仓库聚合"端点
- **v2+ 跨仓库需求**（如果有）：必须**先**重新走 ADR 流程，不允许"顺便在某个 view 加个跨仓库 toggle"
- **"我的视角" 替代方案**：v1.5+ 如果要做"用户手头卡片"——**仍**走单仓库（"我在当前 project 里被指派的卡"），**不**聚合多仓库
- **团队视图**：v2 单独的路由 `/team`，跟单仓库 view **不**在同一个 store / IPC 命名空间

## 反例（设计踩坑提示）

❌ **不要**在 `stores/my-card.ts` 加 "fetchAllProjectsCards" 这种方法  
❌ **不要**在 `App.vue` / `NavRail.vue` 做"顶栏总览 5 个 project 的 issue 数"  
❌ **不要**让用户能"多选 project"再进 BoardView  
❌ **不要**在 IPC 端点签名里加 `projectIds: string[]`（必须是 `projectId: string`）

## 验证

- `git grep -nE "projectIds|allProjects|fetchAll|跨仓库" src/` 应**零**匹配
- `git grep -nE "currentProjectId" src/renderer/views/` 应**全部** 5 view 都引用一次
- 新增 view 默认模板**必须**显式声明 `const activeProjectId = computed(() => repo.currentProjectId)`，**禁止** "我直接拉所有"
