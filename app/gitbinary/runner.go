// Package gitbinary 提供内嵌 Git 二进制的统一抽象层。
//
// v0.4.0 目标：让所有生产代码的 `exec.Command("git", ...)` 走同一个 Runner，
// 用户在 SettingsView 修改 git 路径后立即生效（无需 wails build 重新生成）。
//
// 优先级（ResolveGitBinaryPath）：
//  1. LocalState.GitBinaryPath 非空 → 该值（可能是用户填的自定义路径）
//  2. 内嵌二进制（已由 Init 释放到 ${dataDir}/tools/git/）
//  3. exec.LookPath("git") — 兜底
//
// 当前内置 macos (arm64+amd64) + windows (amd64) 二进制；Linux 平台走 PATH。
//
// 调用方（改造目标，逐步替换现有硬编码 exec.Command 调用）：
//   - app/git/repo.go:97    getCommitFileStatsGit (git diff-tree --numstat)
//   - app/git/native.go:147 EnsureRemote (git remote get-url)
//   - app/git/native.go:152 EnsureRemote (git remote set-url)
//   - app/git/native.go:159 EnsureRemote (git remote add)
//   - app/git/native.go:169 listGitRemotes (git remote)
//   - app/git/native.go:198 fetchRemoteWithFilter (git fetch --filter=blob:none)
//   - app/git/log_vscode.go:81 LogCommitsVscode (git log --branches --remotes HEAD)
//   - app/git/log_vscode.go:228 detectUncommittedChanges (git rev-parse HEAD)
//   - app/git/log_vscode.go:251 detectUncommittedChanges (git status --porcelain)
//   - app/git/ascii_graph.go:166 RunGraphLog (git log --graph --pretty=format:DATA:...)
//   - app/git/ascii_graph.go:269 listRefsByCommit (git for-each-ref)
//
// 已废弃（v0.4.0 同期删除，不再走 git CLI）：
//   - app/git/deepen.go    已被 commit 85e63a8 整文件删除
package gitbinary

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"time"

	"log/slog"
)

// gitVersion 标识内嵌二进制版本号（写入路径 + UI 显示）
const gitVersion = "2.55.0"

// embeddedGitBytesPerPlatform 仅在对应 build tag 下被赋值：
//   - darwin/amd64 → embeddedGitDarwinAmd64
//   - darwin/arm64 → embeddedGitDarwinArm64
//   - windows/amd64 → embeddedGitWindowsAmd64
//
// 其他平台 (linux、freebsd 等) 返回 nil，Init 跳过释放。
//
// 关键修复（v0.8.0 CI 跑通）：把所有 build-tag-specific 变量引用拆到对应 build-tag 文件里，
// 避免 windows runner 编译时引用 darwin-only 变量报 undefined。
//
// embed_darwin.go (//go:build darwin) 定义 embeddedGitBytes() + embeddedGitFileName() darwin 分支
// embed_windows.go (//go:build windows) 定义 embeddedGitBytes() + embeddedGitFileName() windows 分支
// embed_other.go (//go:build !darwin && !windows) 定义 embeddedGitBytes() + embeddedGitFileName() 兜底

// embeddedGitFileName 按平台生成嵌入二进制在 ${dataDir}/tools/git/ 下的文件名：
//
//		v0.4.0 fix-2 关键命名约束：文件名不能以 "git-" 开头。
//		macOS shell（bash/zsh/sh）有 hardcoded 行为：argv0 若以 "git-" 开头会被自动
//		tokenize 成 "git <args>"，PATH 找 git 跑，<args> 当 git 子命令，导致
//		「致命错误：无法作为内置命令处理 2.55.0-macos-amd64」exit 128。
//		实测确认（test/embedded 文件名 = "git-2.55" / "git-bin" / "git-2" 都触发，
//		"git_2.55" / "x-2.55-x" 不触发）。
//
//		命名方案：gk-git-<ver>-<os>-<arch>[.exe]（gk = gitea-kanban 前缀，避免 git- 开头）
//	  - macos：gk-git-<ver>-macos-<arch>（无后缀）
//	  - windows：gk-git-<ver>-windows-<arch>.exe
//
// embeddedGitFileName 的实现按 build tag 拆到 embed_darwin.go / embed_windows.go / embed_other.go。
// 这里保留注释避免下游 reader 困惑。

