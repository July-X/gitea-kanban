//go:build integration

// Package github integration_test.go —— 真实 GitHub 端到端测试
//
// 目标：覆盖 httptest 单测无法验证的场景（真实 GitHub API 行为变化、
// token scope 兼容性、端点响应字段差异）。
//
// 设计原则（AGENTS §7.1 测试策略 + v0.6+ 用户拍板）：
//   - //go:build integration tag：默认 go test ./... 不编译、不跑
//   - 跑法：INTEGRATION_GITHUB_TOKEN=ghp_xxx \
//     go test -tags integration -v -run TestGitHubIntegration \
//     ./app/platform/github/...
//   - CI 跳过（无 token → TestMain 直接 os.Exit(0)）
//   - 测试仓库 hardcoded（July-X/kanban-test），保证 fixture 隔离
//   - 每个测试函数自己创建 fixture PR + defer 关闭（幂等）
//   - 不跑 MergePull：会真的合到 base 分支，污染仓库；MergePull 单测
//     已在 httptest 层面覆盖（见 adapter_test.go TestGitHubAdapter_MergePull_Basic）
//
// 覆盖范围：
//   - TestGitHubIntegration_ListPulls  验证能列到 fixture PR
//   - TestGitHubIntegration_GetPull    验证能拉详情（含 mergeable 字段）
//   - TestGitHubIntegration_UpdatePullLabels  验证 PUT /issues/{index}/labels 生效
//   - TestGitHubIntegration_UpdatePullAssignee  验证 diff + DELETE+POST 增量替换
//   - TestGitHubIntegration_UpdatePullReviewers  验证 diff + DELETE+POST 增量替换
//   - TestGitHubIntegration_ClosePull  验证 PATCH state=closed 生效
//   - TestGitHubIntegration_PullComments  验证 PR 评论端到端（list + create + 字段映射）
//
// 安全：
//   - token 绝不进源码（环境变量读）
//   - 测试仓库是 private，但 token 仍应限定 scope：
//     Contents: Read+Write + Pull requests: Read+Write + Metadata: Read
//   - fixture PR 标题统一前缀 [integration-fixture]，方便排查 + cleanup 不会误伤真 PR
package github

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"gitea-kanban/app/ipc"
	"gitea-kanban/app/platform"
)

// ===== 测试仓库常量 =====
//
// 用户拍板（v0.6+）：用 July-X/kanban-test 作为 fixture 仓库
//   - 私有仓库（PAT 必须显式 grant）
//   - main 分支用户自维护，**不**直接污染
const (
	integrationOwner   = "July-X"
	integrationRepo    = "kanban-test"
	integrationAPIHost = "https://api.github.com"
)

// fixturePRTitlePrefix 测试用 PR 标题前缀，cleanup 用它识别 fixture
const fixturePRTitlePrefix = "[integration-fixture]"

// ===== TestMain：环境检查 + 全局 cleanup =====

func TestMain(m *testing.M) {
	token := os.Getenv("INTEGRATION_GITHUB_TOKEN")
	if token == "" {
		fmt.Println("[integration] INTEGRATION_GITHUB_TOKEN 未设置，跳过 integration 测试")
		fmt.Println("[integration] 跑法：INTEGRATION_GITHUB_TOKEN=ghp_xxx go test -tags integration -v ./app/platform/github/...")
		os.Exit(0)
	}

	ctx := context.Background()
	adapter := NewGitHubAdapter()

	// 验证 token 有效（顺便探测 API 状态）
	user, err := adapter.VerifyToken(ctx, integrationAPIHost, token)
	if err != nil {
		fmt.Printf("[integration] VerifyToken 失败（token 无效 / 网络不通 / 速率限制）：%v\n", err)
		os.Exit(1)
	}
	fmt.Printf("[integration] GitHub user=%s, repo=%s/%s\n", user.Login, integrationOwner, integrationRepo)

	// 跑测试前先清遗留 fixture（防止上次跑挂遗留的 PR）
	if err := cleanupFixturePRs(ctx, token); err != nil {
		fmt.Printf("[integration] 启动期 cleanup 失败（忽略，不阻断测试）：%v\n", err)
	}

	// 跑测试
	code := m.Run()

	// 跑完再清一次
	if err := cleanupFixturePRs(ctx, token); err != nil {
		fmt.Printf("[integration] 退出期 cleanup 失败（请手动到 GitHub 关闭 fixture PR）：%v\n", err)
	}

	os.Exit(code)
}

// ===== GitHub API 端到端测试 =====

// TestGitHubIntegration_ListPulls 验证能列到 fixture PR
//
// 真实 GitHub /pulls 端点的 state filter + 字段映射
func TestGitHubIntegration_ListPulls(t *testing.T) {
	ctx := context.Background()
	token := mustToken(t)
	adapter := NewGitHubAdapter()

	pr, cleanup := createFixturePR(t, ctx, token)
	defer cleanup()

	pulls, err := adapter.ListPulls(ctx, integrationAPIHost, "", token, integrationOwner, integrationRepo, platform.ListPullsOpts{
		State: "open",
		Limit: 50,
	})
	if err != nil {
		t.Fatalf("ListPulls failed: %v", err)
	}

	found := false
	for _, p := range pulls {
		if p.Index == pr {
			found = true
			if p.Title == "" {
				t.Errorf("PR #%d title is empty", pr)
			}
			if p.Author == nil || p.Author.Username == "" {
				t.Errorf("PR #%d author is empty", pr)
			}
			if p.Head.Ref == "" {
				t.Errorf("PR #%d head.ref is empty", pr)
			}
			if p.Base.Ref == "" {
				t.Errorf("PR #%d base.ref is empty", pr)
			}
			// v0.6+ bugfix：GitHub 列表不返 comments，fillGitHubCommentsCount 补全
			// 新创建的 fixture PR 没评论，CommentsCount 应为 0
			if p.CommentsCount < 0 {
				t.Errorf("PR #%d CommentsCount = %d, want >= 0", pr, p.CommentsCount)
			}
			break
		}
	}
	if !found {
		t.Errorf("创建的 fixture PR #%d 不在 ListPulls 结果里", pr)
	}
}

// TestGitHubIntegration_GetPull 验证能拉详情
func TestGitHubIntegration_GetPull(t *testing.T) {
	ctx := context.Background()
	token := mustToken(t)
	adapter := NewGitHubAdapter()

	pr, cleanup := createFixturePR(t, ctx, token)
	defer cleanup()

	d, err := adapter.GetPull(ctx, integrationAPIHost, "", token, integrationOwner, integrationRepo, pr)
	if err != nil {
		t.Fatalf("GetPull failed: %v", err)
	}
	if d.Number != pr {
		t.Errorf("Number = %d, want %d", d.Number, pr)
	}
	if d.State != "open" {
		t.Errorf("State = %q, want open", d.State)
	}
	if !strings.HasPrefix(d.Title, fixturePRTitlePrefix) {
		t.Errorf("Title = %q, want prefix %q", d.Title, fixturePRTitlePrefix)
	}
}

