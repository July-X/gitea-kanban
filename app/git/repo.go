package git

import (
	"fmt"

	"github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/object"
)

// Repo 封装 go-git Repository，提供便捷查询方法
type Repo struct {
	repo *git.Repository
}

// OpenRepo 打开本地仓库
func OpenRepo(localPath string) (*Repo, error) {
	repo, err := git.PlainOpen(localPath)
	if err != nil {
		return nil, fmt.Errorf("打开仓库失败: %w", err)
	}
	return &Repo{repo: repo}, nil
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

// GetCommitDiff 获取 commit 的 diff（简化版：返回变更文件列表）
//
// go-git 的 commit.Patch() 可生成完整 diff，但首期简化为文件列表
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

	changes := []FileChange{}
	if parentTree != nil {
		diff, err := parentTree.Diff(commitTree)
		if err != nil {
			return nil, fmt.Errorf("diff 失败: %w", err)
		}
		for _, c := range diff {
			changes = append(changes, FileChange{
				Path:     c.To.Name,
				OldPath:  c.From.Name,
				Action:   changeAction(c),
			})
		}
	} else {
		// 根 commit：所有文件都是新增
		commitTree.Files().ForEach(func(f *object.File) error {
			changes = append(changes, FileChange{
				Path:   f.Name,
				Action: "added",
			})
			return nil
		})
	}

	return changes, nil
}

// FileChange 文件变更
type FileChange struct {
	Path    string `json:"path"`
	OldPath string `json:"oldPath,omitempty"`
	Action  string `json:"action"` // added / modified / deleted / renamed
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
