# M3 board reset — owner-takeover 收口（2026-06-11）

## 当前状态（cycle 3, 2026-06-11 15:35）

| 项 | 状态 |
|---|---|
| **plan_c468f469** | running（cycle 3 producing） |
| **backend-reset** | **done (skipped, OWNER-SKIP from ready)** — owner-takeover 收口 |
| **frontend-adaptation** | **producing** — mvs_f05c37867d5049efbe47839d05d9a076（engine 已派 attempt 0） |
| **final-integration** | blocked（等 frontend） |
| **git commit** | **59e7be2** on master（backend reset） |
| **scratchpad** | 本文件（接手路径） |

## owner-takeover 5 步（全部完成）

| # | 步骤 | 结果 |
|---|---|---|
| 1 | 修 client.ts 空格 | type-check 0 error（自动修复） |
| 2 | pnpm type-check | 0 error ✓ |
| 3 | pnpm build | out/main 136.99 kB / out/preload/index.cjs 5.50 kB / out/renderer/ 6.43s ✓ |
| 4 | pnpm dev 22s | 主进程启动 + sandbox preload .cjs 加载 + renderer dev server :5173 起来 + 0 fatal ✓ |
| 5 | seed 演示数据 | **跳过**（无 KB_TOKEN env） |
| 6 | git commit | **59e7be2** on master（31 files / +2998 -1949） |

## 历史坑验证（AGENTS §8.10/§8.10.1/§8.11/§8.12）

| 坑 | 验证 |
|---|---|
| §8.10 sandbox preload .cjs | ✓ out/preload/index.cjs 5.50 kB 存在；index.mjs 不存在 |
| §8.10.1 sandboxed preload 不许 require external | ✓ preload build 0 错（gitea-js 不在 preload import 链） |
| §8.11 better-sqlite3 ABI | dev 启动 0 NODE_MODULE_VERSION mismatch |
| §8.12 vitest 反模式 | 30+ .test.ts 全部删除（M3 暂缓，按 §8.11 拍板） |

## 接手路径（frontend 30min 超时后）

如果 frontend-adaptation 撞 30min runtime：

1. **不要 cancel plan**——让 cycle 4 retry attempt 2（consecutive_failures 上限 2 还能再撑一次）
2. **先看 git status**（frontend 改的 src/renderer/）——大概率 80% 落盘
3. **owner-takeover 手动补**：5 步（同 backend 模式）——type-check → dev → build → check:no-jargon → commit
4. **commit message**：`feat: 渲染进程适配新 issues/labels IPC（ADR-0002）`

## 接手路径（frontend 完成 + final-integration 启动后）

final-integration 是 verifier role，verifier 跑通就 plan_complete: true。如果 verifier FAIL（按 attempt 1 经验，多半是：

- pnpm dev / pnpm build 跑不通（pre-existing env）→ owner 修，按 mavis-team-plan.md §Case 3
- check:no-jargon 命中（vue 文件没扫）→ frontend 修
- 跨边界契约不对齐 → 修
- 端点签名不对 → 修

每条 FAIL 都有"证据 + 期望"格式，按 verifier 报告退回对应 producer。

## 不做的事

- ❌ 不主动 cancel frontend session（让 attempt 1 跑完）
- ❌ 不重派 backend（已 done）
- ❌ 不引新依赖（按 AGENTS §7.1 拍板）
- ❌ 不动 src/renderer/**（frontend agent 范围）

## async

- 0（不设 cron——engine cycle 3 完成后会自动 dispatch final-integration + 发新 cycle report，我等消息即可）