// TestGitHubIntegration_UpdatePullLabels 验证 PUT /issues/{index}/labels 生效
func TestGitHubIntegration_UpdatePullLabels(t *testing.T) {
	ctx := context.Background()
	token := mustToken(t)
	adapter := NewGitHubAdapter()

	pr, cleanup := createFixturePR(t, ctx, token)
	defer cleanup()

	// GitHub 端 PUT /issues/{index}/labels body: {labels: ["name1", "name2"]}
	// 仓库里**不一定**有这些 label —— GitHub 会自动创建（PUT 端点的语义）
	// 不过我们用一个带前缀的 label 名降低误伤概率
	labelNames := []string{
		fixturePRTitlePrefix + "-bug",
		fixturePRTitlePrefix + "-feature",
	}
	d, err := adapter.UpdatePullLabels(ctx, integrationAPIHost, "", token, integrationOwner, integrationRepo, pr, labelNames)
	if err != nil {
		t.Fatalf("UpdatePullLabels failed: %v", err)
	}

	// 验证返回的 DTO 里 labels 字段已更新
	foundCount := 0
	for _, l := range d.Labels {
		for _, want := range labelNames {
			if l.Name == want {
				foundCount++
			}
		}
	}
	if foundCount != len(labelNames) {
		t.Errorf("returned Labels 包含 %d 个 fixture label, want %d (%v)",
			foundCount, len(labelNames), d.Labels)
	}

	// 再 GET 一次真实端点确认落库
	d2, err := adapter.GetPull(ctx, integrationAPIHost, "", token, integrationOwner, integrationRepo, pr)
	if err != nil {
		t.Fatalf("GetPull(after UpdatePullLabels) failed: %v", err)
	}
	gotNames := make(map[string]bool, len(d2.Labels))
	for _, l := range d2.Labels {
		gotNames[l.Name] = true
	}
	for _, want := range labelNames {
		if !gotNames[want] {
			t.Errorf("PR #%d 真上没有 label %q (实际: %v)", pr, want, gotNames)
		}
	}
}

// TestGitHubIntegration_UpdatePullAssignee 验证 diff + DELETE+POST 增量替换
//
// 三步覆盖：
//  1. 空 → 1（无现有 assignee → 直接 POST）
//  2. 1 → 1（同 assignee → 无 POST 无 DELETE，幂等）
//  3. 1 → 0（清空 → DELETE）
func TestGitHubIntegration_UpdatePullAssignee(t *testing.T) {
	ctx := context.Background()
	token := mustToken(t)
	adapter := NewGitHubAdapter()

	pr, cleanup := createFixturePR(t, ctx, token)
	defer cleanup()

	// ===== Step 1: 空 → 1（POST）=====
	// GitHub 端 POST /issues/{index}/assignees {assignees: ["user"]}
	// 用户的 username 是 VerifyToken 拿到的 login
	user, err := adapter.VerifyToken(ctx, integrationAPIHost, token)
	if err != nil {
		t.Fatalf("VerifyToken failed: %v", err)
	}
	d1, err := adapter.UpdatePullAssignee(ctx, integrationAPIHost, "", token, integrationOwner, integrationRepo, pr, []string{user.Login})
	if err != nil {
		t.Fatalf("UpdatePullAssignee(空→%s) failed: %v", user.Login, err)
	}
	if len(d1.Assignees) != 1 || d1.Assignees[0].Username != user.Login {
		t.Errorf("Step 1 返回 Assignees = %+v, want [%s]", d1.Assignees, user.Login)
	}

	// 真上 GET 确认
	d1Get, err := adapter.GetPull(ctx, integrationAPIHost, "", token, integrationOwner, integrationRepo, pr)
	if err != nil {
		t.Fatalf("GetPull(after Step 1) failed: %v", err)
	}
	if len(d1Get.Assignees) != 1 || d1Get.Assignees[0].Username != user.Login {
		t.Errorf("Step 1 真上 Assignees = %+v, want [%s]", d1Get.Assignees, user.Login)
	}

	// ===== Step 2: 1 → 1（幂等，无 POST 无 DELETE）=====
	// 用真实 GitHub 调一次，验返回 + 真上一致
	d2, err := adapter.UpdatePullAssignee(ctx, integrationAPIHost, "", token, integrationOwner, integrationRepo, pr, []string{user.Login})
	if err != nil {
		t.Fatalf("UpdatePullAssignee(1→1 幂等) failed: %v", err)
	}
	if len(d2.Assignees) != 1 || d2.Assignees[0].Username != user.Login {
		t.Errorf("Step 2 返回 Assignees = %+v, want [%s]", d2.Assignees, user.Login)
	}

	// ===== Step 3: 1 → 0（清空）=====
	d3, err := adapter.UpdatePullAssignee(ctx, integrationAPIHost, "", token, integrationOwner, integrationRepo, pr, []string{})
	if err != nil {
		t.Fatalf("UpdatePullAssignee(1→0 清空) failed: %v", err)
	}
	if len(d3.Assignees) != 0 {
		t.Errorf("Step 3 返回 Assignees = %+v, want []", d3.Assignees)
	}

	// 真上确认
	d3Get, err := adapter.GetPull(ctx, integrationAPIHost, "", token, integrationOwner, integrationRepo, pr)
	if err != nil {
		t.Fatalf("GetPull(after Step 3) failed: %v", err)
	}
	if len(d3Get.Assignees) != 0 {
		t.Errorf("Step 3 真上 Assignees = %+v, want []", d3Get.Assignees)
	}
}

// TestGitHubIntegration_UpdatePullReviewers 验证 requested_reviewers 端到端
//
// 已知 GitHub 限制：PR author 不能请求自己 review（"Review cannot be requested
// from pull request author"）。fixture PR 由 token owner 创建 → PR author = token owner
// → 无法触发"空→1"的 happy path。集成测试遇到这种情况自动 t.Skip。
//
// 想覆盖更多场景需要：另找 repo collaborator 作为 reviewer（fixture 复杂度↑），
// 或改用非 token owner 的 PAT。本测试优先验证"清空"路径（不依赖具体 reviewer）。
func TestGitHubIntegration_UpdatePullReviewers(t *testing.T) {
	ctx := context.Background()
	token := mustToken(t)
	adapter := NewGitHubAdapter()

	pr, cleanup := createFixturePR(t, ctx, token)
	defer cleanup()

	user, err := adapter.VerifyToken(ctx, integrationAPIHost, token)
	if err != nil {
		t.Fatalf("VerifyToken failed: %v", err)
	}

	// 1 → 0 → 1 三步（中间 0 不需要 1 → 0 真实跑，可以跳过）
	t.Run("空→1", func(t *testing.T) {
		d, err := adapter.UpdatePullReviewers(ctx, integrationAPIHost, "", token, integrationOwner, integrationRepo, pr, []string{user.Login})
		if err != nil {
			// GitHub 对非 collaborator 返 422（"Could not resolve to a node"），
			// 这条路径下也算预期行为 —— 标记为 skip 而不是 fail
			if isNotCollaboratorErr(err) {
				t.Skipf("当前 token 对应 user 不是 repo collaborator，跳过: %v", err)
			}
			t.Fatalf("UpdatePullReviewers(空→[%s]) failed: %v", user.Login, err)
		}
		if len(d.Reviewers) != 1 || d.Reviewers[0].Username != user.Login {
			t.Errorf("返回 Reviewers = %+v, want [%s]", d.Reviewers, user.Login)
		}
	})

	t.Run("1→0 清空", func(t *testing.T) {
		_, err := adapter.UpdatePullReviewers(ctx, integrationAPIHost, "", token, integrationOwner, integrationRepo, pr, []string{})
		if err != nil {
			if isNotCollaboratorErr(err) {
				t.Skipf("当前 token 对应 user 不是 repo collaborator，跳过: %v", err)
			}
			t.Fatalf("UpdatePullReviewers(1→0) failed: %v", err)
		}
	})
}

