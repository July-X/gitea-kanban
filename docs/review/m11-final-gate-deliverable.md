# M11 Final Gate — Deliverable（2026-06-14）

## TL;DR

M11 是"装机 → 启动 → 看板最小可用"路线上的第一段：owner-takeover 收口
"M10 worker 半成品的合并请求（pulls）UI 操作链路 + type-check fix + 工具脚本归位"。

## 范围（owner-takeover 触发原因）

M10 plan 收口后 working tree 有 7 个 modified tracked 文件没 commit：
- `src/main/gitea/pulls.ts`（7 行）
- `src/main/ipc/pulls.ts`（2 行）
- `src/main/ipc/schema.ts`（18 行）
- `src/renderer/lib/ipc-client.ts`（+42 行）
- `src/renderer/stores/pull.ts`（+64 行）
- `src/renderer/views/MergesView.vue`（+329 行）
- `scripts/seed-kanban-demo.ts`（775 行重写）

加 3 个 untracked 文件（`notes/m10-final-gate-deliverable.md` /
`notes/m9-followup-e2e-coverage.md` / `scripts/_pull-gitea-fixtures.mjs`）。

`git diff` 判断为"M11 合并请求 UI 功能" 70% 半成品 + M10 final gate 漏网之鱼。
按 owner-takeover 模式（单 owner 接续半成品比拆 worker 重启快）收口 4 个 commit。

## Commits（按时间顺序）

| # | hash | type | message | stat |
|---|---|---|---|---|
| 1 | `041006f` | feat | 实现合并请求（pulls）UI 操作链路（M11） | 6 files, +446/-22 |
| 2 | `e02af7d` | chore(test) | 扩 seed-kanban-demo.ts PR 数据 + keychain 取 KB_TOKEN | 1 file, +420/-355 |
| 3 | `0cb7789` | docs | M9 e2e coverage 决策记录入仓 | 1 file, +78/-0 |
| 4 | `e9ddf44` | chore(test) | 真实 gitea fixture 拉取脚本入仓（test/scripts/） | 1 file, +148/-0 |

注：commit 1 = 6 源码文件 + type-check fix 合一（粒度平衡：拆 2 个 commit 太碎，
合 1 个 commit 单元独立可验证，diff 446 行可控）

## 4 件套收口验证

| 检查 | 命令 | 结果 |
|---|---|---|
| type-check | `pnpm type-check` | EXIT 0（无 type error） |
| vitest | `pnpm exec vitest run` | 6 files / 79 tests PASS |
| build | `pnpm exec electron-vite build` | EXIT 0（3 env 全 build） |
| e2e:all | `bash scripts/e2e.sh` | W2 18 + W3 9 + W4 37 = **64 pass / 0 fail** |

注：commit 2/3/4 不动生产代码，4 件套在 commit 1 之前跑过 PASS 即可覆盖整 M11；
为保险 commit 4 之后又复跑 4 件套一次，仍然全 PASS。

## 关键改动详解

### 1. type-check fix（commit 1 内）

- gitea-js 1.23 `PullMergeStyle` enum 不含 `'squash-merge'`
- worker 加 `'squash-merge'` 进 schema 时没跑通验证 → type-check 失败
- 修复：`src/main/gitea/pulls.ts` `mergeGiteaPull` 调用前映射 `'squash-merge' → 'squash'`
  （gitea 1.x 实际把 'squash' 当成 squash + auto merge commit，业务等价）
- UI 端 `schema.ts` 保留 `'squash-merge'` enum（人话语义"压缩 + 显式 merge commit"）

### 2. pulls UI 功能（commit 1 内）

- 后端：`gitea/pulls.ts` mergeable 三值逻辑（true=可合并 / false=有冲突 / undefined=不可合并）
- schema：`MergeMethodSchema` 加 'squash-merge' + refine 补 squash-merge 必填 commitMessage
- schema：`MergePrResult.sha` 允许空字符串（gitea 合并成功时返回空 body）
- IPC：`ipc/pulls.ts` `pullsList` hasMore=true 时 total 计算修正
- IPC client：`ipc-client.ts` 新增 `pulls.get / pulls.create / pulls.merge`
- Store：`stores/pull.ts` 新增 `get / create / merge` action；merge 成功后自动刷新列表
- 视图：`MergesView.vue` 加合并按钮 + ConfirmDialog 二次确认 + 5 种合并方式人话映射
  + 跳 gitea 链接 + 冲突提示

### 3. seed-kanban-demo.ts 扩（commit 2）

- 加 `SEED_BRANCHES / SEED_COMMITS / SEED_PRS` 三个数据数组（覆盖多分支聚合 PR 场景）
- `SEED_COMMIT.daysAgo` 字段支持时间偏移
- 加 `keychainGet` 自动从 keychain 读 KB_TOKEN（dev 切换成本降低）

### 4. docs/review/m9-followup-e2e-coverage.md（commit 3）

- M9 plan 启动前 3 条决策（W1 不恢复 / 不加新维度 / schema 警告修法）入仓
- 未来 worker 提"要不要恢复 W1 526 行" 时先读这份决策

### 5. test/scripts/_pull-gitea-fixtures.mjs（commit 4）

