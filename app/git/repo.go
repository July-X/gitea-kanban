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

	// v2.15：Stats() 拿每文件 +/- 行数（map by name 用于 Diff 合并）
	statsMap := map[string]object.FileStat{}
	if stats, statErr := commit.Stats(); statErr == nil {
		for _, s := range stats {
			statsMap[s.Name] = s
		}
	}

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
			// v2.15：合并 Stats 行数 —— 优先 to.Name（新 path），rename 时回退 from.Name
			if s, ok := statsMap[c.To.Name]; ok {
				fc.Additions = s.Addition
				fc.Deletions = s.Deletion
			} else if s, ok := statsMap[c.From.Name]; ok {
				fc.Additions = s.Addition
				fc.Deletions = s.Deletion
			}
			changes = append(changes, fc)
		}
	} else {
		// 根 commit：所有文件都是新增，行数从 Stats 来
		commitTree.Files().ForEach(func(f *object.File) error {
			fc := FileChange{
				Path:   f.Name,
				Action: "added",
			}
			if s, ok := statsMap[f.Name]; ok {
				fc.Additions = s.Addition
				fc.Deletions = s.Deletion
			}
			changes = append(changes, fc)
			return nil
		})
	}

	return changes, nil
}

// FileChange 文件变更
//
// Additions / Deletions：来自 commit.Stats()（v2.15 新增）。
// rename 时按 OldPath 也尝试 lookup（stats 记录的是旧 path）。
// Binary / Functions 暂不支持（go-git 的 FileStat 不含二进制标记）；
// 前端可按 `Additions == 0 && Deletions == 0 && Action == "modified"` 视为
// "可能二进制"，但更准确的做法是后续解析 patch 内容（v2.16+ 再补）。
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
