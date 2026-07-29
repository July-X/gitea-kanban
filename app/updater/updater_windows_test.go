//go:build windows

package updater

import (
	"errors"
	"os"
	"strings"
	"syscall"
	"testing"
	"unsafe"
)

// fakeLauncher 捕获 ShellExecuteExW 入参的测试替身。
//
// 返回值由 caller 在 capturedErr / capturedCancel 决定：
//   - capturedCancel=true：模拟 errno=1223（UAC 取消）
//   - capturedErr != nil：模拟其他 Win32 错误
//   - 都不设：模拟成功（ret=1）
type fakeLauncher struct {
	capturedInfo *shellExecuteInfoW
	capturedErr  error // 模拟 errno≠0 且非 1223
	cancelUAC    bool  // 模拟 errno=1223
}

func (f *fakeLauncher) launcher(info *shellExecuteInfoW) error {
	f.capturedInfo = info
	if f.cancelUAC {
		// 真实路径返的 errElevationCancelled（带 errno=1223 等价物）
		// 但我们绕开 syscall.Errno 直接构造包装
		return wrapCancel()
	}
	return f.capturedErr
}

// wrapCancel 构造一个让 launchElevated 走 "errors.Is errElevationCancelled" 分支的 error。
//
// launchElevatedWith 接收 launchElevated 的 error 后判断 errors.Is(err, errElevationCancelled)。
// 我们让 fake launcher 直接返 errElevationCancelled（最简单）。
func wrapCancel() error { return errElevationCancelled }

// TestGetShortPathNameW_Basic 验证 8.3 短路径不含空格（v0.8.0.1 起，原有覆盖保留）。
func TestGetShortPathNameW_Basic(t *testing.T) {
	tmp := t.TempDir()
	short := getShortPathNameW(tmp)
	if short == "" {
		t.Fatal("getShortPathNameW 返回空字符串")
	}
	if strings.Contains(tmp, " ") && strings.Contains(short, " ") {
		t.Errorf("短路径仍含空格: %q", short)
	}
	shortInfo, err := os.Stat(short)
	if err != nil {
		t.Errorf("短路径无法 stat: %v", err)
		return
	}
	tmpInfo, err := os.Stat(tmp)
	if err != nil {
		t.Errorf("原路径无法 stat: %v", err)
		return
	}
	if !os.SameFile(shortInfo, tmpInfo) {
		t.Errorf("短路径与原路径不是同一文件: %q != %q", short, tmp)
	}
}

// TestShellExecuteInfo_CbSize 验证 SHELLEXECUTEINFOW 镜像 cbSize 等于 unsafe.Sizeof(struct)
//
// 关键：cbSize 必须用 unsafe.Sizeof(*info) 算，不是写常量——防止将来加字段忘改。
// Win32 ShellExecuteExW 第一个校验就是 cbSize，错了返 FALSE 不告诉你原因。
func TestShellExecuteInfo_CbSize(t *testing.T) {
	info := &shellExecuteInfoW{}
	info.cbSize = uint32(unsafe.Sizeof(*info))
	want := uint32(unsafe.Sizeof(shellExecuteInfoW{}))
	if info.cbSize != want {
		t.Errorf("cbSize=%d, want %d", info.cbSize, want)
	}
	// sanity: 当前布局下应该是 112 字节（15 字段 * 8 对齐 - 一些填充）
	// 不 hardcode 数值，避免 32/64 位差异；但应当 > 80 字节
	if info.cbSize < 80 {
		t.Errorf("cbSize too small (%d), 镜像字段可能漏写", info.cbSize)
	}
}

// TestLaunchElevated_PassesRunAsVerb 验证 ShellExecuteExW 入参：
//   - lpVerb == "runas"（触发 UAC）
//   - lpFile == installerPath
//   - lpParameters == "/S /D=<shortDir>"
//   - nShow == SW_HIDE
//   - fMask 包含 SEE_MASK_NOCLOSEPROCESS | SEE_MASK_FLAG_NO_UI
func TestLaunchElevated_PassesRunAsVerb(t *testing.T) {
	fake := &fakeLauncher{}
	installer := `C:\Users\zxx\AppData\Local\Temp\gitea-kanban-setup.exe`
	shortDir := `C:\PROGRA~1\GITEA-K~1`

	if err := launchElevatedWith(installer, shortDir, fake.launcher); err != nil {
		t.Fatalf("launchElevatedWith 返回 error: %v", err)
	}

	if fake.capturedInfo == nil {
		t.Fatal("fakeLauncher 没收到 SHELLEXECUTEINFO")
	}

	// lpVerb == "runas"
	if got := utf16PtrToString(fake.capturedInfo.lpVerb); got != "runas" {
		t.Errorf("lpVerb = %q, want %q", got, "runas")
	}
	// lpFile == installerPath
	if got := utf16PtrToString(fake.capturedInfo.lpFile); got != installer {
		t.Errorf("lpFile = %q, want %q", got, installer)
	}
	// lpParameters == "/S /D=<shortDir>"
	wantParams := "/S /D=" + shortDir
	if got := utf16PtrToString(fake.capturedInfo.lpParameters); got != wantParams {
		t.Errorf("lpParameters = %q, want %q", got, wantParams)
	}
	// nShow == SW_HIDE
	if fake.capturedInfo.nShow != swHide {
		t.Errorf("nShow = %d, want SW_HIDE(%d)", fake.capturedInfo.nShow, swHide)
	}
	// fMask 标志
	if fake.capturedInfo.fMask&seeMaskNoCloseProcess == 0 {
		t.Error("fMask 缺少 SEE_MASK_NOCLOSEPROCESS")
	}
	if fake.capturedInfo.fMask&seeMaskFlagNoUI == 0 {
		t.Error("fMask 缺少 SEE_MASK_FLAG_NO_UI")
	}
	// cbSize 自洽
	if fake.capturedInfo.cbSize != uint32(unsafe.Sizeof(*fake.capturedInfo)) {
		t.Errorf("cbSize=%d, 结构体实际大小=%d", fake.capturedInfo.cbSize, unsafe.Sizeof(*fake.capturedInfo))
	}
}