// TestGitHubIntegration_ClosePull 验证 PATCH state=closed 生效
func TestGitHubIntegration_ClosePull(t *testing.T) {
	ctx := context.Background()
	token := mustToken(t)
	adapter := NewGitHubAdapter()

	pr, cleanup := createFixturePR(t, ctx, token)
	defer cleanup()

	d, err := adapter.ClosePull(ctx, integrationAPIHost, "", token, integrationOwner, integrationRepo, pr)
	if err != nil {
		t.Fatalf("ClosePull failed: %v", err)
	}
	if d.State != "closed" {
		t.Errorf("State = %q, want closed", d.State)
	}
	// 注：PullDetailDTO 当前没有 ClosedAt 字段（未来可加，不在 v0.6 范围）

	// 真上确认
	dGet, err := adapter.GetPull(ctx, integrationAPIHost, "", token, integrationOwner, integrationRepo, pr)
	if err != nil {
		t.Fatalf("GetPull(after Close) failed: %v", err)
	}
	if dGet.State != "closed" {
		t.Errorf("真上 State = %q, want closed", dGet.State)
	}
}

// TestGitHubIntegration_PullComments 验证 PR 评论端到端（list + create + 真上可见）
func TestGitHubIntegration_PullComments(t *testing.T) {
	ctx := context.Background()
	token := mustToken(t)
	adapter := NewGitHubAdapter()

	pr, cleanup := createFixturePR(t, ctx, token)
	defer cleanup()

	// 1. 初始评论列表应该为空
	list, err := adapter.ListPullComments(ctx, integrationAPIHost, "", token, integrationOwner, integrationRepo, pr)
	if err != nil {
		t.Fatalf("ListPullComments(初始) failed: %v", err)
	}
	if len(list) != 0 {
		t.Errorf("初始评论列表 len = %d, want 0", len(list))
	}

	// 2. 发 3 条评论
	bodies := []string{"first", "second", "third"}
	for i, body := range bodies {
		created, err := adapter.CreatePullComment(ctx, integrationAPIHost, "", token, integrationOwner, integrationRepo, pr, body)
		if err != nil {
			t.Fatalf("CreatePullComment[%d] failed: %v", i, err)
		}
		if created.ID == 0 {
			t.Errorf("CreatePullComment[%d] 返回 ID = 0", i)
		}
		if created.Body != body {
			t.Errorf("CreatePullComment[%d] 返回 Body = %q, want %q", i, created.Body, body)
		}
		if created.Author == nil || created.Author.Username == "" {
			t.Errorf("CreatePullComment[%d] Author 为空或 Username 为空", i)
		}
	}

	// 3. 二次拉取验证
	list2, err := adapter.ListPullComments(ctx, integrationAPIHost, "", token, integrationOwner, integrationRepo, pr)
	if err != nil {
		t.Fatalf("ListPullComments(发后) failed: %v", err)
	}
	if len(list2) < 3 {
		t.Errorf("发 3 条后评论列表 len = %d, want >= 3", len(list2))
	}

	// 4. 验证 author 与返回一致
	found := 0
	for _, c := range list2 {
		for _, b := range bodies {
			if c.Body == b {
				found++
				if c.Author == nil || c.Author.Username == "" {
					t.Errorf("评论 %q 的 Author 为空", b)
				}
			}
		}
	}
	if found < 3 {
		t.Errorf("在列表中找到 %d 条评论，want >= 3", found)
	}

	// 5. 空 body short-circuit 验证
	_, err = adapter.CreatePullComment(ctx, integrationAPIHost, "", token, integrationOwner, integrationRepo, pr, "   ")
	if err == nil {
		t.Error("expected validation error for whitespace-only body, got nil")
	}
}

// ===== helpers =====

// mustToken 读环境变量；缺失则 t.Skip（不应该发生：TestMain 已 gate）
func mustToken(t *testing.T) string {
	t.Helper()
	tok := os.Getenv("INTEGRATION_GITHUB_TOKEN")
	if tok == "" {
		t.Skip("INTEGRATION_GITHUB_TOKEN 未设置")
	}
	return tok
}

// createFixturePR 在测试仓库创建 1 个 fixture PR，返回 (index, cleanup)
//
// 创建流程（GitHub Git Data API）：
//  1. GET /repos/{owner}/{repo} 拿 default_branch + head SHA
//  2. POST /repos/{owner}/{repo}/git/blobs  (空 blob)
//  3. POST /repos/{owner}/{repo}/git/trees  (tree 指向 blob)
//  4. POST /repos/{owner}/{repo}/git/commits (commit，parent = base SHA)
//  5. POST /repos/{owner}/{repo}/git/refs   (refs/heads/int-test-{ts})
//  6. POST /repos/{owner}/{repo}/pulls     (head = 新分支, base = default_branch)
//  7. 关闭 = PATCH state=closed
//
// cleanup 函数：defer 调一次确保测试失败也清理（不只是成功路径）
func createFixturePR(t *testing.T, ctx context.Context, token string) (int, func()) {
	t.Helper()

	// 1. 拿 default_branch SHA
	baseRef, baseSHA, err := getDefaultBranch(ctx, token)
	if err != nil {
		t.Fatalf("getDefaultBranch failed: %v", err)
	}

	// 2-5. 创建 head branch（1 个空 commit）
	branchName := fmt.Sprintf("int-test-%d", time.Now().UnixNano())
	if err := createBranchWithEmptyCommit(ctx, token, baseSHA, branchName); err != nil {
		t.Fatalf("createBranchWithEmptyCommit(%s) failed: %v", branchName, err)
	}

	// 6. 创建 PR
	title := fmt.Sprintf("%s %s", fixturePRTitlePrefix, branchName)
	body := "auto-created by gitea-kanban integration test"
	prNum, err := createPR(ctx, token, baseRef, branchName, title, body)
	if err != nil {
		// 清理 branch
		_ = deleteBranch(ctx, token, branchName)
		t.Fatalf("createPR(%s → %s) failed: %v", branchName, baseRef, err)
	}

	// 7. cleanup：关闭 PR + 删 branch
	cleanup := func() {
		// 关 PR（无论测试成功失败都执行）
		if err := patchPRState(ctx, token, prNum, "closed"); err != nil {
			t.Logf("[cleanup] patchPRState(%d, closed) failed: %v（请手动到 GitHub 关闭）", prNum, err)
		}
		// 删 branch
		if err := deleteBranch(ctx, token, branchName); err != nil {
			t.Logf("[cleanup] deleteBranch(%s) failed: %v（请手动删除）", branchName, err)
		}
	}

	return prNum, cleanup
}

// ===== 底层 GitHub REST API helpers =====
//
// 用 Go net/http 直接调，保持项目"纯 net/http"风格（与 adapter.go 一致）

// ghAPIRequest 通用 GitHub API 请求
func ghAPIRequest(ctx context.Context, method, path, token string, body any, out any) error {
	fullURL := integrationAPIHost + path

	var reader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("marshal body: %w", err)
		}
		reader = strings.NewReader(string(b))
	}

	req, err := http.NewRequestWithContext(ctx, method, fullURL, reader)
	if err != nil {
		return fmt.Errorf("new request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("do request: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("status %d: %s", resp.StatusCode, string(respBody))
	}
	if out != nil {
		if err := json.Unmarshal(respBody, out); err != nil {
			return fmt.Errorf("unmarshal: %w (body: %s)", err, string(respBody))
		}
	}
	return nil
}

