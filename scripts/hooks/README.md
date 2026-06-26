# Reasonix 模型 Hook：post-edit

让 Reasonix 在大模型完成代码修改后，自动按
**format → build → test → git commit（中文记录）** 的链路收尾。
任一阶段失败立即停止，不会自动 commit。

## 文件

| 文件 | 作用 | git 跟踪 |
| --- | --- | --- |
| `scripts/hooks/post-edit.sh` | 实际执行脚本（核心） | ✅ |
| `.reasonix/settings.json` | 注册 hook 事件和命令 | ❌（reasonix 加载） |

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

`Stop` 事件会携带模型最后一次回复文本（`lastAssistantText`），脚本从中截取首句（句号/换行前，最多 120 字）作为 commit body 的中文描述：

```
chore: 模型自动提交

<截取的模型回复中文首句>
```

兜底场景（payload 没拿到 / 中文首句太长）会退化为：

```
chore: 模型自动提交

变更摘要： <git diff --stat 末行 / git status 头行>
```

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
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