// initOnce 用 atomic.Bool 守护 Init() 幂等
var initialized atomic.Bool

// defaultBinaryPath 缓存 Init() 释放的内嵌二进制绝对路径，供 ResolveGitBinaryPath
// 作为 fallback 候选 2 用。值为 "" 表示当前平台无内嵌或未释放成功。
var defaultBinaryPath atomic.Value // string

// userBinaryOverride 运行时由 app.SetGitBinaryPath 设置的「用户覆盖」路径。
//
// v0.4.0 引入：让用户在 Settings 改完立即生效，无需 wails build / 重启。
// 优先级（ResolveGitBinaryPath）：
//  1. caller 显式传的 userOverride 参数
//  2. 本字段（globalOverride，运行时由 SetUserOverride 设置）
//  3. defaultBinaryPath（Init 释放的内嵌）
//  4. exec.LookPath("git")
//  5. 全部失败 → 返 error
//
// 与 LocalState.prefs["app.gitBinaryPath"] 共用同源：
//   - 启动期 OnStartup 调 SetUserOverride(store.GetGitBinaryPath())
//   - 用户保存设置：app.SetGitBinaryPath → store.SetGitBinaryPath + gitbinary.SetUserOverride
var userBinaryOverride atomic.Value // string

// Init 启动期一次性初始化：
//
//  1. 按当前 runtime.GOOS + runtime.GOARCH 把嵌入的 git 二进制释放到
//     ${dataDir}/tools/git/<fileName>，parent 目录自动 MkdirAll 0755
//  2. 释放后 chmod 0755（darwin/linux；windows 跳过）
//  3. macOS 平台启动 `xattr -p <path>` 检查 com.apple.quarantine，
//     有则 `xattr -d com.apple.quarantine <path>` 尝试自动剥离（仍可能触发 Gatekeeper 弹窗，
//     见 macOS_GATEKEEPER_NOTES.md，由 UI hint 兜底引导用户「系统设置 → 隐私与安全 → 仍要打开」）
//  4. 二进制内容为空（dev 期 0 字节 placeholder）→ 跳过释放，
//     WARNING 日志：内嵌二进制缺失，请 wails build 前替换
//  5. 释放成功 → defaultBinaryPath.Set(absPath)
//
// 不要并发调。App.OnStartup 在所有 git/go-git 子包初始化后调用一次。
func Init(dataDir string, logger *slog.Logger) error {
	if initialized.Load() {
		return nil
	}
	defer initialized.Store(true)

	toolsDir := filepath.Join(dataDir, "tools", "git")
	bin := embeddedGitBytes()
	fileName := embeddedGitFileName()
	target := filepath.Join(toolsDir, fileName)

	if len(bin) == 0 {
		// dev 期 0 字节 placeholder / 平台不支持
		if logger != nil {
			logger.Warn("gitbinary: 嵌入二进制为空，跳过释放；运行期走 exec.LookPath(\"git\") 兜底",
				"platform", runtime.GOOS,
				"arch", runtime.GOARCH,
				"expected", target,
			)
		}
		defaultBinaryPath.Store("")
		return nil
	}

	// 释放到磁盘
	if err := os.MkdirAll(toolsDir, 0o755); err != nil {
		if logger != nil {
			logger.Error("gitbinary: 创建 tools/git 目录失败",
				"dir", toolsDir, "err", err.Error())
		}
		return fmt.Errorf("创建 git binary 目录失败: %w", err)
	}
	if err := os.WriteFile(target, bin, 0o644); err != nil {
		if logger != nil {
			logger.Error("gitbinary: 释放嵌入二进制失败",
				"target", target, "size", len(bin), "err", err.Error())
		}
		return fmt.Errorf("释放嵌入 git binary 失败: %w", err)
	}
	// unix 系 chmod 0755；windows 不需执行位（.exe 直接 OS loader 读 PE）
	if runtime.GOOS != "windows" {
		if err := os.Chmod(target, 0o755); err != nil {
			if logger != nil {
				logger.Warn("gitbinary: chmod 0755 失败",
					"target", target, "err", err.Error())
			}
		}
	}

	// macOS Gatekeeper 自动剥离 quarantine（user 拍板 2026-07-02）
	// 失败时 hint UI 引导用户手动允许
	if runtime.GOOS == "darwin" {
		if status, err := checkQuarantine(target); err == nil && status {
			if stripErr := stripQuarantine(target); stripErr != nil {
				if logger != nil {
					logger.Warn("gitbinary: 剥离 macOS quarantine 失败，需用户手动允许",
						"target", target, "xattrErr", stripErr.Error(),
						"hint", "系统设置 → 隐私与安全 → 仍要打开")
				}
			} else {
				if logger != nil {
					logger.Info("gitbinary: macOS quarantine 已剥离",
						"target", target)
				}
			}
		}
	}

	defaultBinaryPath.Store(target)
	if logger != nil {
		logger.Info("gitbinary: 嵌入二进制释放成功",
			"version", gitVersion,
			"platform", runtime.GOOS,
			"arch", runtime.GOARCH,
			"target", target)
	}

	// v0.4.0 fix-1：smoke test <bin> --version
	// 场景：cross-arch 释放（如在 x86_64 build 而 arm64 Mac 跑），bypass Rosetta 时 shell 路径解析失败
	//   → 静默降级：smoke test 失败 → 清空 defaultBinaryPath + WARN 日志
	//   → 上层 ResolveGitBinaryPath 自动 fallback 到 PATH git
	// 用户真机若 arm64 Mac 但 wails binary 是 x86_64 build，smoke test 会失败，
	//   自动走 `/usr/bin/git`（Apple Git）而不是奔溃。
	smokeCtx, smokeCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer smokeCancel()
	smokeCmd := exec.CommandContext(smokeCtx, target, "--version")
	smokeCmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	if smokeOutput, smokeErr := smokeCmd.CombinedOutput(); smokeErr != nil {
		if logger != nil {
			logger.Warn("gitbinary: 释放后 smoke test 失败，清空 defaultBinaryPath 让上层 fallback PATH git",
				"target", target,
				"err", smokeErr.Error(),
				"output-truncated", truncateForLog(string(smokeOutput), 200),
			)
		}
		// 清空让 ResolveGitBinaryPath 走 PATH git（用户 OS 自带）
		defaultBinaryPath.Store("")
		// Init 本身不报错：跨 arch 是部署问题，不阻断应用启动
	}
	return nil
}

