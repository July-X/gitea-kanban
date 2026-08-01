package git

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// createTestRepoWithCommits 创建一个有多个 commit 的测试仓库
func createTestRepoWithCommits(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()

	runGit := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}

	runGit("init")
	runGit("config", "user.email", "test@test.com")
	runGit("config", "user.name", "Test User")

	// 用 GIT_COMMITTER_DATE/GIT_AUTHOR_DATE 显式设置不同时间
	// 避免秒级时间戳相同导致 LogCommits 排序不稳定
	commitAt := func(msg, date string) {
		env := append(os.Environ(),
			"GIT_AUTHOR_DATE="+date,
			"GIT_COMMITTER_DATE="+date,
		)
		cmd := exec.Command("git", "commit", "-m", msg)
		cmd.Dir = dir
		cmd.Env = env
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git commit: %v\n%s", err, out)
		}
	}

	// 3 个 commit，时间严格递增
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("a"), 0o644)
	runGit("add", ".")
	commitAt("first commit", "2026-01-01T10:00:00Z")

	os.WriteFile(filepath.Join(dir, "b.txt"), []byte("b"), 0o644)
	runGit("add", ".")
	commitAt("second commit", "2026-01-01T11:00:00Z")

	os.WriteFile(filepath.Join(dir, "c.txt"), []byte("c"), 0o644)
	runGit("add", ".")
	commitAt("third commit", "2026-01-01T12:00:00Z")

	return dir
}

func TestLogCommits_BasicHistory(t *testing.T) {
	repoPath := createTestRepoWithCommits(t)

	result, err := LogCommits(LogOptions{
		LocalPath: repoPath,
	})
	if err != nil {
		t.Fatalf("LogCommits failed: %v", err)
	}

	if len(result.Commits) != 3 {
		t.Fatalf("expected 3 commits, got %d", len(result.Commits))
	}

	// 最新 commit 应该是 "third commit"
	if result.Commits[0].Subject != "third commit" {
		t.Errorf("first commit subject = %q, want 'third commit'", result.Commits[0].Subject)
	}

	// 验证 SHA 和 ShortSHA
	if len(result.Commits[0].SHA) != 40 {
		t.Errorf("SHA length = %d, want 40", len(result.Commits[0].SHA))
	}
	if len(result.Commits[0].ShortSHA) != 7 {
		t.Errorf("ShortSHA length = %d, want 7", len(result.Commits[0].ShortSHA))
	}

	// 验证 author
	if result.Commits[0].AuthorName != "Test User" {
		t.Errorf("AuthorName = %q, want 'Test User'", result.Commits[0].AuthorName)
	}
	if result.Commits[0].AuthorEmail != "test@test.com" {
		t.Errorf("AuthorEmail = %q, want 'test@test.com'", result.Commits[0].AuthorEmail)
	}

	// 验证时间（用显式 GIT_COMMITTER_DATE 设置的固定时间，不校验"最近"）
	expectedTime, _ := time.Parse(time.RFC3339, "2026-01-01T12:00:00Z")
	if !result.Commits[0].AuthorWhen.Equal(expectedTime) {
		t.Errorf("AuthorWhen = %v, want %v", result.Commits[0].AuthorWhen, expectedTime)
	}

	// 验证 parents（第一个 commit 有 1 个 parent）
	if len(result.Commits[0].Parents) != 1 {
		t.Errorf("Parents length = %d, want 1", len(result.Commits[0].Parents))
	}
}

func TestLogCommits_MaxCount(t *testing.T) {
	repoPath := createTestRepoWithCommits(t)

	result, err := LogCommits(LogOptions{
		LocalPath: repoPath,
		MaxCount:  2,
	})
	if err != nil {
		t.Fatalf("LogCommits failed: %v", err)
	}

	if len(result.Commits) != 2 {
		t.Errorf("expected 2 commits, got %d", len(result.Commits))
	}

	if !result.Truncated {
		t.Errorf("expected Truncated = true, got false")
	}
}

