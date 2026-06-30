package git

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"strconv"
	"strings"

	"github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/object"
)

// Repo 封装 go-git Repository，提供便捷查询方法
type Repo struct {
	repo      *git.Repository
	localPath string // 用于 native git 命令
}

// OpenRepo 打开本地仓库
func OpenRepo(localPath string) (*Repo, error) {
	repo, err := git.PlainOpen(localPath)
	if err != nil {
		return nil, fmt.Errorf("打开仓库失败: %w", err)
	}
	return &Repo{repo: repo, localPath: localPath}, nil
}

// CommitDetail commit 详情（含完整 message）
type CommitDetail struct {
	SHA         string
	ShortSHA    string
	Subject     string
	AuthorName  string
	AuthorEmail string
	AuthorWhen  string
	Message     string
	Parents     []string
}

// GetCommit 获取单个 commit 的详情
func (r *Repo) GetCommit(sha string) (*CommitDetail, error) {
	hash := plumbing.NewHash(sha)
	commit, err := r.repo.CommitObject(hash)
	if err != nil {
		return nil, fmt.Errorf("找不到 commit %s: %w", sha, err)
	}

	parents := make([]string, len(commit.ParentHashes))
	for i, h := range commit.ParentHashes {
		parents[i] = h.String()
	}

	return &CommitDetail{
		SHA:         commit.Hash.String(),
		ShortSHA:    commit.Hash.String()[:7],
		Subject:     extractSubject(commit.Message),
		AuthorName:  commit.Author.Name,
		AuthorEmail: commit.Author.Email,
		AuthorWhen:  commit.Author.When.Format("2006-01-02T15:04:05Z07:00"),
		Message:     commit.Message,
		Parents:     parents,
	}, nil
}

// getCommitFileStatsGit 使用系统 git diff-tree 获取文件变更行数。
//
// 优先于 go-git commit.Stats()：系统 git 能正确处理 partial clone / blobless clone，
// 即使 blobs 未预下载也能按需获取（go-git 的 Stats() 在 blobless clone 下返回全 0）。
//
// 对于 blobless clone（GitHub 超大仓库使用 gh blobless clone --filter=blob:none），
// commit.Stats() 需要读取 blob 内容才能计算行数，但 blob 未在本地 → 返回 0。
// 系统 git diff-tree --numstat 只需 tree 对象和 commit 对象，不依赖 blob 内容。
func (r *Repo) getCommitFileStatsGit(sha string) (map[string][2]int, error) {
	args := []string{
		"-C", r.localPath,
		"diff-tree",
		"--numstat", // 输出格式：<adds>\t<dels>\t<path>
	}

	commit, err := r.repo.CommitObject(plumbing.NewHash(sha))
	if err != nil {
		return nil, fmt.Errorf("找不到 commit %s: %w", sha, err)
	}

	if len(commit.ParentHashes) > 0 {
		args = append(args, commit.ParentHashes[0].String(), sha)
	} else {
		args = append(args, "--root", sha)
	}

	ctx, cancel := context.WithTimeout(context.Background(), nativeGitTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		// git diff-tree 失败时返回空 map，让调用方 fallback 到 go-git Stats
		return map[string][2]int{}, nil
	}

	stats := map[string][2]int{}
	scanner := bufio.NewScanner(bytes.NewReader(output))
	for scanner.Scan() {
		line := scanner.Text()
		parts := strings.SplitN(line, "\t", 3)
		if len(parts) < 3 {
			continue
		}
		adds, _ := strconv.Atoi(parts[0])
		dels, _ := strconv.Atoi(parts[1])
		path := parts[2]
		stats[path] = [2]int{adds, dels}
	}

	return stats, nil
}

// GetCommitDiff 获取 commit 的 diff（简化版：返回变更文件列表）
func (r *Repo) GetCommitDiff(sha string) ([]FileChange, error) {
	hash := plumbing.NewHash(sha)
	commit, err := r.repo.CommitObject(hash)
	if err != nil {
		return nil, fmt.Errorf("找不到 commit %s: %w", sha, err)
	}

	// 如果有 parent，与 parent 比较
	var parentTree *object.Tree
	if len(commit.ParentHashes) > 0 {
		parent, err := r.repo.CommitObject(commit.ParentHashes[0])
		if err == nil {
			parentTree, _ = parent.Tree()
		}
	}

	commitTree, err := commit.Tree()
	if err != nil {
		return nil, fmt.Errorf("获取 tree 失败: %w", err)
	}

	// v3.x：优先用系统 git diff-tree --numstat
	// 解决 GitHub blobless clone（--filter=blob:none）下 go-git commit.Stats() 返回全 0 的问题
	// git diff-tree 只读 tree+commit 对象，不需要 blob 内容，能正确处理 partial clone
	statsMap, _ := r.getCommitFileStatsGit(sha)

	changes := []FileChange{}
	if parentTree != nil {
		diff, err := parentTree.Diff(commitTree)
		if err != nil {
			return nil, fmt.Errorf("diff 失败: %w", err)
		}
		for _, c := range diff {
			fc := FileChange{
				Path:    c.To.Name,
				OldPath: c.From.Name,
				Action:  changeAction(c),
			}
			// 优先用 git diff-tree 结果（支持 blobless clone），回退 go-git Stats
			if st, ok := statsMap[c.To.Name]; ok && (st[0] > 0 || st[1] > 0) {
				fc.Additions = st[0]
				fc.Deletions = st[1]
			} else if st, ok := statsMap[c.From.Name]; ok && (st[0] > 0 || st[1] > 0) {
				fc.Additions = st[0]
				fc.Deletions = st[1]
			} else if s, ok := gitStatsFallback(commit, c.To.Name); ok {
				fc.Additions = s.Addition
				fc.Deletions = s.Deletion
			} else if s, ok := gitStatsFallback(commit, c.From.Name); ok {
				fc.Additions = s.Addition
				fc.Deletions = s.Deletion
			}
			changes = append(changes, fc)
		}
	} else {
		// 根 commit：所有文件都是新增，行数从 git diff-tree 来
		commitTree.Files().ForEach(func(f *object.File) error {
			fc := FileChange{
				Path:   f.Name,
				Action: "added",
			}
			if st, ok := statsMap[f.Name]; ok && (st[0] > 0 || st[1] > 0) {
				fc.Additions = st[0]
				fc.Deletions = st[1]
			} else if s, ok := gitStatsFallback(commit, f.Name); ok {
				fc.Additions = s.Addition
				fc.Deletions = s.Deletion
			}
			changes = append(changes, fc)
			return nil
		})
	}

	return changes, nil
}

// gitStatsFallback go-git commit.Stats() 回退（仅在 git diff-tree 失败时用）
func gitStatsFallback(commit *object.Commit, name string) (object.FileStat, bool) {
	stats, err := commit.Stats()
	if err != nil {
		return object.FileStat{}, false
	}
	for _, s := range stats {
		if s.Name == name {
			return s, true
		}
	}
	return object.FileStat{}, false
}

// FileChange 文件变更
type FileChange struct {
	Path      string `json:"path"`
	OldPath   string `json:"oldPath,omitempty"`
	Action    string `json:"action"` // added / modified / deleted / renamed
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
}

// changeAction 推断变更类型
func changeAction(c *object.Change) string {
	if c.From.Name == "" && c.To.Name != "" {
		return "added"
	}
	if c.From.Name != "" && c.To.Name == "" {
		return "deleted"
	}
	if c.From.Name != c.To.Name {
		return "renamed"
	}
	return "modified"
}