// TestLaunchElevated_UACCanceled 验证 UAC 用户点"否" → 返回 errElevationCancelled
func TestLaunchElevated_UACCanceled(t *testing.T) {
	fake := &fakeLauncher{cancelUAC: true}
	err := launchElevatedWith(`C:\setup.exe`, `C:\PROGRA~1\GITEA-K~1`, fake.launcher)
	if !errors.Is(err, errElevationCancelled) {
		t.Errorf("UAC 取消应返 errElevationCancelled，实际: %v", err)
	}
}

// TestLaunchElevated_OtherFailure 验证非 1223 的 win32 错误透传
func TestLaunchElevated_OtherFailure(t *testing.T) {
	boom := errors.New("ShellExecuteExW failed (win32 errno=2)")
	fake := &fakeLauncher{capturedErr: boom}
	err := launchElevatedWith(`C:\setup.exe`, `C:\PROGRA~1\GITEA-K~1`, fake.launcher)
	if err == nil {
		t.Fatal("应该返 error，got nil")
	}
	if errors.Is(err, errElevationCancelled) {
		t.Error("非 1223 错误不应被当作 UAC 取消")
	}
	if !strings.Contains(err.Error(), "ShellExecuteExW") {
		t.Errorf("错误信息应含 ShellExecuteExW，实际: %v", err)
	}
}

// TestWin32ErrorHint 覆盖常见错误码的"人话"翻译
func TestWin32ErrorHint(t *testing.T) {
	cases := []struct {
		errNo  uintptr
		expect string // 子串
	}{
		{2, "找不到"},
		{3, "不存在"},
		{5, "拒绝"},
		{11, "损坏"},
		{999, ""}, // 未知返空
	}
	for _, tc := range cases {
		got := win32ErrorHint(tc.errNo)
		if tc.expect == "" {
			if got != "" {
				t.Errorf("errNo=%d 应返空，实际: %q", tc.errNo, got)
			}
			continue
		}
		if !strings.Contains(got, tc.expect) {
			t.Errorf("errNo=%d 应含 %q，实际: %q", tc.errNo, tc.expect, got)
		}
	}
}

// TestInstallerCommandLine_ShortDir 保留旧测试：installerCommandLine 拼装正确
// （v0.8.24 重写后该函数仅用于日志/调试，但单测仍要有，避免回归）。
func TestInstallerCommandLine_ShortDir(t *testing.T) {
	name := `C:\Program Files\Gitea Kanban\gitea-kanban-setup.exe`
	installDir := `C:\PROGRA~1\GITEA-K~1`

	cmd := installerCommandLine(name, installDir)

	// 含空格的 installerPath 应该被引号包裹
	if !strings.Contains(cmd, `"`) {
		t.Errorf("installerPath 未被引号包裹: %s", cmd)
	}

	// /D= 参数后不应有引号（NSIS 不支持）
	if strings.Contains(cmd, `/D="`) {
		t.Errorf("/D= 参数不应含引号: %s", cmd)
	}

	// 必须包含 /S 和 /D=
	if !strings.Contains(cmd, "/S") {
		t.Errorf("缺少 /S 静默标志: %s", cmd)
	}
	if !strings.Contains(cmd, "/D=") {
		t.Errorf("缺少 /D= 参数: %s", cmd)
	}
}

// utf16PtrToString 安全地把 *uint16 还原成 Go string（nil 安全）。
func utf16PtrToString(p *uint16) string {
	if p == nil {
		return ""
	}
	// 从 nil-terminated UTF-16 字符串还原，先找长度
	const maxLen = 4096
	buf := make([]uint16, maxLen)
	for i := 0; i < maxLen; i++ {
		ru := *(*uint16)(unsafe.Pointer(uintptr(unsafe.Pointer(p)) + uintptr(i)*2))
		if ru == 0 {
			buf = buf[:i]
			break
		}
		buf[i] = ru
	}
	return syscall.UTF16ToString(buf)
}
