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
	"io/fs"
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
//  3. 把嵌入的 Windows remote helper + DLL 依赖（git-remote-https.exe 等）释放到
//     tools/git/ 同目录（仅 windows 平台有嵌入 helper；详见 embed_windows.go）
//  4. macOS 平台启动 `xattr -p <path>` 检查 com.apple.quarantine，
//     有则 `xattr -d com.apple.quarantine <path>` 尝试自动剥离（仍可能触发 Gatekeeper 弹窗，
//     见 macOS_GATEKEEPER_NOTES.md，由 UI hint 兜底引导用户「系统设置 → 隐私与安全 → 仍要打开」）
//  5. 二进制内容为空（dev 期 0 字节 placeholder）→ 跳过释放，
//     WARNING 日志：内嵌二进制缺失，请 wails build 前替换
//  6. 释放成功 → defaultBinaryPath.Set(absPath)
//  7. smoke test <bin> --version（失败仅 WARN 不报错，跨 arch 部署场景）
//     Windows 平台额外测 `git ls-remote <public repo>`，验证 remote helper 能找到
//     （helper 缺失会立刻报 'remote-https is not a git command'）
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

	// v0.8.27+：释放 Windows git remote helper + DLL 依赖到同目录。
	//
	// 根因：内嵌 git 主二进制（cmd/git.exe 单文件）不带 git-remote-https.exe 等
	// remote helper，也不带 libcurl/libssl 等 DLL 依赖。Windows 上 `git fetch <https>`
	// 会 fork git-remote-https.exe，helper 查找路径 <argv0>/../mingw64/libexec/git-core
	// （单文件布局不存在）→ PATH（用户没装系统 git）→ 报错。
	//
	// 修法：把 helper + DLL 释放到 tools/git/ 同目录，RunGit / RunGitWithEnv 时注入
	// GIT_EXEC_PATH=<toolsDir> 让 git 能找到 helper。
	//
	// 失败处理：仅 WARN 不阻断应用启动——helper 缺失不会让 `git log` / `git rev-parse`
	// 等本地命令失败，只有 fetch / pull / push 这种需要远程通信的命令才会失败。
	if helperReleased := releaseHelpers(target, toolsDir, logger); !helperReleased {
		if logger != nil {
			logger.Warn("gitbinary: remote helper 释放失败/未嵌入；fetch/pull/push 到 https remote 将失败",
				"platform", runtime.GOOS, "hint", "确认 app/gitbinary/binaries/git/windows-helper/ 含 .exe + .dll")
		}
	}

	// v0.8.27+：在 Windows 上创建 git.exe shim（同目录的 gk-git exe 复制成 git.exe）。
	//
	// 根因 2：git 主进程 fork `git remote-https` 时，OS 用 execvp("git", ...)，
	// 在 PATH 中找 `git.exe`。我们的 git 名字是 gk-git-2.55.0-windows-amd64.exe，
	// 子进程 PATH 找不到。两种修法：
	//   1. 在调用方注入 PATH 前置 tools/git/ → GitEnvFor 实现
	//   2. 在 tools/git/ 创建 `git.exe` shim（gk-git 复制成 git.exe）→ OS 在
	//      PATH 找到 shim
	//
	// 两条都要做：GIT_EXEC_PATH 用于 git 内部 exec-path 解析（child process 找
	// 自己的 argv0 目录时），git.exe shim 用于 OS 层面 PATH 查找。少任何一条都会
	// 在某种场景下撞回原 bug。
	if runtime.GOOS == "windows" {
		shimPath := filepath.Join(toolsDir, "git.exe")
		if _, err := os.Stat(shimPath); os.IsNotExist(err) {
			// 复制 target (gk-git-2.55.0-windows-amd64.exe) 到 git.exe
			if data, readErr := os.ReadFile(target); readErr == nil {
				if writeErr := os.WriteFile(shimPath, data, 0o644); writeErr == nil {
					if logger != nil {
						logger.Info("gitbinary: 创建 git.exe shim 成功（让子进程 PATH 查找找到内嵌 git）",
							"shim", shimPath, "size", len(data))
					}
				} else if logger != nil {
					logger.Warn("gitbinary: 创建 git.exe shim 失败（写 shim 错误）",
						"shim", shimPath, "err", writeErr.Error())
				}
			} else if logger != nil {
				logger.Warn("gitbinary: 创建 git.exe shim 失败（读主二进制错误）",
					"target", target, "err", readErr.Error())
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
		return nil
	}

	// v0.8.27+：Windows 平台额外 smoke test helper 链路。
	//
	// 用 `ls-remote https://github.com/git/git.git HEAD` 测：触发 git 实际 fork
	// git-remote-https.exe 走 HTTPS 通道。如果 helper 没正确释放或 GIT_EXEC_PATH
	// 没注入，会立刻报 'remote-https is not a git command'。失败仅 WARN 不阻断
	// 启动——离线环境用户可能不需要马上 fetch。
	if runtime.GOOS == "windows" {
		helperCtx, helperCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer helperCancel()
		// ls-remote 不修改本地仓库，纯净探测
		helperCmd := exec.CommandContext(helperCtx, target, "ls-remote", "https://github.com/git/git.git", "HEAD")
		helperCmd.Env = GitEnvFor(target, nil)
		if helperOutput, helperErr := helperCmd.CombinedOutput(); helperErr != nil {
			if logger != nil {
				logger.Warn("gitbinary: helper smoke test 失败（remote helper 可能缺失或 GIT_EXEC_PATH 未生效）",
					"target", target,
					"err", helperErr.Error(),
					"output-truncated", truncateForLog(string(helperOutput), 400),
					"hint", "fetch/pull/push 到 https remote 将失败；检查 app/gitbinary/binaries/git/windows-helper/ 内容")
			}
			// 仅 WARN 不清空 defaultBinaryPath：本地命令（log / rev-parse / diff-tree）仍可用
		}
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
		// v0.8.2 fix：embedded binary 不可用时（占位文件 / cross-arch 部署）
		// 降级到 PATH git 而不是报错。否则用户点"使用内嵌"看到"切换失败"但无法使用。
		if path, err := exec.LookPath("git"); err == nil {
			return path, nil
		}
		return "", fmt.Errorf("「使用内嵌」模式下内嵌 git 二进制不可用（可能应用未完整安装）；请切换到「使用系统安装的 git」或重装应用")
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
	configureCmdHideWindow(cmd)
	// v0.8.27+：用 GitEnvFor 注入 GIT_EXEC_PATH（Windows 内嵌二进制需要让 git 找到
	// git-remote-https.exe 等 helper）+ GIT_TERMINAL_PROMPT=0，caller 的 envVars
	// 覆盖同名 key。
	cmd.Env = GitEnvFor(binPath, envVars)
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
	cmd := exec.CommandContext(ctx, binPath, "--version")
	configureCmdHideWindow(cmd)
	output, err := cmd.CombinedOutput()
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

// releaseHelpers 把嵌入的 remote helper + DLL 依赖释放到 git 主二进制同目录。
//
// 背景：Windows 上内嵌 git（MinGit 单文件 exe）不带 git-remote-https.exe 等 helper，
// 也不带 libcurl/libssl 等 DLL 依赖。`git fetch <https remote>` 会 fork helper，
// helper 查找路径 <argv0>/../mingw64/libexec/git-core（不存在）→ PATH（无系统 git）→
// 报错 'remote-https is not a git command'。
//
// 修法：把 helper 释放到 git 主二进制同目录，RunGitWithEnv 注入 GIT_EXEC_PATH 让 git
// 能找到 helper。
//
// 返回 true 表示至少成功释放了一个 helper 文件；false 表示当前平台无嵌入 helper 或
// 释放失败（其他平台总是 false，因为只有 windows 嵌入）。
func releaseHelpers(target string, toolsDir string, logger *slog.Logger) bool {
	if !embeddedHelperAvailable() {
		return false
	}
	helperFS := embeddedHelperFS()
	if helperFS == nil {
		return false
	}

	count := 0
	err := fs.WalkDir(helperFS, ".", func(p string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if d.IsDir() {
			return nil
		}
		// 读嵌入内容
		data, readErr := fs.ReadFile(helperFS, p)
		if readErr != nil {
			return fmt.Errorf("读嵌入 helper %s 失败: %w", p, readErr)
		}
		// 直接释放到 toolsDir（不重建子目录——helper 都在 helperFS 根目录下）
		dst := filepath.Join(toolsDir, filepath.Base(p))
		if writeErr := os.WriteFile(dst, data, 0o644); writeErr != nil {
			return fmt.Errorf("释放 helper %s → %s 失败: %w", p, dst, writeErr)
		}
		count++
		return nil
	})

	if err != nil {
		if logger != nil {
			logger.Error("gitbinary: helper 释放失败",
				"target", target, "err", err.Error())
		}
		return false
	}
	if logger != nil {
		logger.Info("gitbinary: remote helper + DLL 释放成功",
			"target", target, "files", count, "dir", toolsDir)
	}
	return count > 0
}

// GitEnvFor 构造 git 子进程 env，注入 GIT_EXEC_PATH + PATH 前置让 git 找到 remote helper。
//
// v0.8.27+ 引入：Windows 内嵌 git 是 MinGit 单文件布局，git 主进程 fork
// `git remote-https` 时按以下顺序查找 helper：
//
//  1. <argv0>/../mingw64/libexec/git-core/  ← 单文件布局不存在
//  2. GIT_EXEC_PATH env（如果设置）        ← 我们注入
//  3. execvp("git") in PATH                  ← 我们把 tools/git 加到 PATH 前置
//
// 修法（双保险）：当 binPath 位于 ${dataDir}/tools/git/ 下时（即内嵌二进制），强制
// 注入 GIT_EXEC_PATH=<binPath dir>，并把 <binPath dir> 追加到 PATH 最前面，让 OS
// execvp("git") 优先找到我们创建的 git.exe shim（Init() 复制 gk-git 释放）。
// 系统 git / 用户自定义路径不注入——它们的相对 exec-path 解析依赖 PATH 上的兄弟
// 目录结构，强行覆盖反而会破坏。
//
// extraEnv 为 nil 时只注入 GIT_EXEC_PATH + GIT_TERMINAL_PROMPT=0；
// 非 nil 时把 extraEnv 合并进结果（覆盖同名 key）。
func GitEnvFor(binPath string, extraEnv map[string]string) []string {
	binDir := filepath.Dir(binPath)
	defBinPath := DefaultBinaryPath()
	// 只有当 binPath 就在内嵌二进制目录里（即 binDir == defBinPath 所在 dir）时注入
	shouldInject := defBinPath != "" && strings.EqualFold(filepath.Clean(binDir), filepath.Clean(filepath.Dir(defBinPath)))

	env := os.Environ()
	// 去重：保留第一次出现的 key，移除后续重复项（避免 cmd.Env 出现两个 GIT_EXEC_PATH）
	if shouldInject {
		// PATH 前置：让 execvp("git") 优先找到 tools/git/git.exe shim
		// 保留原 PATH 中其它 entry（user git / gh / scoop shims 等）
		env = prependPathToEnv(env, binDir)
		// GIT_EXEC_PATH：让 git 内部 exec-path 解析找到 helper
		env = dedupAndAppend(env, "GIT_EXEC_PATH="+binDir)
	}
	env = dedupAndAppend(env, "GIT_TERMINAL_PROMPT=0")

	// extraEnv 由 caller 注入（如 GH_TOKEN / GIT_CONFIG_*）
	// 同样去重：保留 caller 覆盖
	for k, v := range extraEnv {
		if k == "" {
			continue
		}
		env = dedupAndAppend(env, k+"="+v)
	}
	return env
}

// prependPathToEnv 把 dir 插入到 env 中 PATH= 后面第一位。
//
// Windows PATH 分号分隔（大小写不敏感）；unix 冒号分隔。去重（如果 dir 已在 PATH
// 中则不重复插入）。这是 GitEnvFor 专用的内部 helper。
func prependPathToEnv(env []string, dir string) []string {
	const key = "PATH="
	// 找出现有 PATH entry（大小写不敏感）
	for i, e := range env {
		upper := strings.ToUpper(e)
		if !strings.HasPrefix(upper, "PATH=") {
			continue
		}
		val := e[len(key):]
		// 检查 dir 是否已在 PATH 中
		sep := ":"
		if runtime.GOOS == "windows" {
			sep = ";"
		}
		parts := strings.Split(val, sep)
		for _, p := range parts {
			if strings.EqualFold(strings.TrimSpace(p), dir) {
				return env // already present, no prepend needed
			}
		}
		// 插入 dir 到 PATH 最前
		newVal := dir
		if val != "" {
			newVal = dir + sep + val
		}
		env[i] = key + newVal
		return env
	}
	// 没找到 PATH，添加新的
	return append(env, key+dir)
}

// dedupAndAppend 移除 env 中所有以 "key=" 开头的 entry，追加新 entry。
// 用于避免 cmd.Env 出现两个 GIT_EXEC_PATH（一个是基础，一个是 caller override）。
func dedupAndAppend(env []string, entry string) []string {
	eq := strings.Index(entry, "=")
	if eq < 0 {
		return env
	}
	prefix := entry[:eq+1]
	for i, e := range env {
		if strings.HasPrefix(e, prefix) {
			env = append(env[:i], env[i+1:]...)
			break
		}
	}
	return append(env, entry)
}
