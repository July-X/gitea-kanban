# ADR-0009: Commit message 纪律（防 docs commit 伪装）

> **状态**：已实施
> **决策日期**：2026-07-04
> **背景**：v0.5.0 合并后复盘发现 commit `ac897fc`（提交标题 `docs: 更新项目文档`）实际改了 7 个文件，其中包括：
>   - `frontend/src/stores/pull.ts`（+96 行）
>   - `frontend/src/views/MergesView.vue`（+155 行）
>   - 删除 `scripts/review_code.go`
>
> 该 commit 静默把 PR 评论模块的核心数据流改动塞进「docs」标签，导致后续 reviewer 无法在 `git log --grep="docs:"` 找到代码改动，影响问题回溯。

---

## 1. 问题根因

### 1.1 现象

| 时间 | commit | 标题 | 实际改动 |
|---|---|---|---|
| 2026-07-04 | `ac897fc` | `docs: 更新项目文档` | AGENTS.md + CLAUDE.md + docs/adr/0008 + docs/releases/v0.5.0 + **frontend/src/stores/pull.ts** + **frontend/src/views/MergesView.vue** + 删除 scripts/review_code.go |

`ac897fc` 是一次 v0.5.0 阶段交付，但 commit message 是「更新项目文档」。后续：
- 同事 grep `docs:` 想找文档变更 → 看到这条 commit → 打开发现带 96 行 store 改动 → 浪费时间
- `git log -- frontend/src/stores/pull.ts` 找不到这条 commit，但实际改动在那里

### 1.2 根因

`scripts/hooks/post-edit.sh`（Reasonix Stop 阶段自动提交脚本）的 fallback 路径：

```
primary_changed_file (git diff --cached --name-only 字典序首个文件)
  ↓
AGENTS.md  ← 字典序在 stores/pull.ts 之前
  ↓
guess_commit_type → docs
  ↓
describe_changed_area → 项目文档
  ↓
fallback_commit_subject → "docs: 更新项目文档"
```

只要 staged 里有 AGENTS.md / CLAUDE.md / docs/ 任意一个，type 就被强判为 `docs`，**完全不看其余 staged files 是不是真的有代码改动**。

---

## 2. 决策

采用 **双层防护**：

### 2.1 上游修正（post-edit.sh）

加 `has_non_doc_changes()` 和 `primary_non_doc_file()` 两个 helper：

- `guess_commit_type` 开头检查：如果 staged 有非文档改动，用首个非文档文件替代 AGENTS.md 重判 type。
- `describe_changed_area` 开头检查：同上逻辑，避免 area 选「项目文档」。

**效果**：fallback 不再生成 `docs:` 伪装标题，自然产出 `fix: 优化 pull 状态` / `feat: 新增 XX 视图` 等准确标题。

### 2.2 下游兜底（commit-msg hook）

新增 `scripts/hooks/check-commit-message.sh`：

- 解析 commit subject
- 如果以 `docs:` 开头，校验 `git diff --cached --name-only` 拿 staged files
- 文档白名单 = `AGENTS.md / CLAUDE.md / docs/**/*.md / README* / CHANGELOG* / *.md / .github/*`
- 含非白名单文件 → exit 1 拒绝 + 给出违规清单 + 修正建议

**绕过开关**：`SKIP_DOCS_COMMIT_CHECK=1 git commit -m "..."` 或 `git commit --no-verify`（git 标准）

---

## 3. 不在本 ADR 范围内

- **不**改 commit message 模板本身（沿用 Conventional Commits 中文短标题）
- **不**改 reviewer 流程（PR review 还是人工）
- **不**改 pre-commit hook（commit-msg hook 已经能拦，更早拦截收益不大）

---

## 4. 启用指引

### 4.1 commit-msg hook 安装

git hooks 不进版本库（`.git/hooks/`），每个开发者手动装一次：

```bash
# 在项目根执行一次
ln -sf ../../scripts/hooks/check-commit-message.sh .git/hooks/commit-msg
chmod +x .git/hooks/check-commit-message.sh

# 验证
.git/hooks/commit-msg .git/COMMIT_EDITMSG
```

### 4.2 post-edit.sh 是 Reasonix 自动加载

`.reasonix/settings.json` 自动注册 `scripts/hooks/post-edit.sh`，无需手动装。

### 4.3 验证

```bash
# Case 1: docs commit + 全文档 → 通过
echo "## x" >> AGENTS.md
git add AGENTS.md
git commit -m "docs: 更新文档"  # ✅ exit 0

# Case 2: docs commit + 含 .go → 拒绝
echo "package x" > test.go
git add test.go
git commit -m "docs: 更新文档"  # ❌ exit 1 + 违规清单

# Case 3: feat commit + 含代码 → 通过（不受 hook 限制）
git commit -m "feat: 新增功能"  # ✅
```

---

## 5. 影响评估

| 场景 | 改动前 | 改动后 |
|---|---|---|
| 纯 docs commit（仅改 AGENTS.md / docs/） | 通过，标题「docs: 更新项目文档」 | 通过，标题同上 |
| docs commit 夹带代码（ac897fc 类） | **通过**，伪装成 docs（**bug**） | **拒绝**（commit-msg hook）/ **修正标题**（post-edit.sh） |
| feat/fix/perf/chore commit | 通过 | 通过（不受影响） |
| 紧急绕过 | N/A | `SKIP_DOCS_COMMIT_CHECK=1` 或 `--no-verify` |

---

## 6. 测试用例（已验证）

| # | 场景 | 期望 | 结果 |
|---|---|---|---|
| 1 | docs commit + 全文档白名单 | exit 0 | ✅ |
| 2 | docs commit + 含 .go 代码 | exit 1 + 违规清单 | ✅ |
| 3 | docs commit + 含 .vue | exit 1 + 违规清单 | ✅ |
| 4 | feat commit + 含代码 | exit 0 | ✅ |
| 5 | fix commit + 含 .vue | exit 0 | ✅ |
| 6 | docs commit + CHANGELOG.md | exit 0 | ✅ |
| 7 | docs commit + .github/PULL_REQUEST_TEMPLATE.md | exit 0 | ✅ |
| 8 | `SKIP_DOCS_COMMIT_CHECK=1` 绕过 | exit 0 + 提示 | ✅ |
| 9 | `git commit --no-verify` | exit 0（git 标准行为） | ✅ |
| 10 | ac897fc 仿真（AGENTS.md + store + view） | `fix: 优化 pull 状态` | ✅ |

测试仓库：`/tmp/hook-test` + `/tmp/hook-test-real`（已清理）

---

## 7. 相关

- `scripts/hooks/check-commit-message.sh`（新增）
- `scripts/hooks/post-edit.sh`（加固）
- 触发 issue：v0.5.0 合并请求「对话」Tab 列表空白 bug → 复盘发现 ac897fc 改动漏检