# GitHub Integration Test（v0.6+）

## 目的

`app/platform/github/integration_test.go` 提供**真实 GitHub API 端到端测试**，覆盖 `httptest` 单测无法验证的场景：

- 真实 GitHub API 字段变化（schema 升级）
- token scope 兼容性（PAT 是否够权限）
- 真实端点响应差异（如 assignees 端点 422 行为）
- 跨多个 API 调用的协同逻辑（GET → diff → DELETE+POST 增量替换）

**不**覆盖（已在 `adapter_test.go` httptest 单测中覆盖）：
- `MergePull` —— 真实跑会污染 `main` 分支
- `CloneRepo` —— 需要 gh CLI + 用户级 git 凭证

## 跑法

```bash
# 1. 准备 fine-grained PAT，scope 限定 July-X/kanban-test 仓库：
#    - Contents: Read and Write
#    - Pull requests: Read and Write
#    - Metadata: Read (mandatory)
#
# 2. 跑测试：
INTEGRATION_GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxx \
  go test -tags integration -v -count=1 \
  ./app/platform/github/...

# 输出会显示：
#   [integration] GitHub user=<your-login>, repo=July-X/kanban-test
#   === RUN   TestGitHubIntegration_ListPulls
#   ...
#   PASS
```

## 默认行为

`go test ./...` **不**编译、不跑 integration 测试（被 `//go:build integration` tag 隔离）。

CI 默认跳过（TestMain 检测到 `INTEGRATION_GITHUB_TOKEN` 为空 → `os.Exit(0)`）。

## Fixture 策略

每个测试函数**自己创建** fixture PR + **defer 关闭**：

- 创建流程：GitHub Git Data API
  1. `POST /git/blobs`（空 blob）
  2. `POST /git/trees`（基于 default_branch + blob）
  3. `POST /git/commits`（commit，parent = default_branch SHA）
  4. `POST /git/refs`（refs/heads/int-test-{nanosecond}）
  5. `POST /pulls`（head = 新分支, base = default_branch）
- 关闭流程：
  - `PATCH /pulls/{index}` state=closed
  - `DELETE /git/refs/heads/{branch}`

### 幂等保证

- 标题前缀统一 `[integration-fixture]`：TestMain 启动期 + 退出期扫所有 open PR，关闭遗漏 fixture
- 每个测试独立创建分支（`int-test-{UnixNano()}`），不串扰
- 失败也 cleanup：`defer cleanup()` 保证测试 panic / t.Fatal 也走清理路径

### 副作用范围

- **不**污染 `main` 分支：所有 fixture PR 都关闭，不 merge
- **不**创建 tag / release
- **不**改仓库设置（visibility / description 等）

## 不跑测试的 fallback

无 token 时输出：

```
[integration] INTEGRATION_GITHUB_TOKEN 未设置，跳过 integration 测试
[integration] 跑法：INTEGRATION_GITHUB_TOKEN=ghp_xxx go test -tags integration -v ./app/platform/github/...
ok  	gitea-kanban/app/platform/github	0.018s
```

并以 `ok` 退出（exit 0），不阻断 CI。

## 安全

- token 绝不进源码（环境变量读）
- 测试仓库 private：别人看不到 fixture
- PAT scope 限定到单仓库：即使 token 泄漏，影响范围 = 一个仓库
- 清理期扫 open PR：意外留的 fixture 会被自动关

## 后续可加测试

- 真实 `MergePull`：需要 base = `int-test-merge-base` 隔离分支（用户预创建），避免污染 main
- 真实 `CloneRepo`：需要 gh CLI 登录态 + 大仓库
- 大量并发 fixture：测试 rate limit 行为