# .harness/AGENTS.md — gitea-kanban Agent Team Entry Point

> 本文件是 `.harness/` 目录的入口，供 mavis daemon 在此仓库激活 agent team 时读取。
> 详细的开发规范、角色边界、技术栈在项目根目录的 `AGENTS.md` 中定义——**以根目录 AGENTS.md 为准**。
> 本文件只提供 agent team 级别的快捷索引。

---

## 项目基本信息

|字段 | 值 |
|---|---|
| **项目名** | gitea-kanban |
| **类型** | Electron + TypeScript 桌面应用（Electron + React + X6 + SQLite） |
| **仓库根 AGENTS.md** | `../AGENTS.md`（**必读**） |
| **设计文档** | `../docs/design/00-overview.md`（路线图入口） |
| **架构契约** | `../docs/design/02-architecture.md` |
| **前端设计** | `../docs/design/03-frontend.md` |
| **设计系统** | `../design-system/gitea-kanban/OVERRIDE.md`（single source of truth） |

---

## Agent Roster

| Reins目录 | 角色 | 核心职责 |
|---|---|---|
| `reins/orchestrator/` | Orchestrator（编排） | 拆 plan → 跑 cycle → 决策 NEXT/RETRY/BLOCKED/DONE；**统一 git commit** |
| `reins/backend/` | Backend（主进程） | `src/main/**`、`src/preload/**`、IPC handler、SQLite/Drizzle、gitea 集成 |
| `reins/frontend/` | Frontend（渲染进程） | `src/renderer/**`、React/X6 UI、Zustand store、零术语验证 |
| `reins/verifier/` | Verifier（验证） | 独立验证 plan 产出的客观可验证项；打结构化 FAIL 报告 |

---

## 工作流速查

### git commit 规则（必须遵守）
- **worker agent 不准自己 git commit** —— 所有 commit 由 orchestrator 统一打
- commit message 中文，格式：`<type>: <中文一句话描述>`
- 每个阶段性交付打一次 commit，不攒大 commit

### 危险操作必须经过用户确认
-改技术栈 /改 IPC 契约 / 改数据模型 / 改设计原则 / 改设计系统 token / 里程碑拆解调整
- 以上情况 orchestrator 不准自决，必须推回用户拍板

### 零术语铁律
- UI 文本禁止出现 `PR` / `merge` / `rebase` / `fork` / `repo` / `branch` 等原词
- 必须走翻译表：`PR` →合并请求 / `merge` → 合并 / `rebase` → 变基
- `pnpm check:no-jargon` 验证通过才准 merge

---

## 快速链接

- [项目根 AGENTS.md](../AGENTS.md)
- [设计综述 + 路线图](../docs/design/00-overview.md)
- [架构 + 后端](../docs/design/02-architecture.md)
- [前端设计](../docs/design/03-frontend.md)
- [设计系统 OVERRIDE](../design-system/gitea-kanban/OVERRIDE.md)