# Changelog

gitea-kanban 阶段性交付记录。所有变更以 milestone (M0-M11+) 为粒度。

## M11 — 合并请求（pulls）UI 操作链路 (2026-06-14)

**核心变更**：
- **合并请求 UI 全链路**：在桌面端完成 PR 列表 / 详情 / 操作（关闭 / 编辑标签 / 指派人 / 评审人 / 合并）
- **3 种合并方式**（普通 / 变基 / 压缩）+ 各自 hover 解释 + 默认隐藏高级合并方式
- **冲突检测 + 跳 gitea 处理**：UI 层检测到 `merge_conflict` 状态给清晰跳转入口
- **新视图 `MergesView`**：手风琴展开布局（2 列定宽 grid，窄屏 1 列）+ 修复多 PR 列表被 flex 压缩到 6px
- **3 个 dev/test 工具脚本**入仓：
  - `scripts/seed-pr-fixtures.mjs`：5+1 种 PR 类型（待合并 / 冲突 / 已合并 / 草稿 / 关闭 / 自冲突）灌 demo
  - `scripts/reset-gitea-demo.ts`：demo 仓库一键 reset（M11 follow-up）
  - 扩 `scripts/seed-kanban-demo.ts`：PR/branch/commit 数据 + 自动从 keychain 取 `KB_TOKEN`
- **真实 gitea 1.x fixture** 10 个端点入仓（`src/main/ipc/__tests__/fixtures/`）—— M10-task-2 沉淀
- **M11 final gate VERDICT = PARTIAL**（commit `90645b9`）：reset 已做 + API 限制透明（M11 收口报告 `docs/review/m11-final-gate-deliverable.md`）

**关键文件**：
- `src/main/gitea/pulls.ts`（`mergeGiteaPull` 把 UI 端 `'squash-merge'` 映射成 gitea `'squash'`）
- `src/main/ipc/pulls.ts` + `src/main/ipc/schema.ts`（pulls.* 8 端点 + Zod schema）
- `src/renderer/lib/ipc-client.ts`（pullsList / pullsGet / pullsMerge helper）
- `src/renderer/stores/pull.ts`（+64 行，pulls 状态 + 操作 action）
- `src/renderer/views/MergesView.vue`（+329 行）
- `src/renderer/views/MyCardsView.vue` / `BoardView.vue`（合并方式选择器接入）
- `scripts/seed-pr-fixtures.mjs`（新增，5+1 PR 类型 seed）
- `scripts/reset-gitea-demo.ts`（新增，demo 仓库 reset）
- `src/main/ipc/__tests__/fixtures/*.json`（10 个端点 raw gitea 1.x 响应）

**交付文档**：
- `docs/review/m11-final-gate-deliverable.md`（含事故透明记录 + 后续 plan 建议）
- `notes/m10-a3-deliverable.md`（M10 schema 完整性 roundtrip 诊断）

---

## M10 — schema 完整性 roundtrip 真实 fixture 验证 (2026-06-14)

**核心变更**：
- **10 端点 × 真实 gitea 1.x 响应 roundtrip**：拉 `localhost:3000` 真实响应 → Zod schema parse → 漏字段 / 类型不匹配诊断
- 覆盖：`PullDtoSchema` / `IssueDtoSchema` / `RepoDtoSchema` / `BranchDtoSchema` / `LabelDtoSchema` / `CommitDtoSchema` / `CollaboratorDtoSchema`（单 + 列表）
- **诊断结论**：所有 schema 与 gitea 1.x 实测响应**完全对齐**（无漏字段 / 无类型不匹配）
- 真实 fixture 入仓（`src/main/ipc/__tests__/fixtures/`），后续单测可复跑

**关键文件**：
- `src/main/ipc/__tests__/fixtures/{giteaPullList,giteaPullSingle,giteaIssueList,giteaIssueSingle,giteaRepo,giteaBranchList,giteaLabelList,giteaCollaborators,giteaCommitList,giteaCommitSingle}.json`
- `scripts/_pull-gitea-fixtures.mjs`（ad-hoc 工具，**不**入仓）

**交付文档**：`notes/m10-a3-deliverable.md`

---

## M9 — e2e coverage 重新规划 + composable 抽 + schema 守 M5 fix-1 (2026-06-14)

**核心变更**：
- **e2e coverage 决策**（入仓 `docs/review/m9-followup-e2e-coverage.md`）：
  - W1 脚本**永不恢复**（M7 有意识删的 526 行，恢复 = 回退 refactor）
  - 不加新 e2e 维度（W1 旧覆盖范围已散在 W2/W3/W4 中）
  - schema 警告修法：B 方案（M10+ 再修）→ M10 实际通过 roundtrip 一次性修完