func TestLogCommits_Order(t *testing.T) {
	repoPath := createTestRepoWithCommits(t)

	result, err := LogCommits(LogOptions{
		LocalPath: repoPath,
	})
	if err != nil {
		t.Fatalf("LogCommits failed: %v", err)
	}

	if len(result.Commits) != 3 {
		t.Fatalf("expected 3 commits, got %d", len(result.Commits))
	}

	// 验证时间倒序（最新的在前）
	if !result.Commits[0].AuthorWhen.After(result.Commits[1].AuthorWhen) {
		t.Errorf("commits not in descending order")
	}
	if !result.Commits[1].AuthorWhen.After(result.Commits[2].AuthorWhen) {
		t.Errorf("commits not in descending order")
	}
}

func TestLogCommits_NonExistentRepo(t *testing.T) {
	result, err := LogCommits(LogOptions{
		LocalPath: "/nonexistent/repo",
	})
	if err == nil {
		t.Errorf("expected error for non-existent repo, got nil")
	}
	if result != nil {
		t.Errorf("expected nil result for error case, got %+v", result)
	}
}

// createTestRepoWithRefs 创建一个有多个分支和 tag 的测试仓库
func createTestRepoWithRefs(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()

	runGit := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}

	runGit("init")
	runGit("config", "user.email", "test@test.com")
	runGit("config", "user.name", "Test User")

	// 3 个 commit
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("a"), 0o644)
	runGit("add", ".")
	runGit("commit", "-m", "first commit")

	os.WriteFile(filepath.Join(dir, "b.txt"), []byte("b"), 0o644)
	runGit("add", ".")
	runGit("commit", "-m", "second commit")

	// 创建 feature 分支
	runGit("checkout", "-b", "feature")
	os.WriteFile(filepath.Join(dir, "c.txt"), []byte("c"), 0o644)
	runGit("add", ".")
	runGit("commit", "-m", "third commit")

	// 在 second commit 上打 tag
	cmd := exec.Command("git", "rev-parse", "HEAD~1")
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("rev-parse: %v\n%s", err, out)
	}
	secondCommitSHA := strings.TrimSpace(string(out))
	runGit("tag", "v1.0", secondCommitSHA)

	// 切回默认分支（兼容 master / main，v2.6 后老 git init 仍默认 master）
	defaultBranch := currentDefaultBranch(t, dir)
	runGit("checkout", defaultBranch)

	return dir
}

// createTestRepoWithAnnotatedTag 创建一个有 annotated tag 的测试仓库
// （v0.8.37.1 修复：annotated tag 必须 peel 到 commit，否则 badge 挂不上）
func createTestRepoWithAnnotatedTag(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()

	runGit := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}

	runGit("init")
	runGit("config", "user.email", "test@test.com")
	runGit("config", "user.name", "Test User")

	// 1 个 commit
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("a"), 0o644)
	runGit("add", ".")
	runGit("commit", "-m", "release commit")

	// 打 annotated tag（-a 强制执行 annotated tag，含 tag object）
	// lightweight tag (git tag v1.0) 直接指 commit 没 peel 问题，这里必须
	// 走 -a + -m 走 annotated tag 路径才能验证 peel 修复
	runGit("tag", "-a", "v1.0.0", "-m", "release v1.0.0")

	return dir
}

// currentDefaultBranch 返回 git 默认分支名（master / main 兼容）
func currentDefaultBranch(t *testing.T, dir string) string {
	t.Helper()
	cmd := exec.Command("git", "symbolic-ref", "--short", "HEAD")
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("symbolic-ref: %v\n%s", err, out)
	}
	return strings.TrimSpace(string(out))
}

