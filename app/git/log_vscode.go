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

const vscodeLogFormat = "%H%x1f%P%x1f%an%x1f%ae%x1f%ct%x1f%s"
const defaultVscodeInitialLoadCommits = 300

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

	return &LogResult{Commits: commits, Truncated: truncated}, nil
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
