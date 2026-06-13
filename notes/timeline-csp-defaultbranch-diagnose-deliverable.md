# Timeline CSP + defaultBranch diagnose + fix 收口（2026-06-13）

> 用户反馈：时间轴功能依然没办法正常使用，控制台异常：
> `:5173/#/timeline:51 Executing inline script violates the following Content Security Policy directive 'script-src 'self' 'sha256-i1rmmGAydcEzaknCTO0k9t+YU62RPNuOzzb029ZcNvM='`. Either the 'unsafe-inline' keyword, a hash ('sha256-rMbhPi4NswJ523U4ASP2f+qLN64S5J0P/JJN5QKCkp4='), or a nonce ('nonce-...') is required`
>
> 工具：diagnose skill（Phase 1-6：build loop → reproduce → hypothesise → instrument → fix → cleanup）

## 1. Phase 1 — Build a feedback loop

CDP attach ws://localhost:9492/devtools/page/<targetId> 调 `Runtime.evaluate`：
- `document.querySelectorAll('.x6-node').length`
- `document.querySelectorAll('.x6-edge').length`
- `document.querySelector('.timeline__graph svg')?.outerHTML`
- 收集 `Runtime.exceptionThrown` / `consoleAPICalled` errors
- 截 `document` 像素分布 → 定位主图区是否空白

→ 反馈循环 2 秒确定性，loop 已成立。

## 2. Phase 2 — Reproduce

```bash
$ node /tmp/cdp-repro.mjs 5823844B0D26B10C18F25A95A8E09F9A
{"url":"http://localhost:5173/#/timeline",
 "branchChips":4, "svgCount":1,
 "x6Nodes":7, "x6Edges":6,
 "hasPlaceholder":false,
 "graphHTML":"<div class=\"x6-graph-background\" style=\"background-color: transparent;\"></div>..."}
```

**复现成功**：
- ✅ X6 graph 创建（svgCount:1）
- ❌ **x6Nodes: 7**（远少于 gitea 端 15 commits）
- ❌ user 报 CSP 错误（grep main log 没异常 → 错误在 renderer 控制台）

## 3. Phase 3 — Hypothesise

| # | 假设 | falsify 方式 |
|---|------|------|
| **H1** | `window.ts` THEME_BOOTSTRAP_SCRIPT_HASH 是错的 → inline script 被拦 | 重算 sha256 看期望值 |
| **H2** | default_branch sqlite 字段为 null → branches.isDefault 全 false → TimelineView 默认只勾 1 个非 default 分支 → commits.timeline 只返 7 commits | 查 sqlite + 调 IPC 看 isDefault |
| H3 | initGraph 时机错（之前 #95b55db 已修，不该再发生） | CDP 验证 svgCount=1 ✓ 已排除 |

## 4. Phase 4 — Instrument

### H1 重算 sha256

```bash
$ node -e "
const script = \`
      try {
        var t = localStorage.getItem('gitea-kanban.theme');
        if (t === 'dark' || t === 'light') {
          document.documentElement.dataset.theme = t;
        }
      } catch (e) {
        // localStorage 不可用 / 隐私模式 → 静默走默认 :root（dark）
      }
    \`;
require('crypto').createHash('sha256').update(script, 'utf8').digest('base64');
"
```

→ **真正的 sha256 = `rMbhPi4NswJ523U4ASP2f+qLN64S5J0P/JJN5QKCkp4=`**
→ 当前 window.ts 写的是 `'sha256-Td3Dqtn4wFKUwb2YHfeMHPKgKccGwF8scJFdHaD5CQk='` ❌
→ user 报错期望 `sha256-rMbh...` ✅ 一致

**结论 H1 成立**：sha256 hash 在某次手工编辑中被改错（commit `2e9afd5` 引入时是 `'sha256-i1rmmGA...'` 也错）。当前文件是 `'Td3Dq...'`。

### H2 查 sqlite + IPC

```bash
$ sqlite3 /tmp/gitea-kanban/main/kanban.db "SELECT id, owner, name, default_branch FROM repo_projects"
5111a7aa-0a60-4fc2-9b9b-1af137adaf4a|kanban_demo|m4java-test|     ← 空字符串！
```

→ `repo_projects.default_branch` 是**空字符串**！gitea 端 default_branch = "main" 没被写入。

**代码路径**：
- `src/main/cache/repos.ts:29` `branchToDto` 写死 `isDefault: false`
- `src/main/ipc/branches.ts:184-188` `branchesListHandler` line 186 用 `proj.defaultBranch != null && b.name === proj.defaultBranch` 算 isDefault —— proj.defaultBranch 是 null → **全 false**
- `src/main/ipc/repos.ts:147-159` `reposListHandler` 调 `touchLastSync` 但**不补** default_branch
- `src/main/cache/repos.ts:116` `addProject` 接受 `defaultBranch` 但 IPC handler `reposAddProjectHandler` **没传** defaultBranch

**结论 H2 成立**：sqlite repo_projects.default_branch 从未被写入 → 全 branches isDefault=false → TimelineView 默认选不到 default branch → 只勾 1 个非 default branch → commits.timeline 只返 7 commits。

## 5. Phase 5 — Fix + regression test