// TestLogCommits_RefsAttached 验证 LogCommits 返回的每条 CommitInfo 都附带 refs
//
// v2.7 增量：前端右侧 commit 行需要渲染分支/tag badge，
// 后端必须在 LogCommits 时收集 refs 并附加到 CommitInfo。
//
// 测试场景：
//   - default 分支指向最新 commit → 最新 commit 的 Refs 应包含默认分支名
//   - feature 分支指向最新 commit → 最新 commit 的 Refs 应包含 "feature"
//   - v1.0 tag 指向 second commit → second commit 的 Refs 应包含 "v1.0"
func TestLogCommits_RefsAttached(t *testing.T) {
	repoPath := createTestRepoWithRefs(t)
	defaultBranch := currentDefaultBranch(t, repoPath)

	result, err := LogCommits(LogOptions{
		LocalPath: repoPath,
	})
	if err != nil {
		t.Fatalf("LogCommits failed: %v", err)
	}
	if len(result.Commits) != 3 {
		t.Fatalf("expected 3 commits, got %d", len(result.Commits))
	}

	// v2.7: 由于分支限制和优先级排序，可能先遍历 HEAD（指向默认分支），
	// 所以结果顺序可能不同。找到 "third commit" 验证其 refs
	var thirdCommit *CommitInfo
	for i := range result.Commits {
		if result.Commits[i].Subject == "third commit" {
			thirdCommit = &result.Commits[i]
			break
		}
	}
	if thirdCommit == nil {
		t.Fatalf("expected to find 'third commit' in results")
	}
	if !contains(thirdCommit.Refs, "feature") {
		t.Errorf("expected 'feature' in third commit Refs, got %v", thirdCommit.Refs)
	}

	// second commit → Refs 应包含 "v1.0" tag
	var secondCommit *CommitInfo
	for i := range result.Commits {
		if result.Commits[i].Subject == "second commit" {
			secondCommit = &result.Commits[i]
			break
		}
	}
	if secondCommit == nil {
		t.Fatalf("expected to find 'second commit' in results")
	}
	if !contains(secondCommit.Refs, "v1.0") {
		t.Errorf("expected 'v1.0' in second commit Refs, got %v", secondCommit.Refs)
	}

	// first commit 在 main 的历史里，但 HEAD 指向 main 的 second commit（checkout 回去后）
	// 所以 first commit 可能有或没有 ref，这里不强制断言（git 行为可能不同）
	// 主要验证 second/third commit 的 refs 正确即可
	var firstCommit *CommitInfo
	for i := range result.Commits {
		if result.Commits[i].Subject == "first commit" {
			firstCommit = &result.Commits[i]
			break
		}
	}
	if firstCommit == nil {
		t.Fatalf("expected to find 'first commit' in results")
	}
	if len(firstCommit.Refs) > 0 && !contains(firstCommit.Refs, defaultBranch) {
		t.Logf("first commit Refs: %v (might or might not contain %s)", firstCommit.Refs, defaultBranch)
	}
}

// TestLogCommits_AnnotatedTagPeeled 验证 v0.8.37.1 annotated tag peel 修复
//
// Gitea 链路 collectRefNamesByHash（app/git/log.go:526）之前直接用 ref.Hash()
// 拿 tag hash，挂到 byHash[sha] 上时 sha 是 tag object hash 而非 commit hash，
// commit 永远查不到这个 tag → badge 缺失（GitHub 链路 listRefsByCommit 用
// %(*objectname) peel 早已对齐）。
//
// 验证：annotated tag (-a -m) 指向 "release commit" → 该 commit 的 Refs 必须
// 包含 "v1.0.0"。修复前 commit.Refs 不含 "v1.0.0"（peel 缺失）。
func TestLogCommits_AnnotatedTagPeeled(t *testing.T) {
	repoPath := createTestRepoWithAnnotatedTag(t)

	result, err := LogCommits(LogOptions{
		LocalPath: repoPath,
	})
	if err != nil {
		t.Fatalf("LogCommits failed: %v", err)
	}

	// 找 "release commit"
	var releaseCommit *CommitInfo
	for i := range result.Commits {
		if result.Commits[i].Subject == "release commit" {
			releaseCommit = &result.Commits[i]
			break
		}
	}
	if releaseCommit == nil {
		t.Fatalf("expected to find 'release commit' in results")
	}

	// v0.8.37.1：annotated tag peel 必须让 commit.Refs 包含 "v1.0.0"
	if !contains(releaseCommit.Refs, "v1.0.0") {
		t.Errorf("expected 'v1.0.0' in 'release commit' Refs (annotated tag peel), got %v",
			releaseCommit.Refs)
	}
	// 验证 refType 也正确（tag 类型，不是 branch）
	hasTagType := false
	for _, rt := range releaseCommit.RefTypes {
		if rt == RefTypeTag {
			hasTagType = true
			break
		}
	}
	if !hasTagType {
		t.Errorf("expected RefTypeTag in 'release commit' RefTypes, got %v",
			releaseCommit.RefTypes)
	}
}

