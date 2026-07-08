# Reasonix 模型 Hook：post-edit + commit-msg

让 Reasonix 在大模型完成代码修改后，自动按
**format → build → test → git commit（中文记录）** 的链路收尾。
任一阶段失败立即停止，不会自动 commit。

## 文件

| 文件 | 作用 | git 跟踪 | 自动加载 |
| --- | --- | --- | --- |
| `scripts/hooks/post-edit.sh` | Reasonix Stop / PostToolUse 事件处理（核心） | ✅ | ✅（reasonix 读 `.reasonix/settings.json`） |
| `scripts/hooks/check-commit-message.sh` | git commit-msg hook：拦截 `docs:` 伪装 commit（v0.5.0 bugfix） | ✅ | ❌（需手动安装，详见 §commit-msg hook） |
| `scripts/hooks/install-hooks.sh` | 一键安装 commit-msg hook 到 `.git/hooks/commit-msg` | ✅ | — |
| `.reasonix/settings.json` | 注册 hook 事件和命令 | ❌（reasonix 加载） | — |

> `.reasonix/settings.json` 在 `.gitignore` 内，本身不进 git。
> 首次启用需在桌面端「设置 → Hooks → 项目」点 **信任此工作区**，
> 或在 CLI 中执行 `/hooks trust`。详见 [Reasonix Hooks 文档](https://github.com/esengine/DeepSeek-Reasonix/blob/main-v2/docs/DESKTOP_HOOKS.zh-CN.md)。

## 触发时机

| 事件 | 何时 | 行为 |
| --- | --- | --- |
| `PostToolUse` (match: `edit_file` / `write_file` / `multi_edit` / `bash`) | 模型每次写文件/调 bash 后 | 仅跑 `gofmt -w` 增量修复，保证下次 build 不被格式问题阻断 |
| `Stop` | 一轮对话结束后 | 跑完整 4 阶段：format → build → test → commit |

`Stop` 阶段流程：

1. **格式化**（gofmt 全量 `-w`，前端按需 lint/format）
2. **编译**（`go build ./...`）— 失败立即停止
3. **测试**（`go test ./... -count=1 -timeout 120s`）— 失败立即停止
4. **git commit**（`git add -A` + 中文 message）— 工作区干净则跳过

任一阶段失败退出非 0，reasonix 会把脚本的 stderr 显示为 warning，**不会**自动 commit。

## commit 信息生成

`Stop` 事件会携带模型最后一次回复文本（`lastAssistantText`），脚本只接受短中文 Conventional Commit 标题：

```
fix: 修复 git-graph 拖拽错位
feat: SourceTree 风格表头
refactor: 收敛 Git Graph 视图状态
```

如果模型最后回复是"修复总结"、"所有 todos 完成"、"完成"这类交付总结标题，脚本会拒绝直接作为提交说明，并根据实际变更文件生成兜底标题：

```
chore: 优化 Reasonix hooks 提交说明
fix: 优化 git-graph 时间线
docs: 更新项目文档
```

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `POST_EDIT_COMMIT_STYLE` | 空 | `concise-conventional` = 强制提交标题为短中文 Conventional Commit 风格。 |
| `POST_EDIT_SKIP_TEST` | `0` | `1` = 跳过 `go test` 阶段。已知测试用例失败时可临时绕过，但**不要**作为默认设置。 |
| `POST_EDIT_SKIP_COMMIT` | `0` | `1` = 跳过 commit 阶段，仅做 format/build/test 验证。 |

## 失败注入测试

```bash
# 验证 Stop 全流程（test 通过 → commit）
echo '{"event":"Stop","cwd":"'$(pwd)'"}' | bash scripts/hooks/post-edit.sh

# 验证 test 失败时立刻停止（不 commit）
echo '{"event":"Stop","cwd":"'$(pwd)'"}' | bash scripts/hooks/post-edit.sh; echo "exit=$?"

# 跳过 test 直接验证 commit 路径
echo '{"event":"Stop","cwd":"'$(pwd)'"}' | POST_EDIT_SKIP_TEST=1 bash scripts/hooks/post-edit.sh
```

## 与项目工具链的兼容性

| 工具 | 处理方式 |
| --- | --- |
| `gofmt` | 用 Go 自带 `gofmt -w`，无需额外依赖 |
| `prettier` / `eslint --fix` | 当 `frontend/` 下 `package.json` 声明了 `lint` 或 `format` 脚本时自动跑（缺失则跳过） |
| `go test` | 用 `-count=1` 关缓存，`-timeout 120s` 兜底 |

## 已知坑

- 项目 `app/git/log_test.go` 中 `TestLogCommits_RefsAttached` 用 hardcode 索引
  `result.Commits[2]` 断言 "first commit subject"，与注释中"顺序可能不同"矛盾，
  在当前 git 历史下不稳定地失败。**不在本 hook 范围内修复**，但会让
  `Stop` 流程恒定停在 test 阶段。临时方案：
  ```bash
  echo 'export POST_EDIT_SKIP_TEST=1' >> ~/.zshrc
  ```
  或者修复测试本身（建议改用按 `Subject` 查找而不是索引）。

---

## commit-msg hook（v0.5.0 bugfix）

防 `ac897fc` 类「伪装成 docs commit 实际改了 store / 视图」的提交。具体规则与复盘见 [docs/adr/0009-commit-message-discipline.md](../../docs/adr/0009-commit-message-discipline.md)。

### 一键安装

```bash
bash scripts/hooks/install-hooks.sh
```

脚本会创建 symlink：`.git/hooks/commit-msg -> ../../scripts/hooks/check-commit-message.sh`

### 手动安装

```bash
ln -sf ../../scripts/hooks/check-commit-message.sh .git/hooks/commit-msg
chmod +x scripts/hooks/check-commit-message.sh
```

### 规则摘要

- commit subject 以 `docs:` 开头时，校验 `git diff --cached --name-only`
- 文档白名单 = `AGENTS.md / CLAUDE.md / docs/**/*.md / README* / CHANGELOG* / *.md / .github/*`
- 含非白名单文件 → exit 1 拒绝 + 列出违规文件 + 给出修正建议
- 非 docs commit 不做限制

### 临时绕过

```bash
SKIP_DOCS_COMMIT_CHECK=1 git commit -m "..."   # 环境变量
git commit --no-verify -m "..."                # git 标准
```

### 验证

```bash
echo "// x" > test.go && git add test.go
git commit -m "docs: 测试"  # ❌ exit 1 + 「docs commit 文件白名单校验失败」

git commit -m "feat: 测试"  # ✅ exit 0
```