// truncateForLog 截断过长 stderr 输出到日志（跨 arch 错误可填满 5KB）
func truncateForLog(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "..."
}

// ResolveGitBinaryPath 按优先级返回当前 RunGit 应使用的 git 二进制绝对路径：
//
//	v0.5 优先级（user-mid-turn steer：2-button 模式区分）：
//	1. callerOverride 非空 + 非 sentinel：
//	   - 验证文件存在，存在即用（用户填的具体 custom path）
//	2. callerOverride == EMBEDDED_SENTINEL（="$EMBEDDED$"，2-button UI 选的「使用内嵌」）：
//	   - 强制走 Init 释放的 embedded binary（不 fallback PATH）
//	   - 失败 → 返 error，让 SettingsView 提示用户换 system
//	3. userBinaryOverride（app.SetGitBinaryPath 设的）→ 同 1/2
//	4. callerOverride == "" + SetUserOverride 已设 → 同 1/2
//	5. callerOverride 全空：
//	   - exec.LookPath("git") → PATH git（v0.4.0 fix-1 兜底）
//	   - defaultBinaryPath（Init 释放的内嵌）→ 兜底
//	   - 都失败 → error
//
// v0.5 修订说明：
//   - v0.4.0 fix-1 让 PATH git 提到 embedded 之前：默认走用户 OS 自带 git；
//     兼容性最好但「嵌 vs 系」UX 无差异（都走 PATH）。
//   - v0.5 加 EMBEDDED_SENTINEL magic string，让 SettingsView「使用内嵌」按钮
//     能真强制走 embedded binary（override PATH fallback）。
//   - sentinel 同步：app/gitbinary/runner.go 与 frontend/src/views/SettingsView.vue
//     各 hard-code '$EMBEDDED$'，改任一要两边同步。
const EMBEDDED_SENTINEL = "$EMBEDDED$" // 跨包需 export（大写首）