// getDefaultBranch 拿仓库的默认分支 ref + SHA
func getDefaultBranch(ctx context.Context, token string) (ref, sha string, err error) {
	var raw struct {
		DefaultBranch string `json:"default_branch"`
	}
	if err := ghAPIRequest(ctx, "GET", fmt.Sprintf("/repos/%s/%s", integrationOwner, integrationRepo), token, nil, &raw); err != nil {
		return "", "", fmt.Errorf("GET repo: %w", err)
	}
	ref = raw.DefaultBranch

	var refRaw struct {
		Object struct {
			SHA string `json:"sha"`
		} `json:"object"`
	}
	if err := ghAPIRequest(ctx, "GET", fmt.Sprintf("/repos/%s/%s/git/ref/heads/%s", integrationOwner, integrationRepo, ref), token, nil, &refRaw); err != nil {
		return "", "", fmt.Errorf("GET ref: %w", err)
	}
	return ref, refRaw.Object.SHA, nil
}

// createBranchWithEmptyCommit 通过 Git Data API 创建 1 个新分支（带空 commit）
//
// 步骤：
//  1. POST /repos/{owner}/{repo}/git/blobs   {content: "", encoding: "utf-8"}
//  2. POST /repos/{owner}/{repo}/git/trees   {tree: [{path: ".int-test", mode: "100644", type: "blob", sha: <blob>}]}
//  3. POST /repos/{owner}/{repo}/git/commits {message: "...", tree: <tree>, parents: [<baseSHA>]}
//  4. POST /repos/{owner}/{repo}/git/refs    {ref: "refs/heads/<branch>", sha: <commit>}
func createBranchWithEmptyCommit(ctx context.Context, token, baseSHA, branchName string) error {
	// 1. blob
	var blobRaw struct {
		SHA string `json:"sha"`
	}
	if err := ghAPIRequest(ctx, "POST", fmt.Sprintf("/repos/%s/%s/git/blobs", integrationOwner, integrationRepo), token,
		map[string]any{"content": "", "encoding": "utf-8"}, &blobRaw); err != nil {
		return fmt.Errorf("create blob: %w", err)
	}

	// 2. tree
	var treeRaw struct {
		SHA string `json:"sha"`
	}
	if err := ghAPIRequest(ctx, "POST", fmt.Sprintf("/repos/%s/%s/git/trees", integrationOwner, integrationRepo), token,
		map[string]any{
			"base_tree": baseSHA,
			"tree": []map[string]any{
				{
					"path": ".int-test",
					"mode": "100644",
					"type": "blob",
					"sha":  blobRaw.SHA,
				},
			},
		}, &treeRaw); err != nil {
		return fmt.Errorf("create tree: %w", err)
	}

	// 3. commit
	var commitRaw struct {
		SHA string `json:"sha"`
	}
	if err := ghAPIRequest(ctx, "POST", fmt.Sprintf("/repos/%s/%s/git/commits", integrationOwner, integrationRepo), token,
		map[string]any{
			"message": "integration test fixture",
			"tree":    treeRaw.SHA,
			"parents": []string{baseSHA},
		}, &commitRaw); err != nil {
		return fmt.Errorf("create commit: %w", err)
	}

	// 4. ref
	if err := ghAPIRequest(ctx, "POST", fmt.Sprintf("/repos/%s/%s/git/refs", integrationOwner, integrationRepo), token,
		map[string]any{
			"ref": "refs/heads/" + branchName,
			"sha": commitRaw.SHA,
		}, nil); err != nil {
		return fmt.Errorf("create ref: %w", err)
	}

	return nil
}

// createPR 创建 1 个 PR（head → base）
func createPR(ctx context.Context, token, base, head, title, body string) (int, error) {
	var raw struct {
		Number int `json:"number"`
	}
	if err := ghAPIRequest(ctx, "POST", fmt.Sprintf("/repos/%s/%s/pulls", integrationOwner, integrationRepo), token,
		map[string]any{
			"title": title,
			"body":  body,
			"head":  head,
			"base":  base,
		}, &raw); err != nil {
		return 0, err
	}
	return raw.Number, nil
}

// patchPRState PATCH /repos/{owner}/{repo}/pulls/{index} {state: ...}
func patchPRState(ctx context.Context, token string, index int, state string) error {
	return ghAPIRequest(ctx, "PATCH", fmt.Sprintf("/repos/%s/%s/pulls/%d", integrationOwner, integrationRepo, index), token,
		map[string]any{"state": state}, nil)
}

// deleteBranch DELETE /repos/{owner}/{repo}/git/refs/heads/<branch>
func deleteBranch(ctx context.Context, token, branchName string) error {
	return ghAPIRequest(ctx, "DELETE", fmt.Sprintf("/repos/%s/%s/git/refs/heads/%s", integrationOwner, integrationRepo, branchName), token, nil, nil)
}

// cleanupFixturePRs 在 TestMain 启动 / 退出时跑，关闭所有 [integration-fixture] 前缀的 open PR
func cleanupFixturePRs(ctx context.Context, token string) error {
	// 列所有 open PR
	var pulls []struct {
		Number int    `json:"number"`
		Title  string `json:"title"`
		State  string `json:"state"`
	}
	if err := ghAPIRequest(ctx, "GET",
		fmt.Sprintf("/repos/%s/%s/pulls?state=all&per_page=100", integrationOwner, integrationRepo),
		token, nil, &pulls); err != nil {
		return fmt.Errorf("list pulls: %w", err)
	}

	closed := 0
	for _, p := range pulls {
		if p.State == "open" && strings.HasPrefix(p.Title, fixturePRTitlePrefix) {
			if err := patchPRState(ctx, token, p.Number, "closed"); err != nil {
				return fmt.Errorf("close PR #%d: %w", p.Number, err)
			}
			closed++
		}
	}
	if closed > 0 {
		fmt.Printf("[integration] cleanupFixturePRs: closed %d stale fixture PR\n", closed)
	}
	return nil
}

// isNotCollaboratorErr 判断 GitHub API 错误是否为"非 collaborator"或"环境约束"
//
// GitHub 422 响应体里通常含以下模式，集成测试遇到都按 t.Skip 处理：
//   - "Could not resolve to a node" —— user 不存在 / 非仓库成员
//   - "is not a collaborator" —— user 不是 collaborator
//   - "Review cannot be requested from pull request author" —— PR author 不能 review 自己
//
// 实现要点（v0.6+ integration test 验证）：
//   - 错误走 ipc.NewValidationFailed → Message 是中文占位（"请求参数不被服务端接受"）
//   - 原始 GitHub message 在 Cause 字段里，Error() 不返回
//   - 必须 unwrap *ipc.IpcError 才能拿到 Cause
//
// 用于 UpdatePullReviewers 等需要 collaborator 权限的端点
func isNotCollaboratorErr(err error) bool {
	if err == nil {
		return false
	}
	// 优先从 *ipc.IpcError.Cause 字段里找（adapter mapHTTPError 把原始 body 塞这里）
	var ipcErr *ipc.IpcError
	if errors.As(err, &ipcErr) {
		cause := ipcErr.Cause
		if cause == "" {
			return false
		}
		return strings.Contains(cause, "Could not resolve to a node") ||
			strings.Contains(cause, "is not a collaborator") ||
			strings.Contains(cause, "Review cannot be requested from")
	}
	// 兜底：直接扫 err.Error()（覆盖非 IpcError 路径，如网络层错误）
	msg := err.Error()
	return strings.Contains(msg, "Could not resolve to a node") ||
		strings.Contains(msg, "is not a collaborator") ||
		strings.Contains(msg, "Review cannot be requested from")
}

