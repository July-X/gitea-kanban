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
	d1, err := adapter.UpdatePullAssignee(ctx, integrationAPIHost, "", token, integrationOwner, integrationRepo, pr, user.Login)
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
	d2, err := adapter.UpdatePullAssignee(ctx, integrationAPIHost, "", token, integrationOwner, integrationRepo, pr, user.Login)
	if err != nil {
		t.Fatalf("UpdatePullAssignee(1→1 幂等) failed: %v", err)
	}
	if len(d2.Assignees) != 1 || d2.Assignees[0].Username != user.Login {
		t.Errorf("Step 2 返回 Assignees = %+v, want [%s]", d2.Assignees, user.Login)
	}

	// ===== Step 3: 1 → 0（清空）=====
	d3, err := adapter.UpdatePullAssignee(ctx, integrationAPIHost, "", token, integrationOwner, integrationRepo, pr, "")
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