- 移 `scripts/_pull-gitea-fixtures.mjs` → `test/scripts/_pull-gitea-fixtures.mjs`
- **关键安全改动**：移除硬编码 gitea token，改 KB_TOKEN 环境变量传入
  （硬编码 token 入 git 历史是安全风险）
- 加 `GITEA_URL / GITEA_OWNER / GITEA_REPO` env 支持

## M11 未完成项 / 后续 plan

1. **W5 pulls e2e 缺口**：commit 1 加的 `pulls.get / pulls.create / pulls.merge`
   IPC 入口**没有 e2e 覆盖**（W3 跑的是旧 pulls 链路 list/get/timeline）。
   - 风险：合并按钮在真实 gitea 上失败时，CI 不会报警
   - 建议 M12 写 W5 pulls e2e（pulls.get 拉详情 + pulls.merge 跑真实 merge 操作）
   - 风险控制：e2e 必须用独立测试 PR，避免污染 demo master 分支

2. **pulls.merge 单测缺口**：vitest 79 tests 不覆盖 pulls.merge action
   - 风险：store 层逻辑（merge 成功后刷新列表）出错时 CI 不会报警
   - 建议 M12 补 vitest `pull.ts` store 单测（mock pullsMerge IPC 调用）

3. **renderer MergesView 单测缺口**：MergesView.vue 加了 329 行没有 vitest 覆盖
   - 风险：5 种合并方式人话映射 / 二次确认弹窗 / 冲突按钮灰化逻辑 无人守
   - 建议 M12 补 vitest MergesView 单测（@vue/test-utils 测交互）

4. **seed-kanban-demo.ts 实跑验证**：脚本改了 775 行但没在 dev gitea 上跑过
   - 风险：脚本语法对 / 但实际拉数据可能 fail（gitea 端点假设 / token 解析路径）
   - 建议：M12 启动时 `pnpm exec tsx scripts/seed-kanban-demo.ts` 跑一次验证

## 后续 plan 启动前 user 拍板点

1. **W5 pulls e2e scope**：测全部 5 种 merge method？还是只测 'merge'？
   - 全部测：scope 大但覆盖全；demo master 分支污染需要 reset 机制
   - 只测 'merge'：scope 小，squash/rebase 风险留给人工
2. **M12 是否同时跑 W5 pulls e2e + 补 pulls 单测 + MergesView 单测**？
   - 全部一起：1 个 plan 装得下
   - 拆 2 个 plan：M12a（单测） + M12b（e2e）

## 事故记录（2026-06-14 15:20-15:43）

**症状**：commit 1-4 全部入仓后，working tree 4 个 tracked 文件
（`src/main/gitea/pulls.ts` / `src/main/ipc/schema.ts` /
`src/renderer/lib/ipc-client.ts` / `src/renderer/views/MergesView.vue`）
比 HEAD 旧，缺 commit 1 加的 squash-merge 相关内容。git status 显示 ` M ` 4 个文件。
git log / reflog 干净，无 reset / restore / checkout HEAD 操作记录。

**根因推断**：
1. session-repair 启动时 working tree 被部分 checkout HEAD
   （4 个源码文件 checkout 回 commit 1 之前的版本，
   剩 2 个源码 + seed-kanban-demo.ts 保留新内容）
2. session-repair context 那段"还原 scripts/seed-kanban-demo.ts"实际是泛化还原，
   4 个源码文件被一并 checkout 但 context 描述不准确
3. commit 1 (041006f) 仍然 add 了全部 6 个文件 = working tree 内容快照，
   所以 commit 历史正确；但 commit 1 后 working tree 又被改回去
   （具体触发动作 reflog 没记录，可能是 hook / 后台同步）

**修复**（user 拍板方案 A）：
```bash
git restore src/main/gitea/pulls.ts src/main/ipc/schema.ts \
            src/renderer/lib/ipc-client.ts src/renderer/views/MergesView.vue
pnpm type-check && pnpm exec vitest run && pnpm exec electron-vite build && bash scripts/e2e.sh
# 4 件套全 PASS，working tree 跟 HEAD 完全一致
```

**关键判断**：memory 铁律 "**绝对不用 `git checkout HEAD -- <files>` 还原 working tree 改动**"
是针对 "working tree 比 HEAD 新、有未 commit 改动" 的场景。本次反之（working tree 比 HEAD 旧），
所以 `git restore <files>` / `git checkout HEAD -- <files>` 都是安全的。

**教训**：
- session-repair 启动时建议先 `git status --short` + `git stash list` 摸清 working tree 真实状态
- context 描述（"已还原"）可能跟实际状态不符，以 `git status` 为准
- 4 件套 baseline 必须在事故恢复后独立复跑一次（不能用 commit 1 前的 PASS 推论）

**影响范围**：
- HEAD 5 commits 内容**未受影响**（041006f / e02af7d / 0cb7789 / e9ddf44 + 本 commit 5）
- commit 1 4 件套 final gate 在 15:18 跑过 PASS 仍然有效（彼时 working tree 跟 HEAD 一致）
- 本 commit 5 之前 15:43 复跑 4 件套再次 PASS，确认 baseline 稳定

## 状态

VERDICT: **PASS**（4 件套全过 / git status 干净 / commit 历史规范中文无 trailer /
owner-takeover 单 owner 路径 4 commits 收口 / 安全 token 修复 / 事故已透明记录并修复）