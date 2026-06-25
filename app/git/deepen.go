package git

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// DeepenRepoOptions 加深仓库历史参数
type DeepenRepoOptions struct {
	// LocalPath 本地仓库路径
	LocalPath string
	// DeepenBy 增加的深度（拉取更多历史）
	DeepenBy int
	// Progress 进度回调（可选）
	Progress ProgressCallback
}

// DeepenRepoResult 加深结果
type DeepenRepoResult struct {
	// Success 是否成功
	Success bool
	// Message 结果消息
	Message string
}

// DeepenRepo 增量拉取更多历史记录（用于浅克隆仓库）
//
// v2.10：按需加载机制 + v2.11：添加进度回调
//
// 使用场景：
//   - 用户查看 Git Graph 时滚动到底部
//   - 点击"加载更多"按钮
//   - 首次只拉取 10 个 commit，后续按需加载
//
// 技术实现：
//   - 使用 git fetch --deepen=N 增量拉取
//   - 保持 --filter=blob:none（只拉取 commits，不拉取文件）
//   - 解析 git 输出并通过 Progress 回调报告进度
//
// 参数：
//   - localPath: 本地仓库路径
//   - deepenBy: 增加的深度（如 50 表示再拉取 50 个 commit）
//   - Progress: 进度回调（可选）
//
// 限制：
//   - 只对浅克隆仓库有效
//   - 需要系统安装 git 命令
func DeepenRepo(opts DeepenRepoOptions) (*DeepenRepoResult, error) {
	if opts.LocalPath == "" {
		return nil, fmt.Errorf("localPath 不能为空")
	}

	if opts.DeepenBy <= 0 {
		return nil, fmt.Errorf("deepenBy 必须大于 0")
	}

	// 检查 git 命令是否可用
	if _, err := exec.LookPath("git"); err != nil {
		return nil, fmt.Errorf("系统未安装 git 命令: %w", err)
	}

	// 检查仓库是否存在
	if _, err := os.Stat(filepath.Join(opts.LocalPath, ".git")); err != nil {
		return nil, fmt.Errorf("仓库不存在: %w", err)
	}

	// 检查是否是浅克隆
	shallowFile := filepath.Join(opts.LocalPath, ".git", "shallow")
	if _, err := os.Stat(shallowFile); os.IsNotExist(err) {
		return &DeepenRepoResult{
			Success: false,
			Message: "此仓库不是浅克隆，已包含完整历史",
		}, nil
	}

	// 报告开始
	if opts.Progress != nil {
		opts.Progress(SyncProgress{
			Stage:   StageReceiving,
			Percent: 0,
			Message: fmt.Sprintf("开始拉取更多 %d 层历史...", opts.DeepenBy),
		})
	}

	// 构造 git fetch --deepen 命令
	args := []string{
		"-C", opts.LocalPath,
		"fetch",
		"--filter=blob:none", // 继续不下载文件内容
		fmt.Sprintf("--deepen=%d", opts.DeepenBy), // 增量拉取
		"--progress", // 输出进度信息
	}

	// 执行命令并捕获输出
	cmd := exec.Command("git", args...)

	// 创建管道捕获 stderr（git 的进度输出在 stderr）
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, fmt.Errorf("创建 stderr 管道失败: %w", err)
	}

	// 启动命令
	if err := cmd.Start(); err != nil {
		EmitProgress(opts.Progress, StageError, -1, "启动 git 命令失败")
		return nil, fmt.Errorf("启动 git 命令失败: %w", err)
	}

	// 解析进度输出
	if opts.Progress != nil {
		go parseGitProgress(stderr, opts.Progress)
	} else {
		// 不需要进度，直接丢弃输出
		go io.Copy(io.Discard, stderr)
	}

	// 等待命令完成
	if err := cmd.Wait(); err != nil {
		EmitProgress(opts.Progress, StageError, -1, "git fetch --deepen 失败")
		return nil, fmt.Errorf("git fetch --deepen 失败: %w", err)
	}

	// 报告完成
	if opts.Progress != nil {
		EmitProgress(opts.Progress, StageDone, 100, "加载更多历史完成")
	}

	// 检查是否已经拉取到根节点
	if _, err := os.Stat(shallowFile); os.IsNotExist(err) {
		return &DeepenRepoResult{
			Success: true,
			Message: fmt.Sprintf("已拉取完整历史（再增加 %d 层后到达根节点）", opts.DeepenBy),
		}, nil
	}

	return &DeepenRepoResult{
		Success: true,
		Message: fmt.Sprintf("成功加载更多 %d 层历史", opts.DeepenBy),
	}, nil
}

// parseGitProgress 解析 git 命令的进度输出
//
// git fetch 的进度格式：
//
//	Receiving objects: 45% (234/520)
//	Resolving deltas: 100% (123/123), done.
func parseGitProgress(r io.Reader, callback ProgressCallback) {
	scanner := bufio.NewScanner(r)

	// 正则匹配进度信息
	// 例如: "Receiving objects:  45% (234/520)"
	progressRe := regexp.MustCompile(`(Receiving objects|Resolving deltas):\s*(\d+)%\s*\((\d+)/(\d+)\)`)

	for scanner.Scan() {
		line := scanner.Text()

		// 匹配进度行
		if matches := progressRe.FindStringSubmatch(line); len(matches) >= 5 {
			stage := matches[1]
			percent, _ := strconv.Atoi(matches[2])
			cur, _ := strconv.Atoi(matches[3])
			total, _ := strconv.Atoi(matches[4])

			var syncStage SyncStage
			if strings.Contains(stage, "Receiving") {
				syncStage = StageReceiving
			} else {
				syncStage = StageResolvingDeltas
			}

			callback(SyncProgress{
				Stage:   syncStage,
				Percent: percent,
				Message: stage,
				Cur:     cur,
				Total:   total,
			})
		}
	}
}
