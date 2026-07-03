package git

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"gitea-kanban/app/gitbinary"
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
// 触发语义 1:1 复刻 vscode-git-graph 的 `commits[0].hash === UNCOMMITTED` 模式。
// 真实数据源 = worktree dirty count: `git status --porcelain` 的行数。
// 任意 dirty (M / A / D / R / C / U / T / ??) 都计入 uncommitted。
// NoCheckout 模式下 index 有但 worktree 空会全部报告为 D，语义仍然成立
// （worktree 与 index 不一致 = uncommitted）。
const UNCOMMITTED_HASH = "*"

// dirtyFileCap 探测 worktree dirty 时从 `git status --porcelain` 最多读多少行。
// 避免 10w+ 改动的 monorepo 误删把整个 output 拉回 Go 进程浪费内存。
// 1143 是用户实测 DeepSeek-Reasonix 仓库的数量级，留 ~4x 余量。
const dirtyFileCap = 5000

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
	if _, err := gitbinary.ResolveGitBinaryPath(""); err != nil {
		return nil, fmt.Errorf("系统未安装 git 命令: %w", err)
	}
	if !RepoExists(opts.LocalPath) {
		return nil, fmt.Errorf("仓库不存在（%s 下既无 .git 目录，也无 HEAD/objects，可能 clone 未完成）", opts.LocalPath)
	}

	maxCount := opts.MaxCount
	if maxCount <= 0 {
		maxCount = defaultVscodeInitialLoadCommits
	}
	// 分页：请求 offset + maxCount + 1 条，+1 用于判断是否还有更多
	logCount := opts.Offset + maxCount + 1

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
	bin, err := gitbinary.ResolveGitBinaryPath("")
	if err != nil {
		return nil, fmt.Errorf("gitbinary: %w", err)
	}
	output, err := gitbinary.RunGit(runCtx, bin, opts.LocalPath, args...)
	if err != nil {
		if runCtx.Err() == context.DeadlineExceeded {
			return nil, fmt.Errorf("git log 超时（%s）：%w", nativeGitTimeout, runCtx.Err())
		}
		return nil, fmt.Errorf("git log 失败: %w\n输出: %s", err, string(output))
	}

	refDataByHash := collectRefDataByHashNative(opts.LocalPath)
	commits := parseVscodeLogOutput(output, refDataByHash)

	// offset 分页：跳过前 N 条（在截断前执行，保证稳定分页）
	if opts.Offset > 0 && opts.Offset < len(commits) {
		commits = commits[opts.Offset:]
	} else if opts.Offset >= len(commits) {
		commits = nil
	}

	truncated := false
	if maxCount > 0 && len(commits) > maxCount {
		commits = commits[:maxCount]
		truncated = true
	}

	// v3.x：探测 worktree dirty count，1:1 复刻 vscode-git-graph 的
	// commits[0].hash === UNCOMMITTED 模式（数据源: git status --porcelain）。
	// 探测失败 / dirty 0 → 跳过，不影响主流程。
	//
	// 插入位置对齐 vscode dataSource.ts:191 `commits.unshift(...)`：
	// UNCOMMITTED 永远在 commits[0]（lane 布局 row 0），让 lane 流从顶部显示
	// 「未提交」区段，而不是塞在 local HEAD 之前（all-branches 视图下会跑到中间）。
	// 注意：offset 分页时不插入 UNCOMMITTED（只在第一页显示）
	if len(commits) > 0 && opts.Offset == 0 {
		if headSHA, dirtyCount, found, _ := detectUncommittedChanges(opts.LocalPath); found {
			commits = append([]CommitInfo{buildUncommittedCommit(headSHA, dirtyCount)}, commits...)
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
//   - author  = "*"  (固定占位符)
//   - date           = now
//   - subject        = 'Uncommitted changes (N files)'  （N=worktree dirty 行数）
//
// IsCommitted 字段不在 CommitInfo 上（保持 schema 稳定），
// 由 layout 端检测 SHA == UNCOMMITTED_HASH 写出 IsCommitted=false。
func buildUncommittedCommit(headSHA string, dirtyCount int) CommitInfo {
	return CommitInfo{
		SHA:         UNCOMMITTED_HASH,
		ShortSHA:    UNCOMMITTED_HASH,
		Subject:     fmt.Sprintf("Uncommitted changes (%d files)", dirtyCount),
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

// detectUncommittedChanges 探测 worktree dirty count，1:1 复刻 vscode-git-graph
// 的 UNCOMMITTED 检测路径（dataSource.ts 通过 `git status --porcelain` 判 dirty）。
//
// 返回 (headSHA, dirtyCount, found, err)：
//   - headSHA     本地 HEAD 完整 SHA（用于给 UNCOMMITTED.Parents 引用）
//   - dirtyCount  `git status --porcelain` 的行数（dirty file count）
//   - found       dirtyCount > 0 时为 true（false 时不插入 UNCOMMITTED）
//   - err         探测过程的非致命错误（不可恢复时让 LogCommitsVscode 跳过 UNCOMMITTED）
//
// 任何 git 调用失败都返回 found=false，让 LogCommitsVscode 优雅跳过——
// dirty 检测只是渲染增强，不应阻断主流程。
//
// v3.x 之前用 `refs/gitea-kanban/synced-tip` 私有 ref 检测"local HEAD 落后远端"，
// 命名 + 语义都跟 vscode 不一致，且 synced-tip ref 在老仓库 / 手动 git 操作下
// 不会自动维护。改回 vscode 同款 git status --porcelain 后 1:1 对齐 Git Graph
// 实际行为：worktree 任何 dirty 都触发。
func detectUncommittedChanges(localPath string) (headSHA string, dirtyCount int, found bool, err error) {
	// 1. Local HEAD SHA（用作 UNCOMMITTED.Parents[0]，让 lane 流挂到本地 HEAD）
	bin, err := gitbinary.ResolveGitBinaryPath("")
	if err != nil {
		return "", 0, false, nil
	}
	revCtx, cancelRev := context.WithTimeout(context.Background(), nativeGitTimeout)
	defer cancelRev()
	headOut, revErr := gitbinary.RunGit(revCtx, bin, localPath, "rev-parse", "HEAD")
	if revErr != nil {
		return "", 0, false, nil
	}
	headSHA = strings.TrimSpace(string(headOut))
	if headSHA == "" {
		return "", 0, false, nil
	}

	// 2. `git status --porcelain` 输出行数 = dirty 文件数。
	//    --untracked-files=all 让 ??. 类的 untracked 也计入。
	//    --porcelain=v1 走稳定的 machine-readable 格式，v2 在 git 2.36+ 才稳定。
	//    NoCheckout 模式 worktree 是空的，但 index 有所有文件 → status 全部报告 D
	//    → dirtyCount = 文件总数，语义仍然成立（worktree 与 index 不一致 = uncommitted）。
	//
	//    --porcelain=v1 走稳定的 machine-readable 格式（v2 在 git 2.36+ 才稳定，
	//    这里统一锁 v1 保证跨平台输出格式一致）。
	//    --untracked-files=all 让 ??. 类的 untracked 也计入（默认只报告 untracked dir）。
	//
	//    注意：--no-optional-locks 是 git 全局选项（必须在子命令前），不放在这里。
	//    我们只读不写，不需要抢锁；如要全局禁用锁可改用 `git --no-optional-locks -C ... status ...`。
	statusCtx, cancel := context.WithTimeout(context.Background(), nativeGitTimeout)
	defer cancel()
	statusOut, errStatus := gitbinary.RunGit(statusCtx, bin, localPath,
		"status",
		"--porcelain=v1",
		"--untracked-files=all",
	)
	if errStatus != nil {
		return headSHA, 0, false, nil
	}

	count := 0
	scanner := bufio.NewScanner(bytes.NewReader(statusOut))
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		if scanner.Text() == "" {
			continue
		}
		count++
		if count > dirtyFileCap {
			// 超过 cap 仍算 dirty，但不再精确计数（避免大仓库内存爆炸）
			// 后续 UI 可以展示 ">5000 files" 之类的描述
			break
		}
	}
	if count == 0 {
		return headSHA, 0, false, nil
	}
	return headSHA, count, true, nil
}
