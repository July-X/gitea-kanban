package git

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

// DeepenRepoOptions 加深仓库历史参数
type DeepenRepoOptions struct {
	// LocalPath 本地仓库路径
	LocalPath string
	// DeepenBy 增加的深度（拉取更多历史）
	DeepenBy int
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
// v2.10：按需加载机制
//
// 使用场景：
//   - 用户查看 Git Graph 时滚动到底部
//   - 点击"加载更多"按钮
//   - 首次只拉取 10 个 commit，后续按需加载
//
// 技术实现：
//   - 使用 git fetch --deepen=N 增量拉取
//   - 保持 --filter=blob:none（只拉取 commits，不拉取文件）
//
// 参数：
//   - localPath: 本地仓库路径
//   - deepenBy: 增加的深度（如 50 表示再拉取 50 个 commit）
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

	// 构造 git fetch --deepen 命令
	args := []string{
		"-C", opts.LocalPath,
		"fetch",
		"--filter=blob:none",                     // 继续不下载文件内容
		fmt.Sprintf("--deepen=%d", opts.DeepenBy), // 增量拉取
	}

	// 执行命令
	cmd := exec.Command("git", args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("git fetch --deepen 失败: %w\n输出: %s", err, string(output))
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
