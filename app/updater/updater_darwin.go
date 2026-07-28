//go:build darwin

package updater

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// applyMacOS macOS dmg 自动安装：挂载 dmg → 提取 .app → 生成 helper 脚本
// 等待当前进程退出后原位替换 .app bundle 并重启。
//
// 设计参考 DeepSeek-Reasonix desktop/updater_mac.go（user 指定参考项目）：
//   - 当前进程不能直接替换自己（LaunchServices 会拒绝打开被改的 bundle），
//     所以先启动 detached helper 脚本，主进程随后由前端调 Quit 退出；
//     helper 轮询等待旧 PID 消失再动手替换。
//   - 替换失败走 rollback：把 backup .app 移回原位并重新打开，保证用户机器上
//     永远有一个可用版本。
//   - v0.8.22 的「打开 dmg 让用户手动拖」路径已由本函数取代（user 反馈需要
//     下载完成后一键自动安装）。
func applyMacOS(dmgPath string, logger func(level, format string, args ...any), openBrowser func(url string) error) error {
	if logger != nil {
		logger("info", "update: macOS apply start, dmg=%s", dmgPath)
	}

	currentApp, err := currentMacAppBundle()
	if err != nil {
		return err
	}

	// 1. 挂载 dmg（只读）提取 .app bundle
	attachOut, err := exec.Command("hdiutil", "attach", "-readonly", "-nobrowse", "-noverify", "-noautoopen", dmgPath).Output()
	if err != nil {
		return fmt.Errorf("%w: hdiutil attach dmg: %v", ErrApplyFailed, err)
	}
	mountPoint := ""
	for _, line := range strings.Split(string(attachOut), "\n") {
		fields := strings.Split(line, "\t")
		if len(fields) >= 2 && strings.HasPrefix(strings.TrimSpace(fields[len(fields)-1]), "/Volumes/") {
			mountPoint = strings.TrimSpace(fields[len(fields)-1])
			break
		}
	}
	if mountPoint == "" {
		return fmt.Errorf("%w: hdiutil attach 输出找不到挂载点", ErrApplyFailed)
	}

	staging, err := os.MkdirTemp("", "gitea-kanban-mac-update-*")
	if err != nil {
		_ = exec.Command("hdiutil", "detach", mountPoint).Run()
		return fmt.Errorf("%w: mktemp staging: %v", ErrApplyFailed, err)
	}

	newApp, err := findMacAppBundle(mountPoint)
	if err != nil {
		_ = exec.Command("hdiutil", "detach", mountPoint).Run()
		_ = os.RemoveAll(staging)
		return err
	}

	// 2. 把 dmg 里的 .app 复制到 staging（先 detach，dmg 挂载点不再依赖）
	stagedApp := filepath.Join(staging, filepath.Base(newApp))
	if err := exec.Command("ditto", newApp, stagedApp).Run(); err != nil {
		_ = exec.Command("hdiutil", "detach", mountPoint).Run()
		_ = os.RemoveAll(staging)
		return fmt.Errorf("%w: ditto 提取 .app: %v", ErrApplyFailed, err)
	}
	if err := exec.Command("hdiutil", "detach", mountPoint).Run(); err != nil && logger != nil {
		logger("warn", "update: hdiutil detach %s 失败: %v", mountPoint, err)
	}

	// 3. 启动 detached helper 脚本：等旧进程退出 → 替换 → 重启
	backupApp := currentApp + ".gitea-kanban-update-backup"
	script := filepath.Join(staging, "install-gitea-kanban-update.sh")
	logPath := filepath.Join(staging, "update-helper.log")
	body := macUpdateHelperScript(currentApp, stagedApp, backupApp, staging, logPath, os.Getpid())
	if err := os.WriteFile(script, []byte(body), 0o700); err != nil {
		_ = os.RemoveAll(staging)
		return fmt.Errorf("%w: 写 helper 脚本: %v", ErrApplyFailed, err)
	}

	cmd := exec.Command("/bin/sh", script)
	if err := cmd.Start(); err != nil {
		_ = os.RemoveAll(staging)
		return fmt.Errorf("%w: 启动 helper 脚本: %v", ErrApplyFailed, err)
	}
	// detached：不 Wait，helper 自己跑到退出；主进程由前端随后调 Quit 退出。

	if logger != nil {
		logger("info", "update: macOS helper started (pid=%d), 等待应用退出后自动替换并重启", cmd.Process.Pid)
	}
	return nil
}

