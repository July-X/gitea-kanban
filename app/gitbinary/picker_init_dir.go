package gitbinary

import (
	"os"
	"os/exec"
	"path/filepath"
)

// findSystemGit 包装 exec.LookPath("git")，给 unit test 可注入路径覆盖。
//
// 单元测试可重写为 stub（如返 "/usr/local/bin/git"）覆盖 PATH 优先逻辑，
// 在 sandbox 同时存在 PATH git 时仍能验证 case 2/3 不被 case 1 拦截。
var findSystemGit = exec.LookPath

// PickInitialDir 决策「使用系统安装的 Git」按钮弹出的文件选择对话框初始目录。
//
//	v0.5-mid3 优先级（user 拍板：先看系统环境变量 Git 所在目录）：
//	  1. PATH git dirname
//	  2. dataDir/tools/git/（含 binary 才选）
//	  3. dataDir 本身（兜底）
//
// 设计理由：
//   - 先 PATH 是因为它在实际机器上几乎 100% 在（macOS 都带 Apple Git）；
//     跳过 PATH 会强制用户手动导航，体验低。
//   - 退到 dataDir/tools/git/：v0.4.0 释放的嵌入式 binary 在那里，用户想"重新选
//     个版本"时可能用上。
//   - 最后 dataDir：纯阐零处理，不同 OS 弹窗默认行为差异就不存在。
//
// 注：userOverride（prefs["app.gitBinaryPath"]）不在这里用。弹窗"重新选"时一般不会复用
// 同一个文件位置（用户想选新版本/新位置）；且复用 userOverride 会让用户拓现"同样 file
// 已被选"的重复场景。
func PickInitialDir(dataDir string) string {
	// 1. PATH git（如 /usr/bin、/opt/homebrew/bin、/Library/Developer/CommandLineTools/usr/bin）
	if path, err := findSystemGit("git"); err == nil {
		if dir := filepath.Dir(path); dir != "" {
			if stat, err := os.Stat(dir); err == nil && stat.IsDir() {
				return dir
			}
		}
	}

	// 2. 已释放的 embedded binary 所在目录（避免空目录）
	toolsGitDir := filepath.Join(dataDir, "tools", "git")
	if stat, err := os.Stat(toolsGitDir); err == nil && stat.IsDir() {
		entries, _ := os.ReadDir(toolsGitDir)
		if len(entries) > 0 {
			return toolsGitDir
		}
	}

	// 3. fallback：dataDir 本身（用户仍可手动 navigate）
	return dataDir
}