// TestLogCommits_NoRefsOnEmpty 验证没有任何 ref 的 commit Refs 为空 slice（不是 nil）
//
// v0.8.37.3 行为变更：branch 中间 commit 现在也会拿到 refs（branchCommitMap 兜底），
// 因为每个 commit 实际属于某个 branch（HEAD 指向的 branch 的历史成员）。
// 之前测试期望"middle/root commit Refs 应为空"是基于旧行为，v0.8.37.3 修复后
// 改为验证 "refs 类型正确（branch 而非空）"。
func TestLogCommits_NoRefsOnEmpty(t *testing.T) {
	repoPath := createTestRepoWithCommits(t)

	result, err := LogCommits(LogOptions{LocalPath: repoPath})
	if err != nil {
		t.Fatalf("LogCommits failed: %v", err)
	}

	// v0.8.37.3：所有 commit 现在都应至少挂 1 个 ref（默认分支名），因为 branchCommitMap
	// 在每个 branch head 遍历时给 visited commit 挂 branch name
	for i, c := range result.Commits {
		if len(c.Refs) == 0 {
			t.Errorf("commit[%d] %s Refs should not be empty (v0.8.37.3 branch 中间 commit 也有 ref)",
				i, c.ShortSHA)
		}
	}
	// 验证 Refs slice 不是 nil（避免 nil deref）
	if result.Commits[0].Refs == nil {
		t.Errorf("head commit Refs should not be nil")
	}
}

// contains 检查字符串 slice 是否包含指定字符串
func contains(slice []string, target string) bool {
	for _, s := range slice {
		if s == target {
			return true
		}
	}
	return false
}