// macUpdateHelperScript 生成在后台独立运行的替换脚本。
//
// 流程：轮询等旧 PID 退出（最多 60 秒）→ mv 当前 .app 到 backup →
// ditto 新版到原位 → 去 quarantine → open -n 重启；任一步失败 rollback。
func macUpdateHelperScript(currentApp, newApp, backupApp, staging, logPath string, oldPID int) string {
	return fmt.Sprintf(`#!/bin/sh
set -u
old_app=%q
new_app=%q
backup_app=%q
staging=%q
log_file=%q
old_pid=%d
exec >>"$log_file" 2>&1
echo "gitea-kanban macOS update handoff started for PID $old_pid"

# 等待主进程退出：LaunchServices 对运行中的 bundle 注册未释放时，
# 替换后 open 可能拉起旧实例（参考 DeepSeek-Reasonix #5149 的踩坑）。
attempt=0
while kill -0 "$old_pid" 2>/dev/null; do
  if [ "$attempt" -ge 300 ]; then
    echo "timed out waiting for PID $old_pid to exit"
    rm -rf "$staging"
    open "$old_app" >/dev/null 2>&1 || true
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep 0.2
done

rollback() {
  echo "rolling back macOS update"
  rm -rf "$old_app"
  if ! mv "$backup_app" "$old_app"; then
    echo "failed to restore backup bundle"
  fi
  xattr -dr com.apple.quarantine "$old_app" 2>/dev/null || true
  open -n "$old_app" >/dev/null 2>&1 || open "$old_app" >/dev/null 2>&1 || true
  rm -rf "$staging"
  exit 1
}

rm -rf "$backup_app"
if ! mv "$old_app" "$backup_app"; then
  echo "failed to move current app bundle to backup"
  rm -rf "$staging"
  open "$old_app" >/dev/null 2>&1 || true
  exit 1
fi
if ! ditto "$new_app" "$old_app"; then
  echo "failed to copy replacement app bundle"
  rollback
fi
xattr -dr com.apple.quarantine "$old_app" 2>/dev/null || true
if ! open -n "$old_app"; then
  echo "LaunchServices rejected the replacement app bundle"
  rollback
fi
echo "replacement app bundle launched"
rm -rf "$backup_app"
rm -rf "$staging"
exit 0
`, currentApp, newApp, backupApp, staging, logPath, oldPID)
}

// currentMacAppBundle 从当前可执行文件路径反查 .app bundle 根目录。
// 不在 .app bundle 内运行（开发模式）时返回错误，让前端回落到手动路径。
func currentMacAppBundle() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("%w: 获取可执行文件路径: %v", ErrApplyFailed, err)
	}
	exe, _ = filepath.EvalSymlinks(exe)
	const marker = ".app/Contents/MacOS/"
	idx := strings.Index(exe, marker)
	if idx < 0 {
		return "", fmt.Errorf("%w: 当前不是从 .app bundle 运行（开发模式），请手动安装", ErrApplyFailed)
	}
	app := exe[:idx+len(".app")]
	if _, err := os.Stat(filepath.Join(app, "Contents", "Info.plist")); err != nil {
		return "", fmt.Errorf("%w: 当前 .app bundle 无效: %v", ErrApplyFailed, err)
	}
	return app, nil
}

// findMacAppBundle 在挂载点下找 .app bundle（按 Info.plist 存在性判断）。
func findMacAppBundle(root string) (string, error) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return "", fmt.Errorf("%w: 读 dmg 挂载点: %v", ErrApplyFailed, err)
	}
	for _, e := range entries {
		if !e.IsDir() || !strings.HasSuffix(e.Name(), ".app") {
			continue
		}
		candidate := filepath.Join(root, e.Name())
		if _, err := os.Stat(filepath.Join(candidate, "Contents", "Info.plist")); err == nil {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("%w: dmg 挂载点里找不到 .app bundle", ErrApplyFailed)
}

// applyWindows darwin 平台的 stub，返 ErrUnsupportedOS
func applyWindows(installerPath string, logger func(level, format string, args ...any)) error {
	return fmt.Errorf("%w: Windows apply called from macOS build", ErrUnsupportedOS)
}
