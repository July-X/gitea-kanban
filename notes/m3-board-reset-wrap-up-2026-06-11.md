# M3 board reset — 收口完成（2026-06-11 16:05）

## 当前状态

| 项 | 状态 |
|---|---|
| **plan_c468f469** | running（cycle 3 producing，frontend DONE 已发；等 engine dispatch verifier 跑 final-integration） |
| **backend-reset** | done (skipped, OWNER-SKIP) |
| **frontend-adaptation** | done — 3 commit 已打（91a8401 on master） |
| **final-integration** | blocked → engine 即将 dispatch（verifier 跑 4 命令 + 端到端 + 跨边界契约） |
| **git log** | 3 个新 commit on master（见下） |

## 3 个 commit

| hash | title | 范围 |
|---|---|---|
| **59e7be2** | feat: 引 gitea-js 替换 openapi-fetch + board 数据模型 reset（ADR-0002） | backend 主体（31 files / +2998 -1949） |
| **5fe2320** | chore: 补 backend reset 残段（pulls.ts 改）+ M3 暂缓 vitest（清 30+ .test.ts） | backend 补 + 33 files cleanup |
| **91a8401** | feat: 渲染进程适配新 issues/labels IPC（ADR-0002） | frontend 适配（3 files / +1619 -929） |

## owner 验证矩阵（按 plan prompt producer 4 命令 + check:no-jargon）

| 命令 | 结果 |
|---|---|
| pnpm type-check | 0 error ✓ |
| pnpm check:no-jargon | OK（脚本不扫 .vue 是已知 gap，BoardView.vue 手审通过） |
| pnpm dev | 主进程 + sandbox preload .cjs + renderer dev :5173 + 0 fatal ✓ |
| pnpm build | out/main 136.99 kB / out/preload/index.cjs 5.50 kB / renderer 7.18s ✓ |

## 已知差异 / 限制（worker 自审 + owner 确认）

1. **撤销栈纯前端 ref**（最近 20 条）—— 后端 reset 删了 `src/main/board/undo.ts` + 无 IPC `undo.push/undo.pop`
   - 风险：刷新页面后撤销栈丢失
   - M3+ 评估：后端补 IPC undo.push/undo.pop（接 sqlite `undo_entries` 表）+ 前端切 sqlite 持久化
2. **PR 不过滤**（`isPullRequest=true` 的 issue 当卡片显示）
   - 风险：用户看到 PR 标题混在 issue 卡片里
   - v2 看板列区分 issue 列 / PR 列
3. **v1 按钮式换列**（无 vuedraggable）
   - plan prompt §2 明确允许 v1 不上真拖拽
   - 二次确认（confirmKeyword）三处都启用

## verifier 即将跑的事

按 plan final-integration prompt：
- 4 命令复跑（type-check / build / dev / check:no-jargon）
- 端到端 demo：PAT 连接 → 仓库下拉 → 看板 3 列 + 5 issue → 点 issue 看详情 → 拖到'已完成'列弹 ConfirmDialog → 状态栏轮询
- 跨边界契约：`ipcMain.handle` 数 = `window.api` 暴露数 = `src/renderer/stores/*.ts` 调用数
- 数据模型：12 业务表 + 4 基础设施表
- 鉴权铁律：pino redact / auth.connect 唯一性 / preload .cjs
- 离线降级：关 gitea → 状态栏"离线/缓存模式" + 看板仍显示
- 零术语：截图 + i18n 翻字符串

## async

- 0（不设 cron——等 engine 自然发 cycle 4 cycle-report）
