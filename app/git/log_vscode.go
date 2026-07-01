package git

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// v3.9 修复：%ct（committer date）→ %at（author date）
// 旧版用 %ct 导致 rebase/cherry-pick/force-push 后所有 commit 显示同一次操作时间
// （committer date 在 rebase 等操作后会被更新为操作时间，author date 保留原始创作时间）
// 对齐 go-git 路径（log.go）的 c.Author.When（author date）+ vscode-git-graph 默认展示 author date
const vscodeLogFormat = "%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s"
const defaultVscodeInitialLoadCommits = 300

// UNCOMMITTED_HASH 虚拟 commit 哨兵（对齐 vscode-git-graph 的 '*'）。
//
// 真实 commit hash 永远是 40 字符 hex（小写 a-f + 0-9），与 '*' 不会碰撞。
// 用作 UNCOMMITTED 虚拟 commit 的 SHA，让 lane 布局把"未完成区"当作 row 0 接到
// 本地 HEAD 之上，再在 GraphResult 里把对应的 IsCommitted 写成 false 触发灰色样式。
//
// 触发语义对齐 vscode-git-graph 的 `commits[0].hash === UNCOMMITTED` 模式，
// 但因为我们 NoCheckout 模式没有 worktree，`git status --porcelain` 不可用，
// 改为「local HEAD 落后于 origin/<defaultBranch>」——
// 告诉用户「远端有 N 个 commit 还没拉」，message 写「N commits from origin ahead」。
const UNCOMMITTED_HASH = "*"

// LogCommitsVscode 使用 vscode-git-graph 同款 git log 入口读取提交。
//
// 默认视图固定对齐 vscode-git-graph Show All Branches：
//
//	git -c log.showSignature=false log --max-count=N+1 --format=... --date-order --branches --remotes HEAD --
//
// N+1 是 vscode-git-graph 的 moreCommitsAvailable 哨兵：返回给布局前会丢掉第 N+1 条，
// 只用它判断后面是否还有历史可继续加载。
func LogCommitsVscode(ctx context.Context, opts LogOptions) (*LogResult, error) {
	if opts.LocalPath == "" {
		return nil, fmt.Errorf("localPath 不能为空")
	}
	if _, err := exec.LookPath("git"); err != nil {
		return nil, fmt.Errorf("系统未安装 git 命令: %w", err)
	}
	if !RepoExists(opts.LocalPath) {
		return nil, fmt.Errorf("仓库不存在（%s 下既无 .git 目录，也无 HEAD/objects，可能 clone 未完成）", opts.LocalPath)
	}

	maxCount := opts.MaxCount
	if maxCount <= 0 {
		maxCount = defaultVscodeInitialLoadCommits
	}
	logCount := maxCount + 1

	args := []string{
		"-C", opts.LocalPath,
		"-c", "log.showSignature=false",
		"log",
	}
	args = append(args, "--max-count="+strconv.Itoa(logCount))
	args = append(args,
		"--format="+vscodeLogFormat,
		"--date-order",
		"--branches",
		"--remotes",
		"HEAD",
		"--",
	)

	runCtx, cancel := context.WithTimeout(ctx, nativeGitTimeout)
	defer cancel()
	cmd := exec.CommandContext(runCtx, "git", args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		if runCtx.Err() == context.DeadlineExceeded {
			return nil, fmt.Errorf("git log 超时（%s）：%w", nativeGitTimeout, runCtx.Err())
		}
		return nil, fmt.Errorf("git log 失败: %w\n输出: %s", err, string(output))
	}

	refDataByHash := collectRefDataByHashNative(opts.LocalPath)
	commits := parseVscodeLogOutput(output, refDataByHash)
	truncated := false
	if maxCount > 0 && len(commits) > maxCount {
		commits = commits[:maxCount]
		truncated = true
	}

	// v3.x：探测 local HEAD 是否落后于 origin（对齐 vscode-git-graph
	// commits[0].hash === UNCOMMITTED 模式，但触发语义改为「local 落后 origin」，
	// 因为 NoCheckout 没有 worktree 无法用 `git status --porcelain`）。
	// 探测失败 / 落后 0 commit → 跳过，不影响主流程。
	//
	// 插入位置对齐 vscode dataSource.ts:186-196：在 commits 列表中**找到 local HEAD
	// 所在位置**（不是直接 unshift 到最前），把 UNCOMMITTED 插到 HEAD 之前。
	// 这样 all-branches 视图下即使 origin/main 领先，UNCOMMITTED 仍紧贴本地 HEAD 上方。
	if len(commits) > 0 {
		if headSHA, aheadCount, found, _ := detectUnpulledCommits(opts.LocalPath); found {
			uncommitted := buildUncommittedCommit(headSHA, aheadCount)
			insertIdx := 0
			for i, c := range commits {
				if c.SHA == headSHA {
					insertIdx = i
					break
				}
			}
			commits = append(commits[:insertIdx], append([]CommitInfo{uncommitted}, commits[insertIdx:]...)...)
		}
	}

	return &LogResult{Commits: commits, Truncated: truncated}, nil
}