- **抽 `useBranchLoadDebounce` composable**（TimelineView 防抖逻辑提到独立文件，可单测）
- **`PullDtoSchema` / `TimelineDtoSchema` vitest 单测**：守 M5 fix-1（IsoDateSchema 接受 `+08:00` offset）
- **`cache/timeline` 分支级 commits 缓存 vitest 单测**：写后 30s 内命中 / 30s+ 失效 / invalidate / projectId 隔离 / 序列化稳定
- 修 e2e `knownIssueCheck` helper 计数语义（schema parse 成功归 pass）
- 删 W3 e2e §[Z1-Z4] 死代码（M5+M9 真修后已无意义）
- 修 `scripts/e2e.sh` W1 死引用（M8 收口前漏清理的 1 行 run_one + 2 行注释）

**关键文件**：
- `src/renderer/composables/useBranchLoadDebounce.ts`（新增，从 TimelineView 抽出）
- `src/renderer/views/TimelineView.vue`（接入 composable）
- `src/main/ipc/__tests__/pull-schema.test.ts`（PullDtoSchema 单测）
- `src/main/ipc/__tests__/timeline-schema.test.ts`（TimelineDtoSchema 单测）
- `src/main/cache/__tests__/timeline.test.ts`（分支级 commits 缓存，13 个 case）
- `scripts/e2e.sh`（W1 死引用清理）

**交付文档**：
- `docs/review/m9-followup-e2e-coverage.md`（W1 决策 + 3 条 owner 拍板点）
- `notes/m9-followup-e2e-coverage.md`（M9 plan 启动前的 3 条决策点原始记录）

---

## M8 — TimelineView 完整恢复 + CI workflow + README + branches.* 移除 (2026-06-13)

**核心变更**：
- **TimelineView 完整恢复**（commit `c1bd4eb`）：lane 色 / 分支 chip / meta 紧凑 / heatmap / 弹窗 footer / 复制按钮 / in-gitea 按钮 hover 全部就位
- **移除 `branches.*` 独立链**（`c738975` + `d2ea3a6` + `6f0e38e`）：删 BranchesView.vue / useBranchStore / 路由 /branches / NavRail "分支" 条目 + 5 个 IPC 端点 + Zod schema + preload branches namespace + main/ipc/branches.ts + main/cache/branches.ts + main/gitea/branches.ts + starredBranches schema
- **时间轴分支切换防抖 + 分支级 commits 缓存**：400ms 防抖避免频繁切换；`cache/timeline` 按 `<projectId, selectedBranches>` 隔离 key
- **CDP 性能测试手册**（`docs/dev/cdp-performance-testing.md`）：Electron CDP 端口 9492 + puppeteer-core 自动化方案
- **3 个工具脚本**入仓：
  - `scripts/cdp-capture-views.mjs`（C-2 截图采集：7 view × 3 尺寸 = 21 张）
  - `scripts/cdp-seed-timeline-data.mjs`（Gitea 注入测试分支）
  - `scripts/_pull-gitea-fixtures.mjs`（拉真实 gitea 响应，ad-hoc）
- **GitHub Actions e2e workflow**（`.github/workflows/e2e.yml`）：macos-14 runner + pnpm 10 + node 20 + `KB_TOKEN` from secrets
- **仓库根 README.md** 面向非技术用户（PM / 设计师 / 市场 / 运营）：安装 / 启动 / 接入 Gitea / 打包 / e2e / 常见问题 8 章节，零术语
- **.gitignore 收敛**：`notes/cap_*.png`（时间轴视觉调参草稿）+ `scripts/.e2e-verify-*.bundled.mjs`（e2e bundle 临时产物）
- **弹窗头部图标按钮改 Tooltip 取代原生 title**（轻量自研 Tooltip 组件，a11y 友好）
- **提交详情弹窗**动作按钮上移至 head 区 + 移除 footer + 加复制版本号按钮