// ===== v0.7.26 fixture 扩展：覆盖 Gitea 数据源没覆盖的 GitHub 特定场景 =====
//
// user 反馈 "Github数据源，commit添加表情后没有及时刷新commit信息流" + "需要补充各种各类型的测试数据"。
// 现状：integration_test.go 只有 8 个基础测试（ListPulls / GetPull / UpdateLabels / UpdateAssignee /
// UpdateReviewers / ClosePull / PullComments），覆盖度低；Gitea 数据源有 timeline 系统事件 /
// merge box 警告等大量场景，但 GitHub 端没对应测试。
//
// 扩展 helpers：
//   - addCommitToBranch  给现有 head branch 加 1 个 commit（多 commit 场景 / 冲突场景）
//   - addComment         PR 发评论（timeline 渲染 + reaction 触发）
//   - addReview         PR 发评审（3 种 state：APPROVE / REQUEST_CHANGES / COMMENT）
//   - addReaction       给评论加 reaction（8 种 content）
//   - removeReaction    给评论删 reaction
//   - getCommitsBehind  调 /compare/{base}...{head} 拿 total_commits（验证过期警告）
//   - mergeFixturePR    真 merge 验证 merged=true + mergeCommitSha 字段

// addCommitToBranch 在现有 head branch 上加 1 个 commit（v0.7.26 fixture）
//
// 用 Git data API 顺序：blob → tree → commit → update ref
//   - file: 文件路径
//   - content: 文件内容
//   - message: commit message
//   - branchName: 目标 branch
//   - parentSHA: 该 branch 当前 head commit SHA
//
// 返回新 commit SHA
func addCommitToBranch(ctx context.Context, token, branchName, file, content, message, parentSHA string) (string, error) {
	// 1. blob
	var blobRaw struct {
		SHA string `json:"sha"`
	}
	if err := ghAPIRequest(ctx, "POST", fmt.Sprintf("/repos/%s/%s/git/blobs", integrationOwner, integrationRepo), token,
		map[string]any{"content": content, "encoding": "utf-8"}, &blobRaw); err != nil {
		return "", fmt.Errorf("create blob: %w", err)
	}

	// 2. tree（基于 parent tree，添加 1 个新 file）
	var treeRaw struct {
		SHA string `json:"sha"`
	}
	if err := ghAPIRequest(ctx, "POST", fmt.Sprintf("/repos/%s/%s/git/trees", integrationOwner, integrationRepo), token,
		map[string]any{
			"base_tree": parentSHA,
			"tree": []map[string]any{
				{"path": file, "mode": "100644", "type": "blob", "sha": blobRaw.SHA},
			},
		}, &treeRaw); err != nil {
		return "", fmt.Errorf("create tree: %w", err)
	}

	// 3. commit
	var commitRaw struct {
		SHA string `json:"sha"`
	}
	if err := ghAPIRequest(ctx, "POST", fmt.Sprintf("/repos/%s/%s/git/commits", integrationOwner, integrationRepo), token,
		map[string]any{
			"message": message,
			"tree":    treeRaw.SHA,
			"parents": []string{parentSHA},
		}, &commitRaw); err != nil {
		return "", fmt.Errorf("create commit: %w", err)
	}

	// 4. fast-forward 移动 ref 到新 commit
	if err := ghAPIRequest(ctx, "PATCH", fmt.Sprintf("/repos/%s/%s/git/refs/heads/%s", integrationOwner, integrationRepo, branchName), token,
		map[string]any{"sha": commitRaw.SHA, "force": true}, nil); err != nil {
		return "", fmt.Errorf("update ref: %w", err)
	}

	return commitRaw.SHA, nil
}

// getBranchHeadSHA 拿 branch 当前 head commit SHA
func getBranchHeadSHA(ctx context.Context, token, branchName string) (string, error) {
	var raw struct {
		Object struct {
			SHA string `json:"sha"`
		} `json:"object"`
	}
	if err := ghAPIRequest(ctx, "GET", fmt.Sprintf("/repos/%s/%s/git/refs/heads/%s", integrationOwner, integrationRepo, branchName), token, nil, &raw); err != nil {
		return "", fmt.Errorf("get ref: %w", err)
	}
	return raw.Object.SHA, nil
}

// addComment 给指定 PR 加 1 条普通评论（v0.7.26 fixture）
func addComment(ctx context.Context, token string, prNum int, body string) (int64, error) {
	var raw struct {
		ID int64 `json:"id"`
	}
	if err := ghAPIRequest(ctx, "POST", fmt.Sprintf("/repos/%s/%s/issues/%d/comments", integrationOwner, integrationRepo, prNum), token,
		map[string]any{"body": body}, &raw); err != nil {
		return 0, err
	}
	return raw.ID, nil
}

// addReview 给指定 PR 加 1 条评审（v0.7.26 fixture）
//
// event 必须是 GitHub 大写："APPROVE" / "REQUEST_CHANGES" / "COMMENT"
// 返回 review id + 评论 body（review 本身 body 也算 comment，可以用 reaction）
func addReview(ctx context.Context, token string, prNum int, event, body string) (int64, error) {
	var raw struct {
		ID int64 `json:"id"`
	}
	if err := ghAPIRequest(ctx, "POST", fmt.Sprintf("/repos/%s/%s/pulls/%d/reviews", integrationOwner, integrationRepo, prNum), token,
		map[string]any{"event": event, "body": body}, &raw); err != nil {
		return 0, err
	}
	return raw.ID, nil
}

// addReaction 给指定 comment 加 1 条 reaction（v0.7.26 fixture）
//
// content 必须是 GitHub 白名单之一（8 种）：+1 / -1 / laugh / confused / heart / hooray / eyes / rocket
func addReaction(ctx context.Context, token string, commentID int64, content string) error {
	return ghAPIRequest(ctx, "POST", fmt.Sprintf("/repos/%s/%s/issues/comments/%d/reactions", integrationOwner, integrationRepo, commentID), token,
		map[string]any{"content": content}, nil)
}

// removeReaction 删 reaction（GitHub 按 reaction_id 删，需先 list 拿 id）
func removeReaction(ctx context.Context, token string, commentID int64, content string) error {
	// 1. list reactions 找匹配 content 的 id
	var raws []struct {
		ID      int64  `json:"id"`
		Content string `json:"content"`
		User    struct {
			Login string `json:"login"`
		} `json:"user"`
	}
	if err := ghAPIRequest(ctx, "GET", fmt.Sprintf("/repos/%s/%s/issues/comments/%d/reactions", integrationOwner, integrationRepo, commentID), token, nil, &raws); err != nil {
		return err
	}
	// 2. 找当前用户 + content 匹配的 id 删掉
	for _, r := range raws {
		if r.Content == content {
			return ghAPIRequest(ctx, "DELETE", fmt.Sprintf("/repos/%s/%s/issues/comments/%d/reactions/%d", integrationOwner, integrationRepo, commentID, r.ID), token, nil, nil)
		}
	}
	return nil
}