func ResolveGitBinaryPath(callerOverride string) (string, error) {
	effective := strings.TrimSpace(callerOverride)
	if effective == "" {
		if g, ok := userBinaryOverride.Load().(string); ok {
			effective = strings.TrimSpace(g)
		}
	}
	// v0.5：「使用内嵌」按钮的 sentinel：跳过 PATH/USER 路径，强制走 Init 释放的 binary
	//   注意：callerOverride 全空分支（mode=system）会先 fallback PATH，已被 Init smoke test 覆盖
	if effective == EMBEDDED_SENTINEL {
		if def, ok := defaultBinaryPath.Load().(string); ok && def != "" {
			if _, err := os.Stat(def); err == nil {
				return def, nil
			}
		}
		return "", fmt.Errorf("「使用内嵌」模式下内嵌 git 二进制不可用；请切换到「使用系统安装的 git」或重装应用")
	}
	if effective != "" {
		// user custom path：stat 校验失败仍返该值
		if _, err := os.Stat(effective); err == nil {
			return effective, nil
		}
		return effective, nil
	}

	// PATH 优先：用户 OS 自带 git 通常稳定
	if path, err := exec.LookPath("git"); err == nil {
		return path, nil
	}

	// 内嵌二进制 fallback：无系统 git 装机罕见场景靠这个
	if def, ok := defaultBinaryPath.Load().(string); ok && def != "" {
		if _, err := os.Stat(def); err == nil {
			return def, nil
		}
	}

	return "", fmt.Errorf("未找到 git 二进制：请在「设置 → Git 二进制」选择路径，或安装系统 git (PATH 中需有 'git')")
}

// SetUserOverride 设置全局 git binary 路径覆盖（应用层用，单独调用）。
//
// app.SetGitBinaryPath 在持久化到 LocalState.prefs 后调一次，让本次进程后续
// 所有 git 调用（log / clone / diff-tree / fetch）立刻走新路径，无需重启。
//
// 传 "" 即清空覆盖，回退到内嵌 / PATH git。
func SetUserOverride(path string) {
	userBinaryOverride.Store(strings.TrimSpace(path))
}

// UserOverride 暴露当前全局覆盖值，UI 初始化默认值用。
func UserOverride() string {
	if v, ok := userBinaryOverride.Load().(string); ok {
		return v
	}
	return ""
}

// DefaultBinaryPath 暴露当前平台默认（嵌入释放后）的 git 路径，UI 显示用。
// 值为 "" 表示当前平台无嵌入 / Init 跳过。
func DefaultBinaryPath() string {
	if def, ok := defaultBinaryPath.Load().(string); ok {
		return def
	}
	return ""
}