**关键文件**：
- `src/renderer/views/TimelineView.vue`（完整恢复 + 接入 composable）
- `src/renderer/composables/useBranchLoadDebounce.ts`（M9 抽，M8 先在 TimelineView 内联实现）
- `src/main/cache/timeline.ts`（分支级 commits 缓存 + invalidate）
- `.github/workflows/e2e.yml`（新增，macos-14 + pnpm 10 + node 20）
- `README.md`（新增，~150 行，仓库根非 giteaDemo/）
- `scripts/cdp-capture-views.mjs`（新增，~200 行 CDP 截图工具）
- `scripts/cdp-seed-timeline-data.mjs`（新增，CDP 注入测试分支）
- `docs/dev/cdp-performance-testing.md`（新增，Kimi 写的 CDP 性能手册）
- `src/renderer/components/Tooltip.vue`（新增，轻量自研）
- `src/main/ipc/branches.ts` + 上下游（**删除**）

**M8 final gate**：`plan_4fcfd20b` status=completed，commit `73ab246` 收口。

**交付文档**：
- `notes/m8-cdp-*.md`（Kimi 性能分析）
- `notes/m7-e2e-ci-deliverable.md`（M7 末状态参考，M8 收口前的基线）

---

## ADR-0003 — 本地存储迁移：better-sqlite3 → electron-store + 同步队列（2026-06-14，3 phase 滚动）

**背景**：`docs/adr/0003-local-store-electron-store.md` Accepted

**已落地**：
- **Phase 1 双写**（commit `8ffa951`）：业务层 `Promise.allSettled([sqliteWrite, localStoreWrite])` 写两边；新增 `src/main/local/store.ts`（LocalStore 抽象 50 行）+ `src/main/local/state.ts` + `src/main/local/prefs-mirror.ts`；加 `scripts/verify-state-consistency.ts` 启动期巡检
- **Phase 2 切读路径**（commit `15c24ba`）：5 个业务接口 `accounts.ts` / `projects.ts` / `columns.ts` / `label-maps.ts` / `starred-branches.ts`；启动期全表 bootstrap（SQLite → localStore 一次迁移）
- **Phase 2 单测**（commit `c950445`）：`localStore` 业务接口 vitest + 注释同步

**待落地**：
- **Phase 3 删 SQLite + 上同步队列**（计划中）：删 `better-sqlite3` / `drizzle-orm` / 14 张表 / 9 个 query 文件；加 `src/main/sync/runner.ts`（200 行）+ `queue.jsonl` 序列化；`PreferencesView` 加"待处理项"面板

**包体净减**：约 200+ MB（删 better-sqlite3 + drizzle + 7 个 @napi-rs native 包；加 electron-store ~52 KB gzipped）
**零 ABI 风险**：纯 JS，Electron 大版本升级不用 rebuild

---

## M7 — e2e 补齐 + CI 收口 (2026-06-13)

**核心变更**：
- W1/W2/W3/W4 4 个 e2e 全跑通，**79 pass / 0 fail**（W1:15, W2:18, W3:9, W4:37）
- 修 `src/main/cache/sqlite.ts` ESM bug：top-level `require('node:fs')` → ESM named imports
- 新增 `scripts/e2e.sh` 自动 ABI 切换（node 25 ↔ electron 41.7.2）
- package.json 加 5 个 e2e 脚本：`e2e:w1` / `e2e:w2` / `e2e:w3` / `e2e:w4` / `e2e:all`
- W1 .sh 薄壳化：esbuild bundle 死路径 → 调 M6 `_e2e-runner.mjs`
- 验证 M6 4-件套（shim/resolver/loader/runner）**通用**（4 个 e2e 全跑通）
- 验证 M5/m6 改动**无回归**（W3 复测 9/0）

**关键文件**：
- `src/main/cache/sqlite.ts:11-19, 62-74`（ESM 化）
- `scripts/e2e.sh`（新增，~80 行 bash）
- `package.json`（5 个 e2e 脚本）
- `scripts/e2e-verify-w1.sh`（薄壳化）

**交付文档**：`notes/m7-e2e-ci-deliverable.md`

---

## M6 — 收口 / 真栈 / W3 e2e 复测 (2026-06-13)

