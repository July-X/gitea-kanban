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
	//
	//	v0.5-mid4 重点：symlink 解析
	//	  exec.LookPath() 返回 PATH 上第一个匹配（可能是 symlink，如 Homebrew 的
	//	  /opt/homebrew/bin/git → /opt/homebrew/Cellar/git/2.55.0/bin/git）。
	//	  用 filepath.EvalSymlinks() 解到实体路径，再取 dir =
	//	  "/opt/homebrew/Cellar/git/2.55.0/bin/" 这样的真实安装 bin 目录，
	//	  而不是 /opt/homebrew/bin/ (symlink 所在 bin)。用户能直接看到该版本
	//	  的 git binary，而不必 navigate 进 Cellar/{version}/bin/。
	if path, err := findSystemGit("git"); err == nil {
		dir := systemGitDir(path)
		if stat, err := os.Stat(dir); err == nil && stat.IsDir() {
			return dir
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

// systemGitDir 解析 git binary 的 symlink，返回其 bin 目录。
//
// 场景与 fallback：
//   - path 是 symlink（如 Homebrew /opt/homebrew/bin/git）
//     → EvalSymlinks 拿实体 /opt/homebrew/Cellar/git/2.55.0/bin/git
//     → Dir /opt/homebrew/Cellar/git/2.55.0/bin/
//   - path 是非 symlink（如 /usr/bin/git、/Library/Developer/.../git）
//     → EvalSymlinks 返同路径，Dir 即为真实 bin 目录
//   - EvalSymlinks 报错（文件已删除 / 权限 / 死链）
//     → 静默 fallback 到原始 path 的 Dir（symlink 所在 dir 通常仍能 navigate）
//
// 提取为 package-level 函数便于 unit test 复用 stub。
func systemGitDir(path string) string {
	if real, err := filepath.EvalSymlinks(path); err == nil {
		return filepath.Dir(real)
	}
	return filepath.Dir(path)
}
