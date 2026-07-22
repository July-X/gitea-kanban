//go:build windows

package updater

import (
	"os"
	"strings"
	"testing"
)

// TestGetShortPathNameW_Basic 验证 8.3 短路径不含空格
func TestGetShortPathNameW_Basic(t *testing.T) {
	// 临时目录路径在 Windows 上总是存在的
	tmp := t.TempDir()
	short := getShortPathNameW(tmp)

	// 短路径不应为空
	if short == "" {
		t.Fatal("getShortPathNameW 返回空字符串")
	}

	// 短路径不应含空格（含空格的原始路径转后应为 8.3 格式）
	if strings.Contains(tmp, " ") {
		if strings.Contains(short, " ") {
			t.Errorf("短路径仍含空格: %q", short)
		}
	}

	// 短路径与原路径应指向同一目录（通过 os.Stat 验证存在性）
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

// TestInstallerCommandLine_ShortDir 验证 installerCommandLine 用短路径 /D= 参数不含空格
func TestInstallerCommandLine_ShortDir(t *testing.T) {
	// 模拟含空格的安装路径
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