**核心变更**：
- **undo/redo 真栈落地**：handler 注册表 + in-memory 栈 + bound 20
- **undo/redo 按 projectId 弹栈**：跨看板不互撤 + undoStatus IPC 端点（防误撤）
- **W3 e2e 复测全过**：M5 fix-1 IsoDateSchema offset ripple 修复（Z1-Z3 意外通过 = schema 已对齐 gitea `+08:00` 时间戳）
- **M5 FU3 405 case**：pulls.merge 幂等保护（合并请求已合并 → 中文文案"操作冲突：资源状态不允许该操作"）
- **M5 FU1 文档计数同步**：IPC 端点 39→44→45
- **prefs schema 拍板保留设备级**（A 方案：3 处注释同步，**不**动 schema）
- **4-件套 ESM shim**：`_e2e-runner.mjs` + `_e2e-loader.mjs` + `_electron-shim-resolver.mjs` + `_electron-shim.mjs`（让 node 25 ESM 跑 e2e 脚本）
- **2 主题收口**：3 主题（dark/light/sepia）→ 2 主题（dark/light）+ gitea 绿主色提亮过 AA
- **dev 模式数据来源注解 + popover**（生产零侵入）
- **时间轴**：
  - 重写 TimelineView 接入 wireframe（heatmap + 8-lane 分支图）
  - 移除 X6 CommitNode.vue，分支图改 inline SVG
  - commit-row 点击弹详情对话框 + 3 个动作
  - 5 个分支色 token（purple/teal/amber/pink/lime）
  - 修 CSP hash（heatmap 注入脚本冲突）+ defaultBranch backfill

**关键文件**：
- `src/main/board/undo.ts`（注册表 + 栈管理）
- `src/main/board/move-card.ts`（handler 注册）
- `src/main/ipc/user.ts`（undo/redo/undoStatus 端点）
- `src/main/ipc/schema.ts`（UserUndoArgsSchema 等）
- `src/shared/ipc-channels.ts`（`user.undoStatus` 新增）
- `src/renderer/stores/board.ts`（删本地 undoStack ref）
- `src/renderer/views/BoardView.vue`（redo 按钮 + watch projectId）
- `scripts/_e2e-runner.mjs` + 3 个 e2e shim
- `src/main/cache/sqlite.ts`（`seedLocalUser` 注释）
- 主题 tokens 收敛

**交付文档**：
- `notes/m6-undo-redo-deliverable.md`
- `notes/m6-undo-by-project-deliverable.md`
- `notes/m6-prefs-schema-decision.md`
- `notes/m6-w3-e2e-deliverable.md`
- `notes/m6-fu-405-deliverable.md`
- `notes/m6-fu-audit-deliverable.md`
- `notes/m6-fu-doc-count-deliverable.md`
- `notes/m6-m2-redirect-deliverable.md`
- `notes/theme-check-deliverable.md`
- `notes/timeline-csp-defaultbranch-diagnose-deliverable.md`

---

## M5 — fix1/2/3 (2026-06-12)

**核心变更**：
- **fix1**：IsoDateSchema 接受 `+08:00` 偏移时间戳（M5 W3 5b 暴露的 schema bug）
- **fix2**：Gitea client 错误路径清理
- **fix3**：prefs IPC 端点落地（A 拍板后实际实现，commit M5 fix-3）

**关键文件**：
- `src/shared/ipc-types.ts`（IsoDateSchema offset）
- `src/main/gitea/client.ts`（错误路径）
- `src/main/ipc/user.ts`（prefs 端点）

**交付文档**：
- `notes/m5-fix1-deliverable.md`
- `notes/m5-fix2-deliverable.md`
- `notes/m5-fix3-deliverable.md`
- `notes/m5-fix-final-deliverable.md`（含 §6 follow-ups）

---

## M4 — 4 块 IPC 端点 + 看板/issue/labels (2026-06-11)

**核心变更**：
- 4 块 IPC 端点全打：repos.* / branches.* / commits.* / pulls.*
- 看板列（本地 SQLite 实体）：create/update/reorder/delete/mapLabel/unmapLabel
- issues.* 9 端点：list/get/create/update/addLabel/removeLabel/moveColumn/comment.list/comment.create
- labels.* 2 端点：list/create
- 4 e2e 脚本：W1（repos/branches/commits）+ W2（board/issue/labels）+ W3（pulls/timeline）+ W4（auth/prefs）
- commits.timeline 跨分支聚合（listGiteaCommits + listGiteaPulls + buildTimeline）

**已知限制（v1 不做）**：
- `cache/commits.ts` linkedCards 永远返空（v1 stub，无 cards 表）
- `gitea/labels.ts` 不实现 labels.delete（v1 跳过，UI 跳 gitea）
- `better-sqlite3` ABI 切换需手动（env, not code）

**关键文件**：
- `src/main/board/columns.ts`
- `src/main/board/move-card.ts`
- `src/main/board/card-from-issues.ts`
- `src/main/gitea/{repos,branches,commits,pulls,issues,labels,timeline}.ts`
- `src/main/cache/{repos,branches,commits,timeline}.ts`
- `scripts/e2e-verify-w{1,2,3,4}.ts`