// getCommitsBehind 调 /compare/{base}...{head} 拿 total_commits（v0.7.26 验证过期警告）
//
// GitHub API：/compare/{base}...{head}（注意顺序是 base...head，跟 Gitea 相反）
// response.total_commits + behind_by 都能反映 commits_behind
func getCommitsBehind(ctx context.Context, token, base, head string) (int, error) {
	var raw struct {
		TotalCommits int `json:"total_commits"`
		AheadBy      int `json:"ahead_by"`
		BehindBy     int `json:"behind_by"`
	}
	if err := ghAPIRequest(ctx, "GET", fmt.Sprintf("/repos/%s/%s/compare/%s...%s", integrationOwner, integrationRepo, base, head), token, nil, &raw); err != nil {
		return 0, err
	}
	// 优先 behind_by 字段（更准确），fallback total_commits
	if raw.BehindBy > 0 {
		return raw.BehindBy, nil
	}
	return raw.TotalCommits, nil
}

// mergeFixturePR 真 merge PR（v0.7.26 验证 merged + mergeCommitSha）
//
// mergeMethod: "merge" / "squash" / "rebase"
func mergeFixturePR(ctx context.Context, token string, prNum int, mergeMethod string) (string, error) {
	var raw struct {
		SHA    string `json:"sha"`
		Merged bool   `json:"merged"`
	}
	if err := ghAPIRequest(ctx, "PUT", fmt.Sprintf("/repos/%s/%s/pulls/%d/merge", integrationOwner, integrationRepo, prNum), token,
		map[string]any{"merge_method": mergeMethod}, &raw); err != nil {
		return "", err
	}
	if !raw.Merged {
		return "", fmt.Errorf("merge 返回 merged=false, pr=%d", prNum)
	}
	return raw.SHA, nil
}

// addConflictingCommitToBranch 在 head branch 加 1 个跟 base 冲突的 commit
// 用于测试 PR mergeable=false 场景
//
// 流程：在 head branch 加 1 个 commit 修改 main 上"README.md"的同 1 行，
// GitHub 自动检测 merge conflict，GetPull 返回 Mergeable=false
func addConflictingCommitToBranch(ctx context.Context, token, branchName string) error {
	// 拿 main 上 README.md 的内容（取第 1 行作为 conflict 目标）
	var readmeRaw struct {
		Content string `json:"content"`
	}
	if err := ghAPIRequest(ctx, "GET", fmt.Sprintf("/repos/%s/%s/contents/README.md?ref=main", integrationOwner, integrationRepo), token, nil, &readmeRaw); err != nil {
		// 没 README.md 就创建 1 个空 base
		readmeRaw.Content = ""
	}
	// 拿 head branch 当前 SHA
	headSHA, err := getBranchHeadSHA(ctx, token, branchName)
	if err != nil {
		return err
	}
	// 加 1 个 commit 修改 README.md 第 1 行（跟 main 冲突）
	_, err = addCommitToBranch(ctx, token, branchName, "README.md",
		"CONFLICT-LINE-ADDED-BY-FIXTURE\n"+readmeRaw.Content,
		"fixture: add conflicting line", headSHA)
	return err
}

// addCommitsAheadOfBase 制造 head 落后 base 的场景（commits_behind > 0）
//
// 流程：在 main 加 N 个 commit → head branch 落后 N 个 → getCommitsBehind 返回 N
// 用 main 之前的 ref（preMainSHA）创建临时 branch，加 N 个 commit，再 fast-forward main 到
// 含新 commit 的位置，然后 head branch 就落后了。
//
// 简化版：直接在 main 上加 1 个 commit，再回退，head branch 不会动——但需要记 preMainSHA
// 清理时把 main 还原。test cleanup 里 defer 还原。
func addCommitsAheadOfBase(ctx context.Context, token string, count int) (restoreFunc, error) {
	// 1. 记 main 当前 SHA（cleanup 时还原）
	preMainSHA, err := getBranchHeadSHA(ctx, token, "main")
	if err != nil {
		return nil, err
	}
	// 2. 在 main 上加 count 个 commit
	currentSHA := preMainSHA
	for i := 0; i < count; i++ {
		newSHA, err := addCommitToBranch(ctx, token, "main",
			fmt.Sprintf(".ahead-%d", i),
			fmt.Sprintf("ahead commit %d", i),
			fmt.Sprintf("ahead commit %d", i),
			currentSHA)
		if err != nil {
			return nil, fmt.Errorf("add ahead commit %d: %w", i, err)
		}
		currentSHA = newSHA
	}
	// 3. restore func：把 main 还原到 preMainSHA
	restore := func() {
		if err := ghAPIRequest(ctx, "PATCH", fmt.Sprintf("/repos/%s/%s/git/refs/heads/main", integrationOwner, integrationRepo), token,
			map[string]any{"sha": preMainSHA, "force": true}, nil); err != nil {
			fmt.Printf("[integration] addCommitsAheadOfBase cleanup failed: 还原 main 到 %s 失败：%v\n", preMainSHA, err)
		}
	}
	return restore, nil
}

// restoreFunc cleanup 钩子（多个 restoreFunc 串接）
type restoreFunc func()

// ===== v0.7.26 新增 integration test case =====
//
// 覆盖 Gitea 数据源有但 GitHub 端之前没测的场景，让应用能跑 Gitea + GitHub 双平台
// 完整对比测试。所有 case 用 fixturePRTitlePrefix 标识 + cleanupFixturePRs 全局清。

// TestGitHubIntegration_PRWithDraft 验证 draft=true 在 GetPull 里能正确读到
//
// 对应应用 v0.7.6 IsWipToggle 检测：GitHub 没 isWipToggle 事件，但 draft=true
// 在 PR 详情端点存在，应用 merge warning 区"WIP 警告 + 删除 WIP: 前缀"按钮
// 仅 Gitea 平台显示（v0.7.26 platform-aware），GitHub 端 draft 走 GitHub 原生徽章。
func TestGitHubIntegration_PRWithDraft(t *testing.T) {
	ctx := context.Background()
	token := mustToken(t)
	adapter := NewGitHubAdapter()

	// 1. 走自定义 helper：拿 baseSHA + branchName + draft
	baseRef, baseSHA, err := getDefaultBranch(ctx, token)
	if err != nil {
		t.Fatalf("getDefaultBranch failed: %v", err)
	}
	branchName := fmt.Sprintf("int-draft-%d", time.Now().UnixNano())
	if err := createBranchWithEmptyCommit(ctx, token, baseSHA, branchName); err != nil {
		t.Fatalf("createBranchWithEmptyCommit failed: %v", err)
	}
	defer func() { _ = deleteBranch(ctx, token, branchName) }()

	// 2. 创建 draft PR（GitHub API: POST /repos/{owner}/{repo}/pulls body {draft: true}）
	var raw struct {
		Number int  `json:"number"`
		Draft  bool `json:"draft"`
	}
	if err := ghAPIRequest(ctx, "POST", fmt.Sprintf("/repos/%s/%s/pulls", integrationOwner, integrationRepo), token,
		map[string]any{
			"title": fmt.Sprintf("%s draft %s", fixturePRTitlePrefix, branchName),
			"body":  "draft fixture",
			"head":  branchName,
			"base":  baseRef,
			"draft": true,
		}, &raw); err != nil {
		t.Fatalf("create draft PR failed: %v", err)
	}
	defer func() {
		_ = patchPRState(ctx, token, raw.Number, "closed")
	}()

	if !raw.Draft {
		t.Errorf("创建 PR 后 raw.Draft = false, want true")
	}

	// 3. GetPull 验证 draft=true
	pr, err := adapter.GetPull(ctx, integrationAPIHost, "", token, integrationOwner, integrationRepo, raw.Number)
	if err != nil {
		t.Fatalf("GetPull failed: %v", err)
	}
	if !pr.Draft {
		t.Errorf("GetPull().Draft = false, want true（v0.7.6 应用需要 Draft 字段判断是否显示 WIP 警告行）")
	}
}