// RunGit 统一 git CLI 调用入口。
//
//	ctx        强制 5 min 超时（与原 nativeGitTimeout 对齐）
//	localPath  -C <localPath> 前置参数，"" 时省略（部分命令如 `git --version` 不需要）
//	args       git 子命令 + 参数
//
// 内部拼接 Path(bin, args[0]...) 用 exec.CommandContext；
// 捕 stderr + stdout → CombinedOutput。
func RunGit(ctx context.Context, binPath string, localPath string, args ...string) ([]byte, error) {
	return RunGitWithEnv(ctx, binPath, localPath, nil, args...)
}

// RunGitWithEnv 与 RunGit 同，但接受额外 env 注入（key=value map）。
//
// v0.4.0 引入原因：app/git/native.go 的 fetchRemoteWithFilter/CloneWithFilter
// 走 gh credential helper（GitHub 私有仓库认证），需要注入 GH_TOKEN env；
// 之前用 configureGitHubCLIEnv + cmd.Env 手动设置，现在统一走 runner。
//
// envVars 为 nil 时等价 RunGit。
//
// 自动追加 env:
//   - GIT_TERMINAL_PROMPT=0（不抢认证锁）
func RunGitWithEnv(ctx context.Context, binPath string, localPath string, envVars map[string]string, args ...string) ([]byte, error) {
	if binPath == "" {
		return nil, fmt.Errorf("gitbinary: 无可用 git 路径")
	}
	fullArgs := make([]string, 0, len(args)+2)
	if localPath != "" {
		fullArgs = append(fullArgs, "-C", localPath)
	}
	fullArgs = append(fullArgs, args...)

	cmd := exec.CommandContext(ctx, binPath, fullArgs...)
	baseEnv := []string{"GIT_TERMINAL_PROMPT=0"}
	cmd.Env = append(os.Environ(), baseEnv...)
	for k, v := range envVars {
		if k == "" {
			continue
		}
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	output, err := cmd.CombinedOutput()
	if err != nil {
		return output, fmt.Errorf("git 调用失败（%s %s）：%w\n输出: %s", binPath, strings.Join(args, " "), err, string(output))
	}
	return output, nil
}

// TestGitBinary 验证给定 git 二进制是否可执行。
//
// 实现：
//  1. stat 文件存在 + 是可执行 (mode & 0111) 或 .exe 后缀
//  2. 调用 <binPath> --version，捕获 stdout，期望首行匹配 `git version X.Y.Z`
//  3. macOS 平台检查 quarantine 属性；有 → 返回 hint，调用方按需 strip
//
// 返回 TestGitResult ok=true 表示版本号合法、推荐使用；hint 在 macOS 给出系统设置指引。
type TestGitResult struct {
	OK      bool   `json:"ok"`
	Version string `json:"version"` // e.g. "2.55.0"
	Path    string `json:"path"`    // 实际 stat 出来的绝对路径
	Message string `json:"message"` // 人话描述（失败原因 / 成功信息 / quarantine 提示）
	Hint    string `json:"hint"`    // 额外建议（macOS Gatekeeper / 安装提示）
}

// TestGitBinary 验证用户在 SettingsView 选择的 git 路径是否正确。
//
// 该 API 用于前端点击「测试」按钮 + 「保存」前的 dry-run。
// 不修改任何状态，仅 stat + 执行 --version。
func TestGitBinary(binPath string) TestGitResult {
	binPath = strings.TrimSpace(binPath)
	if binPath == "" {
		return TestGitResult{Message: "路径为空", Hint: "请输入 git 二进制的绝对路径"}
	}
	// 文件存在性
	info, err := os.Stat(binPath)
	if err != nil {
		return TestGitResult{
			Message: fmt.Sprintf("文件不存在：%s", binPath),
			Hint:    "请确认路径正确；macOS 输入 .app/Contents/MacOS/git 形式，Windows 输入 .exe 路径",
		}
	}
	if info.IsDir() {
		return TestGitResult{Message: "路径是目录而非文件", Hint: "请选择 git 二进制文件本身，不是它所在的目录"}
	}
	// 执行权限（unix）/ .exe 后缀（windows）
	if runtime.GOOS == "windows" {
		if !strings.HasSuffix(strings.ToLower(binPath), ".exe") {
			return TestGitResult{Message: "Windows 上 git 路径应指向 .exe 文件", Hint: "Git for Windows 安装后默认路径是 cmd/git.exe"}
		}
	} else {
		// mode & 0111：owner/group/others 任一可执行位
		if info.Mode()&0o111 == 0 {
			return TestGitResult{Message: "文件不可执行（缺少执行位）", Hint: "在终端运行：chmod +x <path>"}
		}
	}

	// 调用 --version
	ctx, cancel := context.WithTimeout(context.Background(), 10*1e9) // 10s
	defer cancel()
	output, err := exec.CommandContext(ctx, binPath, "--version").CombinedOutput()
	outStr := strings.TrimSpace(string(output))
	if err != nil {
		return TestGitResult{
			Message: fmt.Sprintf("调用 --version 失败：%s", err.Error()),
			Hint:    "确认文件是合法 git 二进制（不是 .app bundle 或 .dmg 之类）",
		}
	}
	// 期望格式：`git version 2.55.0`（也可能是 `git version 2.55.0.windows.1`，保留 .windows.X）
	if !strings.HasPrefix(outStr, "git version ") {
		return TestGitResult{
			Message: fmt.Sprintf("输出不是 git --version 格式：%q", outStr),
			Hint:    "请确认这是 git 客户端二进制（不是 gh / git-lfs / 其它工具）",
		}
	}
	versionStr := strings.TrimPrefix(outStr, "git version ")
	// 把 `2.55.0.windows.1` 截到 `2.55.0` 给 UI 显示（windows 走 .windows.X 后缀不影响）
	if idx := strings.Index(versionStr, " "); idx >= 0 {
		versionStr = versionStr[:idx]
	}
	if idx := strings.Index(versionStr, "\n"); idx >= 0 {
		versionStr = versionStr[:idx]
	}

	res := TestGitResult{
		OK:      true,
		Version: versionStr,
		Path:    binPath,
		Message: fmt.Sprintf("✓ git %s 测试通过", versionStr),
	}

	// macOS Gatekeeper 检查
	if runtime.GOOS == "darwin" {
		if quarantined, _ := checkQuarantine(binPath); quarantined {
			res.Message = fmt.Sprintf("✓ git %s 可执行（首次运行可能被 Gatekeeper 拦截）", versionStr)
			res.Hint = "如果运行时报「无法打开，因为来自身份不明的开发者」：" +
				"右键 → 打开 → 仍要打开；或在本应用「设置 → Git 二进制」点「解除隔离」自动剥离 quarantine 属性"
		}
	}

	return res
}

// StripQuarantine 主动剥离 macOS quarantine 属性（用户点「解除隔离」按钮调）。
// 仅 macOS 有效，其它平台返 nil。
func StripQuarantine(binPath string) error {
	if runtime.GOOS != "darwin" {
		return nil
	}
	return stripQuarantine(binPath)
}

// checkQuarantine macOS 上检查文件是否有 com.apple.quarantine 属性。
func checkQuarantine(path string) (bool, error) {
	if runtime.GOOS != "darwin" {
		return false, nil
	}
	cmd := exec.Command("xattr", "-p", path)
	out, err := cmd.Output()
	if err != nil {
		// xattr 找不到属性返 exit=1 + 空输出，区分于失败
		if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
			return false, nil
		}
		return false, err
	}
	return strings.Contains(string(out), "com.apple.quarantine"), nil
}

// stripQuarantine 调 `xattr -d com.apple.quarantine <path>`。
// 在已剥离的情况下 xattr 返 exit=1，忽略该错误。
func stripQuarantine(path string) error {
	if runtime.GOOS != "darwin" {
		return nil
	}
	cmd := exec.Command("xattr", "-d", "com.apple.quarantine", path)
	if err := cmd.Run(); err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
			return nil // 已剥离
		}
		return err
	}
	return nil
}