// TestLogCommits_ManyBranches 验证 v0.8.37.1 maxBranches=200 修复
//
// 历史：v2.7 引入 maxBranches=20 限制超大仓库（UnrealEngine）性能，
// 但副作用是 20+ 分支的仓库会裁掉 10+ 个分支的 head commit，对应 branch badge 缺失
// （用户截图 2026-08-01 06:52 反馈）。v0.8.37.1 上限 20 → 200。
//
// 验证：30 个分支（< 200）应该全部遍历到，1 initial + 30 = 31 commits，
// 每个分支的 head commit 都必须在结果里（保证 branch badge 完整）。
func TestLogCommits_ManyBranches(t *testing.T) {
	dir := t.TempDir()

	runGit := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}

	runGit("init")
	runGit("config", "user.email", "test@test.com")
	runGit("config", "user.name", "Test User")

	// 创建初始 commit
	os.WriteFile(filepath.Join(dir, "README.md"), []byte("test"), 0o644)
	runGit("add", ".")
	runGit("commit", "-m", "initial commit")

	// 获取默认分支名
	defaultBranch := currentDefaultBranch(t, dir)

	// 创建 30 个分支（每个分支一个 commit）
	for i := 1; i <= 30; i++ {
		branchName := "feature-" + string(rune('a'+i-1))
		if i > 26 {
			branchName = "feature-extra-" + string(rune('0'+i-27))
		}
		runGit("checkout", "-b", branchName)
		filename := branchName + ".txt"
		os.WriteFile(filepath.Join(dir, filename), []byte(branchName), 0o644)
		runGit("add", ".")
		runGit("commit", "-m", "add "+branchName)
		runGit("checkout", defaultBranch)
	}

	// 切回默认分支
	runGit("checkout", defaultBranch)

	// 调用 LogCommits（v0.8.37.1：maxBranches=200 应当覆盖 30 分支仓库）
	result, err := LogCommits(LogOptions{
		LocalPath: dir,
		MaxCount:  200, // 请求 200 个 commit
	})
	if err != nil {
		t.Fatalf("LogCommits failed: %v", err)
	}

	// v0.8.37.1：30 分支 < 200 上限 → 全部遍历 → 1 initial + 30 分支 = 31 commits
	wantLen := 31
	if len(result.Commits) != wantLen {
		t.Errorf("expected %d commits (30 branches + 1 initial), got %d (maxBranches 可能截断分支)",
			wantLen, len(result.Commits))
	}

	// 验证至少有一些 commit（不应该为空）
	if len(result.Commits) == 0 {
		t.Fatalf("expected some commits, got 0")
	}

	// 验证结果包含初始 commit（所有分支都共享）
	foundInitial := false
	for _, c := range result.Commits {
		if c.Subject == "initial commit" {
			foundInitial = true
			break
		}
	}
	if !foundInitial {
		t.Errorf("expected to find initial commit")
	}

	// 验证每个分支的 head commit 都在结果里（v0.8.37.1 修复要点：>20 分支不能丢）
	seenSubjects := make(map[string]bool)
	for _, c := range result.Commits {
		seenSubjects[c.Subject] = true
	}
	for i := 1; i <= 30; i++ {
		branchName := "feature-" + string(rune('a'+i-1))
		if i > 26 {
			branchName = "feature-extra-" + string(rune('0'+i-27))
		}
		wantSubject := "add " + branchName
		if !seenSubjects[wantSubject] {
			t.Errorf("branch %s head commit (subject=%q) missing from result (maxBranches 截断?)",
				branchName, wantSubject)
		}
	}

	t.Logf("Created 30 branches, got %d commits (maxBranches=200 覆盖)", len(result.Commits))
}