// buildUncommittedCommit 构造 UNCOMMITTED 虚拟 commit。
//
// SHA = UNCOMMITTED_HASH（'*'，不会与真实 hash 碰撞）；
// parents = [headSHA]（让 lane 布局把它接到本地 HEAD 之上）。
//
// 字段对齐 vscode-git-graph `src/dataSource.ts:191` 的最小字段集：
//   - author / email = '*' / ''
//   - date           = now
//   - subject        = 'N commits from origin ahead'
//
// IsCommitted 字段不在 CommitInfo 上（保持 schema 稳定），
// 由 layout 端检测 SHA == UNCOMMITTED_HASH 写出 IsCommitted=false。
func buildUncommittedCommit(headSHA string, aheadCount int) CommitInfo {
	return CommitInfo{
		SHA:         UNCOMMITTED_HASH,
		ShortSHA:    UNCOMMITTED_HASH,
		Subject:     fmt.Sprintf("%d commits from origin ahead", aheadCount),
		AuthorName:  "*",
		AuthorEmail: "",
		AuthorWhen:  time.Now(),
		Parents:     []string{headSHA},
		IsMerge:     false,
		Refs:        nil,
		RefTypes:    nil,
	}
}

func collectRefDataByHashNative(localPath string) map[string]refData {
	refsByCommit, err := listRefsByCommit(localPath)
	if err != nil {
		return map[string]refData{}
	}
	result := make(map[string]refData, len(refsByCommit))
	for sha, refs := range refsByCommit {
		names := make([]string, 0, len(refs))
		types := make([]RefType, 0, len(refs))
		for _, ref := range refs {
			if ref.ShortName == "" {
				continue
			}
			var refType RefType
			switch ref.RefGroup {
			case "heads":
				refType = RefTypeBranch
			case "remotes":
				refType = RefTypeRemoteBranch
			case "tags":
				refType = RefTypeTag
			default:
				continue
			}
			names = append(names, ref.ShortName)
			types = append(types, refType)
		}
		result[sha] = refData{Names: names, Types: types}
	}
	return result
}

func parseVscodeLogOutput(output []byte, refDataByHash map[string]refData) []CommitInfo {
	scanner := bufio.NewScanner(bytes.NewReader(output))
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)

	commits := make([]CommitInfo, 0)
	for scanner.Scan() {
		raw := scanner.Text()
		if raw == "" {
			continue
		}
		parts := strings.SplitN(raw, "\x1f", 6)
		if len(parts) != 6 {
			continue
		}
		sha := parts[0]
		parentFields := strings.Fields(parts[1])
		commitUnix, err := strconv.ParseInt(parts[4], 10, 64)
		if err != nil {
			commitUnix = 0
		}
		refs := refDataByHash[sha]
		commits = append(commits, CommitInfo{
			SHA:         sha,
			ShortSHA:    shortSHA(sha),
			Subject:     parts[5],
			AuthorName:  parts[2],
			AuthorEmail: parts[3],
			AuthorWhen:  time.Unix(commitUnix, 0),
			Parents:     parentFields,
			IsMerge:     len(parentFields) >= 2,
			Refs:        refs.Names,
			RefTypes:    refs.Types,
		})
	}
	return commits
}

// detectUnpulledCommits 探测 local HEAD 是否落后于 origin 的默认分支。
//
// 返回 (headSHA, aheadCount, found, err)：
//   - headSHA   本地 HEAD 的完整 SHA（用于给 UNCOMMITTED.Parents 引用）
//   - aheadCount  origin/<defaultBranch> 比 local HEAD 多了多少 commit
//   - found     是否真的存在未拉取的 commit（false 时不插入 UNCOMMITTED）
//   - err       探测过程中的非致命错误（不可恢复时让 LogCommitsVscode 跳过 UNCOMMITTED）
//
// 默认分支探测顺序：origin/HEAD > origin/main > origin/master
// origin/HEAD 是平台显式标记的 default branch（git remote set-head origin --auto
// 设置后会出现），优先用；找不到时退回 main/master。
//
// 任何 git 调用失败都返回 found=false，让 LogCommitsVscode 优雅跳过——
// NoCheckout 模式 + 缺少 worktree 本身就让"未拉取"的语义变弱，
// 不应让一个次要 feature 阻断主流程。
func detectUnpulledCommits(localPath string) (headSHA string, aheadCount int, found bool, err error) {
	// 1. Local HEAD SHA
	headOut, errOut := exec.Command("git", "-C", localPath, "rev-parse", "HEAD").Output()
	if errOut != nil {
		return "", 0, false, nil
	}
	headSHA = strings.TrimSpace(string(headOut))
	if headSHA == "" {
		return "", 0, false, nil
	}

	// 2. Try origin default branches in priority order
	var originRefSHA string
	candidates := []string{"origin/HEAD", "origin/main", "origin/master"}
	for _, candidate := range candidates {
		out, errVer := exec.Command("git", "-C", localPath, "rev-parse", "--verify", "--quiet", candidate).Output()
		if errVer != nil {
			continue
		}
		sha := strings.TrimSpace(string(out))
		if sha == "" || sha == headSHA {
			// origin/HEAD == local HEAD（或候选退化为 HEAD），无需插入
			return headSHA, 0, false, nil
		}
		originRefSHA = sha
		break
	}
	if originRefSHA == "" {
		return headSHA, 0, false, nil
	}

	// 3. Count: HEAD..originRefSHA (unpulled commits on origin)
	countOut, errCount := exec.Command("git", "-C", localPath, "rev-list", "--count", headSHA+".."+originRefSHA).Output()
	if errCount != nil {
		return headSHA, 0, false, nil
	}
	count, errAtoi := strconv.Atoi(strings.TrimSpace(string(countOut)))
	if errAtoi != nil || count <= 0 {
		return headSHA, 0, false, nil
	}
	return headSHA, count, true, nil
}
