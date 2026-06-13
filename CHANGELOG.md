# Changelog

gitea-kanban 阶段性交付记录。所有变更以 milestone (M0-M7+) 为粒度。

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

## 已知遗留（M7 末状态）

| 类别 | 项 | 状态 |
|---|---|---|
| v1 不做 | `cache/commits.ts` linkedCards 永远返空 | M4 §7.1 需拍板（v1 stub 留） |
| v1 不做 | `gitea/labels.ts` labels.delete 端点 | M4 §7.2 已拍（v1 跳过，UI 跳 gitea） |
| env | `better-sqlite3` ABI 切换 | M7 自动化（e2e:all） |
| e2e | W1-W4 全跑通 | M7 ✅ |
| CI | `.github/workflows/e2e.yml` | M8 候选（§5 M7 文档建议） |
| 文档 | README 安装/启动/排错完整化 | M8 候选 |
| 文档 | CHANGELOG.md（本文件） | M7 ✅ |