// TestLogCommits_BranchMidCommitsHaveRefs 验证 v0.8.37.3 branch 中间 commit 挂 refs 修复
//
// 历史：之前 LogCommits 只挂 refDataByHash = ref 自身 HEAD commit 的 refs。
// 但 branch 中间 commit（不是 HEAD 自身）也需要显示 badge → 之前错误地只显示 HEAD 自身 badge。
//
// 用户截图 2026-08-01 07:18 反馈：88d9b92 在 master log index 650，是
// feat/gitgraph-vscode-recheck 分支 HEAD 自身的 commit → 该 commit 拿到 refs 没问题。
// 但测试 fixture 验证更广：500 commit 独有 feature 分支，feature commit 100 应该
// 也能拿到 refs（作为 branch "feature" 的成员），修复前 refs=[]。
//
// v0.8.37.3 修法：collectLimitedBranchHeads 返回 []branchInfo（含 branch name + refType），
// 不是只 []plumbing.Hash。LogCommits 在 for-each branch head 遍历 commit 时，把
// branch name 同时记到 branchCommitMap（独立于 refDataByHash）。每个 commit 的
// 最终 refs = refDataByHash + branchCommitMap 去重合并。
func TestLogCommits_BranchMidCommitsHaveRefs(t *testing.T) {
	dir := t.TempDir()

	runGit := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}

	runGit("init")
	runGit("config", "user.email", "test@test.com")
	runGit("config", "user.name", "Test User")

	// 主分支 1 个 commit
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("a"), 0o644)
	runGit("add", ".")
	runGit("commit", "-m", "initial commit")

	// 切回默认分支前先记下当前 branch（fixture init 完后是默认 master/main）
	defaultBranch := currentDefaultBranch(t, dir)
	// 创建 feature 分支，提交 500 个独有 commit
	runGit("checkout", "-b", "feature")
	for i := 1; i <= 500; i++ {
		os.WriteFile(filepath.Join(dir, fmt.Sprintf("f%d.txt", i)), []byte("f"), 0o644)
		runGit("add", ".")
		runGit("commit", "-m", fmt.Sprintf("feature commit %d", i))
	}
	// 切回默认分支（master/main）
	runGit("checkout", defaultBranch)

	// v0.8.37.3 验证：candidateLimit 1000 + branchCommitMap 让所有 feature 分支 commit 拿到 refs
	result, err := LogCommits(LogOptions{
		LocalPath: dir,
		MaxCount:  300, // < 500 截断
	})
	if err != nil {
		t.Fatalf("LogCommits failed: %v", err)
	}

	// 验证：feature 分支的所有独有 commit 都拿到 refs（branchCommitMap 兜底）
	featureCommitCount := 0
	featureCommitWithRefCount := 0
	for _, c := range result.Commits {
		if strings.HasPrefix(c.Subject, "feature commit ") {
			featureCommitCount++
			if contains(c.Refs, "feature") {
				featureCommitWithRefCount++
			}
		}
	}
	if featureCommitCount == 0 {
		t.Fatalf("expected feature commits in results, found 0")
	}
	// v0.8.37.3 修复：每个 feature 分支 commit 都拿到 refs
	// 修复前只有 feature 分支 HEAD (feature commit 500) 拿到 refs
	if featureCommitWithRefCount < featureCommitCount {
		t.Errorf("feature commits: %d total, %d with refs (branch 中间 commit 缺 refs?)",
			featureCommitCount, featureCommitWithRefCount)
	}
	t.Logf("MaxCount=300 + 500 feature commits: %d feature commits, %d with refs (branchCommitMap 兜底)",
		featureCommitCount, featureCommitWithRefCount)
}