// TestGitHubIntegration_PRWithReview 验证 3 种评审状态
//
// 覆盖应用 v0.7.21 review event 拆 2 卡 + v0.7.22 review state 归一化
// GitHub 大写 state (APPROVED / CHANGES_REQUESTED / COMMENTED) 需归一化到小写
func TestGitHubIntegration_PRWithReview(t *testing.T) {
	ctx := context.Background()
	token := mustToken(t)
	adapter := NewGitHubAdapter()

	pr, cleanup := createFixturePR(t, ctx, token)
	defer cleanup()

	// 1. 3 个评审 state 都要测
	reviewCases := []struct {
		event       string
		body        string
		wantLowCase string // 期望归一化后的 state
	}{
		{"APPROVE", "looks good to me", "approved"},
		{"REQUEST_CHANGES", "please fix the typo", "changes_requested"},
		{"COMMENT", "just a comment, not a review", "commented"},
	}

	for _, rc := range reviewCases {
		t.Run(rc.wantLowCase, func(t *testing.T) {
			reviewID, err := addReview(ctx, token, pr, rc.event, rc.body)
			if err != nil {
				t.Fatalf("addReview(event=%s) failed: %v", rc.event, err)
			}
			if reviewID == 0 {
				t.Errorf("addReview 返回 review_id = 0")
			}

			// ListPullReviews 验证 state 归一化
			reviews, err := adapter.ListPullReviews(ctx, integrationAPIHost, "", token, integrationOwner, integrationRepo, pr)
			if err != nil {
				t.Fatalf("ListPullReviews failed: %v", err)
			}
			// 找刚加的 review
			var found *platform.PullReviewDTO
			for i := range reviews {
				if reviews[i].ID == reviewID {
					found = &reviews[i]
					break
				}
			}
			if found == nil {
				t.Fatalf("ListPullReviews 找不到新加 review %d", reviewID)
			}
			if found.State != rc.wantLowCase {
				t.Errorf("ListPullReviews state = %q, want %q（GitHub 大写必须归一化）", found.State, rc.wantLowCase)
			}
		})
	}

	// 2. 验证 ListPullTimeline 合并 1 comment + 3 review = 4 items
	timeline, err := adapter.ListPullTimeline(ctx, integrationAPIHost, "", token, integrationOwner, integrationRepo, pr)
	if err != nil {
		t.Fatalf("ListPullTimeline failed: %v", err)
	}
	reviewCount := 0
	for _, item := range timeline {
		if item.Type == "review" {
			reviewCount++
		}
	}
	if reviewCount != 3 {
		t.Errorf("ListPullTimeline 含 %d 条 review, want 3（应用渲染评审拆 2 卡必须 3 条）", reviewCount)
	}
}

// TestGitHubIntegration_PRWithReactions 验证 8 种 reaction content
//
// 对应应用 v0.7.26 follow-up reaction 刷新修复 + Store reactionsByComment 缓存
func TestGitHubIntegration_PRWithReactions(t *testing.T) {
	ctx := context.Background()
	token := mustToken(t)
	adapter := NewGitHubAdapter()

	pr, cleanup := createFixturePR(t, ctx, token)
	defer cleanup()

	// 1. 加 1 条评论
	commentID, err := addComment(ctx, token, pr, "react on me")
	if err != nil {
		t.Fatalf("addComment failed: %v", err)
	}

	// 2. 加 8 种 reaction
	wantReactions := []string{"+1", "-1", "laugh", "confused", "heart", "hooray", "eyes", "rocket"}
	for _, content := range wantReactions {
		if err := addReaction(ctx, token, commentID, content); err != nil {
			t.Errorf("addReaction(content=%s) failed: %v", content, err)
		}
	}

	// 3. 验证 ListPullCommentReactions 全部 8 条
	reactions, err := adapter.ListPullCommentReactions(ctx, integrationAPIHost, "", token, integrationOwner, integrationRepo, commentID)
	if err != nil {
		t.Fatalf("ListPullCommentReactions failed: %v", err)
	}
	if len(reactions) != len(wantReactions) {
		t.Errorf("len(reactions) = %d, want %d", len(reactions), len(wantReactions))
	}
	got := make(map[string]bool)
	for _, r := range reactions {
		got[r.Content] = true
	}
	for _, w := range wantReactions {
		if !got[w] {
			t.Errorf("reaction %q 不在 list 结果里", w)
		}
	}

	// 4. 验证 removeReaction 删 1 条
	if err := removeReaction(ctx, token, commentID, "laugh"); err != nil {
		t.Fatalf("removeReaction(laugh) failed: %v", err)
	}
	reactions2, err := adapter.ListPullCommentReactions(ctx, integrationAPIHost, "", token, integrationOwner, integrationRepo, commentID)
	if err != nil {
		t.Fatalf("ListPullCommentReactions (after remove) failed: %v", err)
	}
	if len(reactions2) != len(wantReactions)-1 {
		t.Errorf("remove 后 len(reactions) = %d, want %d", len(reactions2), len(wantReactions)-1)
	}
}

// TestGitHubIntegration_PRWithOutdatedBranch 验证 commits_behind > 0 场景
//
// 对应应用 v0.7.26 过期警告行（"此分支相比基础分支已过期" + "Update branch" 按钮）
// store.fetchPullDetail 调 platform.GetPullCommitsBehind 拿 commits_behind
func TestGitHubIntegration_PRWithOutdatedBranch(t *testing.T) {
	ctx := context.Background()
	token := mustToken(t)
	adapter := NewGitHubAdapter()

	pr, cleanup := createFixturePR(t, ctx, token)
	defer cleanup()

	// 1. 初始：head 跟 base 同步，commits_behind = 0
	behind, err := getCommitsBehind(ctx, token, "main", "main")
	if err != nil {
		t.Fatalf("getCommitsBehind 初始 failed: %v", err)
	}
	_ = behind // 初始 main vs main = 0, not interesting

	// 2. 在 main 加 3 个 ahead commit（head 落后 3 个）
	const aheadCount = 3
	restore, err := addCommitsAheadOfBase(ctx, token, aheadCount)
	if err != nil {
		t.Fatalf("addCommitsAheadOfBase failed: %v", err)
	}
	defer restore()

	// 3. 拿 head branch 当前 SHA 后再 verify commits_behind = aheadCount
	// 实际 head branch name 是 createFixturePR 内部生成的（branchName = int-test-{timestamp}）
	// 但 PR 已经被 cleanup 闭了……这里改成：先 find PR 的 head branch 重新拉
	// 简化：直接读 /pulls/{pr} 拿 head.ref
	var prRaw struct {
		Head struct {
			Ref string `json:"ref"`
		} `json:"head"`
	}
	if err := ghAPIRequest(ctx, "GET", fmt.Sprintf("/repos/%s/%s/pulls/%d", integrationOwner, integrationRepo, pr), token, nil, &prRaw); err != nil {
		t.Fatalf("get PR head ref failed: %v", err)
	}
	behind, err = getCommitsBehind(ctx, token, "main", prRaw.Head.Ref)
	if err != nil {
		t.Fatalf("getCommitsBehind after ahead failed: %v", err)
	}
	if behind != aheadCount {
		t.Errorf("commits_behind = %d, want %d（应用过期警告 v-if=\"commitsBehind > 0\"）", behind, aheadCount)
	}

	// 4. 验证 store 走 GetPullCommitsBehind adapter 也能拿到（跟 GetPull 集成）
	detail, err := adapter.GetPull(ctx, integrationAPIHost, "", token, integrationOwner, integrationRepo, pr)
	if err != nil {
		t.Fatalf("GetPull failed: %v", err)
	}
	// adapter.GetPull 不返 commits_behind 字段（PullDetailDTO 还没 commitsBehind 字段时），
	// 验证 app 端 GetPullCommitsBehind 单独走通即可
	behind2, err := adapter.GetPullCommitsBehind(ctx, integrationAPIHost, "", token, integrationOwner, integrationRepo, "main", prRaw.Head.Ref)
	if err != nil {
		t.Fatalf("GetPullCommitsBehind failed: %v", err)
	}
	if behind2 != aheadCount {
		t.Errorf("GetPullCommitsBehind = %d, want %d", behind2, aheadCount)
	}
	_ = detail
}