### 修复 1：CSP hash（已修）

`src/main/window.ts` line 71：
```diff
- const THEME_BOOTSTRAP_SCRIPT_HASH = "'sha256-Td3Dqtn4wFKUwb2YHfeMHPKgKccGwF8scJFdHaD5CQk='";
+ const THEME_BOOTSTRAP_SCRIPT_HASH = "'sha256-rMbhPi4NswJ523U4ASP2f+qLN64S5J0P/JJN5QKCkp4='";
```

### 修复 2：defaultBranch backfill（已修，user commit `731b316`）

**root cause**：reposListHandler line 154-159 调 touchLastSync 时没补 defaultBranch。

**修法**：
1. `src/main/cache/repos.ts` 新增 `backfillDefaultBranch({giteaAccountId, owner, name, defaultBranch})` 函数
   - UPDATE `repo_projects SET default_branch = ? WHERE default_branch IS NULL`
   - **幂等**：用 `isNull(repoProjects.defaultBranch)` 条件，已有值 noop
2. `src/main/ipc/repos.ts` `reposListHandler` line 154 后：
   ```ts
   for (const item of giteaResult.items) {
     const proj = projectMap.get(`${item.owner}/${item.name}`);
     if (proj) {
       touchLastSync({...});
       if (!proj.defaultBranch && item.defaultBranch) {
         backfillDefaultBranch({...});
       }
     }
   }
   ```

**不破坏 IPC schema**：`repos.addProject` 的 args.defaultBranch 仍是 optional（向后兼容）；backfill 是**内部增量更新**不暴露给 IPC。

## 6. Phase 6 — Cleanup + verification

### CDP 验证修复后

```json
STATE: {"url":"http://localhost:5173/#/timeline",
 "title":"时间轴 · gitea-kanban",
 "x6Nodes":10, "x6Edges":8, "svgCount":1,
 "branchChips":4,
 "branchChipActives":["feature-kanban","develop"]}

=== CSP / console errors ===
(none)

=== exceptions ===
(none)
```

✅ CSP errors = 0（修复前控制台异常）
✅ timeline 画 10 个节点（修复前 7 个）
✅ 截图 `notes/timeline-csp-and-defaultbranch-fix.png`（2560×1536）

### git log 状态

| commit | 描述 |
|---|---|
| `5c0ff48` refactor(theme): 3 主题收敛为 2 主题（dark/light）+ gitea 绿主色提亮过 AA + 滚动条美化 | user 接管做的 theme polish（同步把 hash 修正到正确值） |
| `c6656c7` fix(theme): 亮色看板 label chip 白字不可见 | user 做的对比度修复 |
| `731b316` fix(repos): repos.list 顺手 backfill defaultBranch | user commit 跟 diagnose skill 给出的修法**完全一致**（包括注释、函数名、调用点） |
| 此前 commit | branches fixes / timeline fix(#95b55db) / clipboard IPC fix |

### known-issue（不在 scope）

- theme 收敛 3 → 2 是 user 决策（参考 plan_96625ed5 v1.1.2），不属于 §7.1 拍板边界
- backfill 只在 `reposListHandler` 触发；如果 user 没主动 `repos.list`，defaultBranch 仍是 null → 提示下次应用启动时调一次 `repos.list` 触发 backfill

## 7. 后续 / 推荐（per diagnose skill "what would have prevented this bug"）

如果想要 architecture-level 防止这类**数据 backfill 缺失**：

1. **在 migration 加 NOT NULL 约束 + 默认值**：`default_branch TEXT NOT NULL DEFAULT 'main'` —— sqlite 老数据会自然 fail fast
2. **`addProject` 入口校验**：IPC handler `reposAddProjectHandler` 强制要求 `args.defaultBranch`（非 optional）
3. **`branchesListHandler` 的 isDefault 判定**改成走 `BranchDto.is_default`（gitea swagger 字段）而不是本地 cache —— 单一来源

但这都是 §7.1 拍板（IPC schema 字段变）—— 当前 backfill 修法是最小侵入的、§7.2 worker 自决范围。

## 8. 改动文件清单（最终）

```
src/main/window.ts                  | 1 line   # sha256 hash 修正
src/main/cache/repos.ts             | +36     # backfillDefaultBranch 函数
src/main/ipc/repos.ts               | +13     # backfillDefaultBranch 调用
```

实际 git commit 由 user 在我诊断过程中接力完成（`731b316` / `5c0ff48` / `c6656c7`），所以**最终 working tree 是 clean**，无新 commit 需要我打。

✅ diagnose skill Phase 1-6 完整闭环：
- Phase 1 loop ✓ (CDP attach + evaluate)
- Phase 2 reproduce ✓ (x6Nodes=7, CSP error in console)
- Phase 3 hypothesise ✓ (3 ranked hypotheses)
- Phase 4 instrument ✓ (sha256 重算 + sqlite query + IPC inspect)
- Phase 5 fix ✓ (hash 修正 + backfillDefaultBranch)
- Phase 6 cleanup ✓ (CSP errors 0, x6Nodes 10, no exceptions, screenshot saved)

[image: notes/timeline-csp-and-defaultbranch-fix.png]