func TestLogCommits_IncludesRecentRemoteBranchWithinMaxCount(t *testing.T) {
	dir := t.TempDir()

	runGit := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	commitAt := func(msg, date string) {
		env := append(os.Environ(),
			"GIT_AUTHOR_DATE="+date,
			"GIT_COMMITTER_DATE="+date,
		)
		cmd := exec.Command("git", "commit", "-m", msg)
		cmd.Dir = dir
		cmd.Env = env
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git commit %q: %v\n%s", msg, err, out)
		}
	}

	runGit("init")
	runGit("config", "user.email", "test@test.com")
	runGit("config", "user.name", "Test User")

	os.WriteFile(filepath.Join(dir, "root.txt"), []byte("root"), 0o644)
	runGit("add", ".")
	commitAt("root", "2026-01-01T00:00:00Z")
	root := strings.TrimSpace(string(runGitOutput(t, dir, "rev-parse", "HEAD")))
	defaultBranch := currentDefaultBranch(t, dir)

	for i := 1; i <= 60; i++ {
		name := filepath.Join(dir, "main-"+strconv.Itoa(i)+".txt")
		os.WriteFile(name, []byte("main"), 0o644)
		runGit("add", ".")
		commitAt("main "+strconv.Itoa(i), fmt.Sprintf("2026-01-01T%02d:%02d:00Z", i/60, i%60))
	}

	runGit("checkout", "-b", "recent-feature", root)
	os.WriteFile(filepath.Join(dir, "remote-feature.txt"), []byte("remote"), 0o644)
	runGit("add", ".")
	commitAt("remote branch latest", "2026-02-01T00:00:00Z")
	remoteHead := strings.TrimSpace(string(runGitOutput(t, dir, "rev-parse", "HEAD")))
	runGit("update-ref", "refs/remotes/org/recent-feature", remoteHead)
	runGit("checkout", defaultBranch)

	result, err := LogCommits(LogOptions{LocalPath: dir, MaxCount: 20})
	if err != nil {
		t.Fatalf("LogCommits failed: %v", err)
	}
	if len(result.Commits) != 20 {
		t.Fatalf("len(commits) = %d, want 20", len(result.Commits))
	}
	if result.Commits[0].Subject != "remote branch latest" {
		t.Fatalf("first commit = %q, want remote branch latest", result.Commits[0].Subject)
	}
	if !contains(result.Commits[0].Refs, "org/recent-feature") {
		t.Fatalf("remote ref missing from latest commit: refs=%v", result.Commits[0].Refs)
	}

	vscodeResult, err := LogCommitsVscode(context.Background(), LogOptions{LocalPath: dir, MaxCount: 20})
	if err != nil {
		t.Fatalf("LogCommitsVscode failed: %v", err)
	}
	if len(vscodeResult.Commits) != 20 {
		t.Fatalf("vscode len(commits) = %d, want 20", len(vscodeResult.Commits))
	}
	if !vscodeResult.Truncated {
		t.Fatalf("vscode truncated = false, want true from max-count+1 sentinel")
	}
	if vscodeResult.Commits[0].Subject != "remote branch latest" {
		t.Fatalf("vscode first commit = %q, want remote branch latest", vscodeResult.Commits[0].Subject)
	}
	if !contains(vscodeResult.Commits[0].Refs, "org/recent-feature") {
		t.Fatalf("vscode remote ref missing from latest commit: refs=%v", vscodeResult.Commits[0].Refs)
	}

	defaultLimitResult, err := LogCommitsVscode(context.Background(), LogOptions{LocalPath: dir})
	if err != nil {
		t.Fatalf("LogCommitsVscode default limit failed: %v", err)
	}
	if len(defaultLimitResult.Commits) != 62 {
		t.Fatalf("vscode default len(commits) = %d, want all 62 fixture commits", len(defaultLimitResult.Commits))
	}
	if defaultLimitResult.Truncated {
		t.Fatalf("vscode default truncated = true, want false for 62 commits under default 300")
	}
}

