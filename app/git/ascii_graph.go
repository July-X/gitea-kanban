package git

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"os/exec"
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
// 这个路径主要给 GitHub/gh partial clone 的超大仓库使用：仓库只需要 commit 元信息。
// git log 的 ASCII 字符流只用于保留排序与父节点数据，前端会按 parents 重新计算
// VSCode 风格的 DAG lane，而不是把 git log --graph 字符图当最终显示结果。
//
// 超宽 graph 保护（v2.x 修复 July-X/UnrealEngine 渲染卡死）：
// UnrealEngine release 分支中段有一段把大量 promotional 分支同步 merge 进来的历史，
// `git log --graph` 在该段单行 glyph 宽达上千 lane，前端会生成几百条 flow + 超宽 SVG，
// 渲染 6000+ div 时卡死主线程（用户看到"只有圆点、列表空白"）。
// 这里先跑一次完整 graph，若检测到单行非空格 glyph 数超过 maxGraphLaneWidth（默认 64），
// 自动回退到 --first-parent 重跑：只画默认分支第一父链主线，graph 退化为单列，秒渲染。
// 语义上对齐 --single-branch 浅克隆：用户看的是主干历史，被合入的子分支细节本就不是重点。
func RunGraphLog(localPath string, opts RunGraphLogOptions) (*GraphLinesResult, error) {
	if localPath == "" {
		return nil, fmt.Errorf("localPath 不能为空")
	}
	if _, err := exec.LookPath("git"); err != nil {
		return nil, fmt.Errorf("系统未安装 git 命令: %w", err)
	}
	// 兼容两种仓库布局（与 clone.go RepoExists 对齐）：
	//   1. 标准布局：localPath/.git/（gh clone、git clone 默认）
	//   2. bare 布局：localPath/ 下直接是 HEAD + objects + config
	//      （go-git NoCheckout clone 在某些场景产出 bare 仓库，见 clone.go 注释；
	//       早期 mirror clone 也留有 bare 布局）
	// 旧代码只查 .git，go-git 仓库会误报"仓库不存在"，导致 Git Graph 显示不了。
	if !RepoExists(localPath) {
		return nil, fmt.Errorf("仓库不存在（%s 下既无 .git 目录，也无 HEAD/objects，可能 clone 未完成）", localPath)
	}

	result, err := runGraphLogOnce(localPath, opts, false)
	if err != nil {
		return nil, err
	}

	// 超宽 graph 回退：单行 lane 数超阈值 → 用 --first-parent 重跑
	if maxLineLaneWidth(result.Lines) > maxGraphLaneWidth {
		fpResult, fpErr := runGraphLogOnce(localPath, opts, true)
		if fpErr == nil && len(fpResult.Lines) > 0 {
			fpResult.Truncated = result.Truncated
			return &fpResult, nil
		}
		// first-parent 失败则保留原结果（至少有数据）
	}
	return &result, nil
}

// maxGraphLaneWidth 触发 --first-parent 回退的单行 lane 阈值。
// 64 lane 对应 SVG 约 1920px 宽（COL_WIDTH=15 × DISPLAY_SCALE=2），前端仍可流畅渲染。
const maxGraphLaneWidth = 64

// maxLineLaneWidth 统计所有行中最大的非空格 glyph 数（≈ 该行的并发 lane 数）。
// git log --graph 每个非空格字符代表一条 lane 在该行的存在，行内非空格字符数即 lane 宽度。
func maxLineLaneWidth(lines []GraphLine) int {
	maxW := 0
	for _, line := range lines {
		w := 0
		for _, c := range line.Glyph {
			if c != ' ' {
				w++
			}
		}
		if w > maxW {
			maxW = w
		}
	}
	return maxW
}

// runGraphLogOnce 执行一次 git log --graph，firstParent 控制 是否加 --first-parent。
func runGraphLogOnce(localPath string, opts RunGraphLogOptions, firstParent bool) (GraphLinesResult, error) {
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
	if firstParent {
		args = append(args, "--first-parent")
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
			return GraphLinesResult{}, fmt.Errorf("git log --graph 超时（%s）：%w", nativeGitTimeout, ctx.Err())
		}
		return GraphLinesResult{}, fmt.Errorf("git log --graph 失败: %w\n输出: %s", err, string(output))
	}
	result := parseGraphLogOutput(output, opts.MaxCount)
	return result, nil
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
	parts := strings.SplitN(dataPart, "|", 8)
	if len(parts) < 8 {
		return nil
	}
	parents := strings.Fields(parts[4])
	return &GraphLineCommit{
		SHA:         parts[1],
		ShortSHA:    parts[3],
		Subject:     parts[7],
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