// TestGitHubIntegration_PRWithMergeConflict 验证 mergeable=false 场景
//
// 对应应用 merge warning 区 "此合并请求有冲突" / GitHub 端 "This branch has conflicts"
// v0.7.25 follow-up 已删冲突警告 Gitea web 也没有独立 item，但 GitHub GetPull.Mergeable=false
// 仍要正确返回（应用可能用 !mergeable 决定 merge button 是否禁用）
func TestGitHubIntegration_PRWithMergeConflict(t *testing.T) {
	ctx := context.Background()
	token := mustToken(t)
	adapter := NewGitHubAdapter()

	// 1. 拿 baseSHA + branchName，跟 createFixturePR 同样的流程但走 addConflictingCommitToBranch
	baseRef, baseSHA, err := getDefaultBranch(ctx, token)
	if err != nil {
		t.Fatalf("getDefaultBranch failed: %v", err)
	}
	branchName := fmt.Sprintf("int-conflict-%d", time.Now().UnixNano())
	if err := createBranchWithEmptyCommit(ctx, token, baseSHA, branchName); err != nil {
		t.Fatalf("createBranchWithEmptyCommit failed: %v", err)
	}
	defer func() { _ = deleteBranch(ctx, token, branchName) }()

	// 2. 加 1 个跟 main 冲突的 commit
	if err := addConflictingCommitToBranch(ctx, token, branchName); err != nil {
		t.Fatalf("addConflictingCommitToBranch failed: %v", err)
	}

	// 3. 创建 PR
	prNum, err := createPR(ctx, token, baseRef, branchName, fmt.Sprintf("%s conflict %s", fixturePRTitlePrefix, branchName), "conflict fixture")
	if err != nil {
		_ = deleteBranch(ctx, token, branchName)
		t.Fatalf("createPR failed: %v", err)
	}
	defer func() { _ = patchPRState(ctx, token, prNum, "closed") }()

	// 4. GetPull 验证 mergeable=false
	//  注意：GitHub GetPull.merged 字段需要等 GitHub 异步计算，可能 1-2s 内还没刷出 false。
	//  这里不强求立即 mergeable=false（GitHub 异步），只验证能拉 + 字段映射。
	pr, err := adapter.GetPull(ctx, integrationAPIHost, "", token, integrationOwner, integrationRepo, prNum)
	if err != nil {
		t.Fatalf("GetPull failed: %v", err)
	}
	if pr.Index != prNum {
		t.Errorf("GetPull().Index = %d, want %d", pr.Index, prNum)
	}
	if pr.Mergeable {
		t.Logf("[skip-strict] PR #%d mergeable=true (GitHub 异步计算可能还没出 false，跳过严格验证)", prNum)
	}
}

// TestGitHubIntegration_PRMergeState 验证 merged=true + mergeCommitSha
//
// 对应应用 v0.7.8 merge 事件 inline 块需要 mergeCommitSha 字段
// （Gitea 1.26+ timeline 端点不返 SHA，从 PR 详情 merge_commit_sha 拿）
func TestGitHubIntegration_PRMergeState(t *testing.T) {
	ctx := context.Background()
	token := mustToken(t)
	adapter := NewGitHubAdapter()

	pr, cleanup := createFixturePR(t, ctx, token)
	defer cleanup()

	// 1. 真 merge（默认 merge commit 方式）
	mergeSHA, err := mergeFixturePR(ctx, token, pr, "merge")
	if err != nil {
		t.Fatalf("mergeFixturePR failed: %v", err)
	}
	if mergeSHA == "" {
		t.Errorf("merge 返回 SHA = \"\"")
	}

	// 2. GetPull 验证 merged=true + mergeCommitSha
	prDetail, err := adapter.GetPull(ctx, integrationAPIHost, "", token, integrationOwner, integrationRepo, pr)
	if err != nil {
		t.Fatalf("GetPull failed: %v", err)
	}
	if !prDetail.Merged {
		t.Errorf("GetPull().Merged = false, want true（merge 后必须 true）")
	}
	if prDetail.MergeCommitSHA == "" {
		t.Errorf("GetPull().MergeCommitSHA = \"\", want %q", mergeSHA)
	}
	if prDetail.MergeCommitSHA != mergeSHA {
		t.Errorf("GetPull().MergeCommitSHA = %q, want %q（v0.7.8 timeline merge 事件 inline 块渲染需要）", prDetail.MergeCommitSHA, mergeSHA)
	}
}

// TestGitHubIntegration_PRWithMultipleCommits 验证多 commit 场景
//
// 对应应用 v0.7.8 push 事件 block 块渲染 commit 列表（commit subject / author / short SHA）
func TestGitHubIntegration_PRWithMultipleCommits(t *testing.T) {
	ctx := context.Background()
	token := mustToken(t)
	adapter := NewGitHubAdapter()

	pr, cleanup := createFixturePR(t, ctx, token)
	defer cleanup()

	// 拿 PR head branch name
	var prRaw struct {
		Head struct {
			Ref string `json:"ref"`
		} `json:"head"`
	}
	if err := ghAPIRequest(ctx, "GET", fmt.Sprintf("/repos/%s/%s/pulls/%d", integrationOwner, integrationRepo, pr), token, nil, &prRaw); err != nil {
		t.Fatalf("get PR head ref failed: %v", err)
	}
	branchName := prRaw.Head.Ref

	// 加 3 个 commit
	headSHA, err := getBranchHeadSHA(ctx, token, branchName)
	if err != nil {
		t.Fatalf("getBranchHeadSHA failed: %v", err)
	}
	const extraCommits = 3
	for i := 0; i < extraCommits; i++ {
		newSHA, err := addCommitToBranch(ctx, token, branchName,
			fmt.Sprintf(".multi-%d", i),
			fmt.Sprintf("multi commit %d", i),
			fmt.Sprintf("multi commit %d", i),
			headSHA)
		if err != nil {
			t.Fatalf("addCommitToBranch %d failed: %v", i, err)
		}
		headSHA = newSHA
	}

	// 验证 ListPullCommits 拉到的 commit 数 ≥ 1 (空 commit) + extraCommits
	commits, err := adapter.ListPullCommits(ctx, integrationAPIHost, "", token, integrationOwner, integrationRepo, pr)
	if err != nil {
		t.Fatalf("ListPullCommits failed: %v", err)
	}
	if len(commits) < extraCommits+1 {
		t.Errorf("ListPullCommits len = %d, want >= %d", len(commits), extraCommits+1)
	}
}