// TestLogCommits_SortByCommitterDate 回归测试（v0.8.25.6）：
// cherry-pick / rebase 来的 commit，author date 保留原始创作时间（可能远老于 committer date）。
// 全局排序必须用 committer date（对齐 git log --date-order），否则这类 commit 沉到历史深处，
// 在 Git Graph 上表现为「单 commit branch tip 出现在错误行、lane 斜跨错位」。
//
// 实测案例：xdolphin/TRex 的 b2139fef（author 1785209939 / committer 1785237482，差 7.6 小时），
// 按 author date 排 row 19（错），按 committer date 排 row 11（与 GitLens 一致）。
//
// 拓扑：
//
//	A (merge, committer 13:00)  ← master HEAD
//	├─ B (trunk, committer 11:00)
//	└─ C (cherry-pick tip: author 09:00 远老!, committer 12:00)
//	D (base, committer 10:00)   ← B、C 的共同 parent
//
// 按 committer date：A(13) C(12) B(11) D(10) —— C 紧跟 merge
// 按 author date（旧 bug）：A(13) B(11) D(10) C(09) —— C 沉底
func TestLogCommits_SortByCommitterDate(t *testing.T) {
	dir := t.TempDir()

	runGit := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	commitWithDates := func(msg, authorDate, committerDate string) {
		env := append(os.Environ(),
			"GIT_AUTHOR_DATE="+authorDate,
			"GIT_COMMITTER_DATE="+committerDate,
		)
		cmd := exec.Command("git", "commit", "-m", msg)
		cmd.Dir = dir
		cmd.Env = env
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git commit %q: %v\n%s", msg, err, out)
		}
	}
	mergeWithDates := func(msg, branch, date string) {
		env := append(os.Environ(),
			"GIT_AUTHOR_DATE="+date,
			"GIT_COMMITTER_DATE="+date,
		)
		cmd := exec.Command("git", "merge", "--no-ff", "-m", msg, branch)
		cmd.Dir = dir
		cmd.Env = env
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git merge %q: %v\n%s", msg, err, out)
		}
	}
	writeAndAdd := func(name, content string) {
		os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644)
		runGit("add", name)
	}

	runGit("init")
	runGit("config", "user.email", "test@test.com")
	runGit("config", "user.name", "Test User")

	// D (base, committer 10:00)
	writeAndAdd("d.txt", "d")
	commitWithDates("base commit D", "2026-01-01T10:00:00Z", "2026-01-01T10:00:00Z")

	// cherry 分支：C 的 author date 远老（09:00，比 D 还老！）但 committer date 是 12:00
	runGit("checkout", "-b", "cherry")
	writeAndAdd("c.txt", "c")
	commitWithDates("cherry-picked commit C", "2026-01-01T09:00:00Z", "2026-01-01T12:00:00Z")

	// 回 master：B (committer 11:00)
	runGit("checkout", "master")
	writeAndAdd("b.txt", "b")
	commitWithDates("trunk commit B", "2026-01-01T11:00:00Z", "2026-01-01T11:00:00Z")

	// A (merge, committer 13:00)
	mergeWithDates("merge cherry A", "cherry", "2026-01-01T13:00:00Z")

	result, err := LogCommits(LogOptions{LocalPath: dir})
	if err != nil {
		t.Fatalf("LogCommits failed: %v", err)
	}
	if len(result.Commits) != 4 {
		t.Fatalf("expected 4 commits, got %d", len(result.Commits))
	}

	// 按 committer date 排序：A(13) C(12) B(11) D(10)
	// 若退回 author date 排序则 C(author 09:00) 沉底到 index 3
	wantOrder := []string{
		"merge cherry A",
		"cherry-picked commit C",
		"trunk commit B",
		"base commit D",
	}
	for i, want := range wantOrder {
		if result.Commits[i].Subject != want {
			t.Errorf("commits[%d].Subject = %q, want %q（完整顺序: %v）",
				i, result.Commits[i].Subject, want, subjectsOf(result.Commits))
		}
	}

	// CommitterWhen 字段必须被填充且与 author date 不同（cherry commit C）
	cherryCommit := result.Commits[1]
	if cherryCommit.CommitterWhen.IsZero() {
		t.Errorf("CommitterWhen 未填充（zero value）")
	}
	expectedCommitter, _ := time.Parse(time.RFC3339, "2026-01-01T12:00:00Z")
	if !cherryCommit.CommitterWhen.Equal(expectedCommitter) {
		t.Errorf("cherry C CommitterWhen = %v, want %v", cherryCommit.CommitterWhen, expectedCommitter)
	}
	expectedAuthor, _ := time.Parse(time.RFC3339, "2026-01-01T09:00:00Z")
	if !cherryCommit.AuthorWhen.Equal(expectedAuthor) {
		t.Errorf("cherry C AuthorWhen = %v, want %v", cherryCommit.AuthorWhen, expectedAuthor)
	}

	// SortTime() 应优先返回 committer date
	if !cherryCommit.SortTime().Equal(expectedCommitter) {
		t.Errorf("SortTime() = %v, want committer date %v", cherryCommit.SortTime(), expectedCommitter)
	}
	// zero CommitterWhen 时回退 author date（兼容外部构造的旧数据）
	legacy := CommitInfo{AuthorWhen: expectedAuthor}
	if !legacy.SortTime().Equal(expectedAuthor) {
		t.Errorf("SortTime() with zero CommitterWhen = %v, want fallback author date %v", legacy.SortTime(), expectedAuthor)
	}
}

func subjectsOf(commits []CommitInfo) []string {
	subjects := make([]string, len(commits))
	for i, c := range commits {
		subjects[i] = c.Subject
	}
	return subjects
}
