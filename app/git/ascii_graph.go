package git

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// GitRef 是 git log --decorate 输出里的引用装饰。
type GitRef struct {
	Name      string `json:"name"`
	RefGroup  string `json:"refGroup"`
	ShortName string `json:"shortName"`
}

// GraphLineCommit 是 ASCII Git Graph 行上的 commit 元信息。
type GraphLineCommit struct {
	SHA         string   `json:"sha"`
	ShortSHA    string   `json:"shortSha"`
	Subject     string   `json:"subject"`
	Date        string   `json:"date"`
	AuthorName  string   `json:"authorName"`
	AuthorEmail string   `json:"authorEmail"`
	IsMerge     bool     `json:"isMerge"`
	Parents     []string `json:"parents"`
	Refs        []GitRef `json:"refs"`
}

// GraphLine 是 git log --graph 输出的一行。
type GraphLine struct {
	Row    int              `json:"row"`
	Glyph  string           `json:"glyph"`
	Commit *GraphLineCommit `json:"commit"`
}

// GraphLinesResult 是旧 ASCII parser 可消费的 Git Graph 数据。
type GraphLinesResult struct {
	Lines        []GraphLine `json:"lines"`
	TotalCommits int         `json:"totalCommits"`
	Truncated    bool        `json:"truncated"`
	Range        GraphRange  `json:"range"`
}

// GraphRange 表示当前返回窗口的时间范围。
type GraphRange struct {
	From string `json:"from"`
	To   string `json:"to"`
}

// RunGraphLogOptions 控制 ASCII Git Graph 拉取。
type RunGraphLogOptions struct {
	Branches []string
	MaxCount int
}

const graphLogPrettyFormat = "DATA:%D|%H|%ad|%h|%P|%an|%ae|%s"

// RunGraphLog 使用系统 git 的 --graph 字符流生成 Git Graph。
//
// 这个路径主要给 GitHub/gh partial clone 的超大仓库使用：仓库只需要 commit 元信息，
// 由 git 自己完成 date-order + graph ASCII 布局，前端复用旧 parser 渲染，避免结构化
// lane 算法在超大浅历史上生成过宽 SVG。
func RunGraphLog(localPath string, opts RunGraphLogOptions) (*GraphLinesResult, error) {
	if localPath == "" {
		return nil, fmt.Errorf("localPath 不能为空")
	}
	if _, err := exec.LookPath("git"); err != nil {
		return nil, fmt.Errorf("系统未安装 git 命令: %w", err)
	}
	if _, err := os.Stat(filepath.Join(localPath, ".git")); err != nil {
		return nil, fmt.Errorf("仓库不存在: %w", err)
	}

	args := []string{
		"-C", localPath,
		"log",
		"--graph",
		"--date-order",
		"--decorate=full",
		"-C",
		"-M",
		"--date=iso-strict",
		"--pretty=format:" + graphLogPrettyFormat,
		"--branches",
		"--remotes",
	}
	for _, branch := range opts.Branches {
		if strings.TrimSpace(branch) == "" {
			continue
		}
		if strings.HasPrefix(branch, "refs/") {
			args = append(args, branch)
			continue
		}
		args = append(args, "refs/heads/"+branch, "refs/remotes/origin/"+branch)
	}
	if opts.MaxCount > 0 {
		args = append(args, "-n", fmt.Sprintf("%d", opts.MaxCount))
	}

	ctx, cancel := context.WithTimeout(context.Background(), nativeGitTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return nil, fmt.Errorf("git log --graph 超时（%s）：%w", nativeGitTimeout, ctx.Err())
		}
		return nil, fmt.Errorf("git log --graph 失败: %w\n输出: %s", err, string(output))
	}
	result := parseGraphLogOutput(output, opts.MaxCount)
	return &result, nil
}

func parseGraphLogOutput(output []byte, maxCount int) GraphLinesResult {
	scanner := bufio.NewScanner(bytes.NewReader(output))
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)

	lines := make([]GraphLine, 0)
	row := 0
	totalCommits := 0
	minDate := ""
	maxDate := ""

	for scanner.Scan() {
		raw := scanner.Text()
		if raw == "" {
			continue
		}
		line := GraphLine{Row: row}
		row++

		dataIdx := strings.Index(raw, "DATA:")
		if dataIdx < 0 {
			line.Glyph = raw
			lines = append(lines, line)
			continue
		}

		line.Glyph = raw[:dataIdx]
		commit := parseGraphLineCommit(raw[dataIdx+len("DATA:"):])
		if commit != nil {
			line.Commit = commit
			totalCommits++
			if commit.Date != "" {
				if minDate == "" || commit.Date < minDate {
					minDate = commit.Date
				}
				if maxDate == "" || commit.Date > maxDate {
					maxDate = commit.Date
				}
			}
		}
		lines = append(lines, line)
	}

	return GraphLinesResult{
		Lines:        lines,
		TotalCommits: totalCommits,
		Truncated:    maxCount > 0 && totalCommits >= maxCount,
		Range: GraphRange{
			From: minDate,
			To:   maxDate,
		},
	}
}

func parseGraphLineCommit(dataPart string) *GraphLineCommit {
	parts := strings.Split(dataPart, "|")
	if len(parts) < 8 {
		return nil
	}
	parents := strings.Fields(parts[4])
	return &GraphLineCommit{
		SHA:         parts[1],
		ShortSHA:    parts[3],
		Subject:     strings.Join(parts[7:], "|"),
		Date:        parts[2],
		AuthorName:  parts[5],
		AuthorEmail: parts[6],
		IsMerge:     len(parents) > 1,
		Parents:     parents,
		Refs:        parseGraphDecorations(parts[0]),
	}
}

func parseGraphDecorations(refsStr string) []GitRef {
	if strings.TrimSpace(refsStr) == "" {
		return []GitRef{}
	}
	parts := strings.Split(refsStr, ",")
	refs := make([]GitRef, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if strings.HasPrefix(part, "HEAD -> ") {
			part = strings.TrimSpace(strings.TrimPrefix(part, "HEAD -> "))
		}
		if strings.Contains(part, " -> ") {
			chunks := strings.Split(part, " -> ")
			part = strings.TrimSpace(chunks[len(chunks)-1])
		}
		switch {
		case strings.HasPrefix(part, "tag: "):
			raw := strings.TrimSpace(strings.TrimPrefix(part, "tag: "))
			short := strings.TrimPrefix(raw, "refs/tags/")
			refs = append(refs, GitRef{Name: "refs/tags/" + short, RefGroup: "tags", ShortName: short})
		case strings.HasPrefix(part, "refs/heads/"):
			short := strings.TrimPrefix(part, "refs/heads/")
			refs = append(refs, GitRef{Name: part, RefGroup: "heads", ShortName: short})
		case strings.HasPrefix(part, "refs/remotes/"):
			short := strings.TrimPrefix(part, "refs/remotes/")
			refs = append(refs, GitRef{Name: part, RefGroup: "remotes", ShortName: short})
		case strings.HasPrefix(part, "refs/tags/"):
			short := strings.TrimPrefix(part, "refs/tags/")
			refs = append(refs, GitRef{Name: part, RefGroup: "tags", ShortName: short})
		case strings.Contains(part, "/"):
			refs = append(refs, GitRef{Name: "refs/remotes/" + part, RefGroup: "remotes", ShortName: part})
		default:
			refs = append(refs, GitRef{Name: "refs/heads/" + part, RefGroup: "heads", ShortName: part})
		}
	}
	return refs
}