**交付文档**：
- `notes/m4-final-integration-deliverable.md`（含 §7 known-bug / non-blocker）
- `notes/m4-w1-deliverable.md`
- `notes/m4-w3-deliverable.md`

---

## M3 — scope 拍板

- 鉴权方式：PAT（Personal Access Token）落 keychain（**不**做 OAuth2）
- IPC 契约：以 `<namespace>.<method>` 命名（如 `repos.list`、`auth.connect`）
- 不依赖 Gitea projects REST API（v1 跳过）
- 看板列 = 本地 SQLite 实体；卡片 ↔ 列关联 = label 映射

---

## M2 — preload 桥 + Vue 3 壳 (2026-06-09)

**核心变更**：
- `src/preload/index.ts` 暴露 `window.api`（45 端点）
- Vue 3 + Vite + Pinia + Vue Router 4 集成
- IPC 端点注册（44 个 namespace.method）
- electron-vite 5 脚手架
- 安全默认值：contextIsolation/sandbox/nodeIntegration 三件套
- m2 e2e + smoke 脚本

**关键文件**：
- `src/preload/index.ts`
- `src/renderer/main.ts` + `App.vue`
- `src/renderer/router/index.ts`
- `src/renderer/stores/*.ts`

**交付文档**：
- `notes/m2-preload-bridge-deliverable.md`
- `notes/m2-vue3-app-shell-deliverable.md`
- `notes/m2-final-integration-report.md`

---

## M1 — Gitea API 集成 (2026-06-08)

**核心变更**：
- `src/main/gitea/` 业务层：auth / client / repos / branches / commits / pulls / issues / labels
- gitea-js ^1.23.0 HTTP 客户端
- 错误统一 IpcError + IpcErrorCode

**关键文件**：
- `src/main/gitea/auth.ts`（authConnect）
- `src/main/gitea/client.ts`（giteaApi 工厂 + clearGiteaClientCache）
- `src/main/gitea/keychain.ts`（@napi-rs/keyring）
- `src/main/gitea/{repos,branches,commits,pulls,issues,labels,timeline}.ts`

**交付文档**：`notes/a1-gitea-api-deliverable.md`

---

## M0 — 脚手架 (2026-06-07)

- electron-vite 5 + electron-builder 26
- TypeScript 5.7 + Vue 3.5
- better-sqlite3 + Drizzle ORM 脚手架
- pino + 日志 redact（token / password / key）
- Radix Vue + @headlessui/vue 集成
- AntV X6 集成（**M6 移除**，改 inline SVG）

---

## 已知遗留（M11 末状态）

| 类别 | 项 | 状态 |
|---|---|---|
| v1 不做 | `cache/commits.ts` linkedCards 永远返空 | M4 §7.1 需拍板（v1 stub 留） |
| v1 不做 | `gitea/labels.ts` labels.delete 端点 | M4 §7.2 已拍（v1 跳过，UI 跳 gitea） |
| env | `better-sqlite3` ABI 切换 | M7 自动化（e2e:all）+ M9-task-1 引入 vitest node ABI 兼容性（`src/main/cache/__tests__/timeline.test.ts` 在 node 下因 binding ABI 不匹配 fail，13 个 case skipped）。**待 ADR-0003 Phase 3 删 better-sqlite3 自动消失** |
| e2e | W1-W4 全跑通 | W1 永不恢复（M9 决策）+ W2/W3/W4 全跑通（M8 收口） |
| CI | `.github/workflows/e2e.yml` | M8 ✅（commit `5128302`，macos-14 + pnpm 10 + node 20） |
| 文档 | README 安装/启动/排错完整化 | M8 ✅（commit `3c2e50d`，仓库根面向非技术用户） |
| 文档 | CHANGELOG.md（本文件） | M11 ✅（本 commit 同步 M8-M11 + ADR-0003） |
| 架构 | ADR-0003 本地存储迁移 | Phase 1+2 已落（`8ffa951` + `15c24ba` + `c950445`），Phase 3 删 SQLite + 同步队列待启动 |
| v1.3 polish | A-3 P4 双击列名重命名 + P5 退出登录二次确认 | v1.2 final-gate 后 polish backlog，等真窗口实测 |
| v1.3 polish | C-3 PR-4 主按钮 box-shadow 统一 + PR-5 SettingsView 150ms → token | v1.2 final-gate 后 polish backlog，等真窗口实测 |
| 路线图 | A-3 B2 看板详情抽屉 + B3 真拖拽换列（M1/M2 架构级） | 留 v1.3+ 路线图，本期不做 |
