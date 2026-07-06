package logexport

import (
	"archive/zip"
	"io"
	"os"
	"path/filepath"
	"testing"
)

// zipOpenReader 测试辅助：打开 zip reader 并 defer close
func zipOpenReader(t *testing.T, path string) (*zip.ReadCloser, error) {
	t.Helper()
	return zip.OpenReader(path)
}

// readAll 测试辅助：读取整个 reader
func readAll(t *testing.T, r io.Reader) []byte {
	t.Helper()
	data, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// 确保 desktop 目录创建正常
func TestDesktopDir(t *testing.T) {
	d := DesktopDir()
	// 不强求 $HOME 设了，但至少不能 panic
	_ = d
	// 不检查存在性（CI 跑测试时不一定有 Desktop 目录）
}

// 兜底 Export 失败路径
func TestExport_EmptyDesktopPath(t *testing.T) {
	_, err := Export(ExportOptions{
		LogDir: t.TempDir(),
	})
	if err == nil {
		t.Error("expected error for empty DesktopPath")
	}
}

func TestExport_BadLogDir(t *testing.T) {
	dir := t.TempDir()
	desktop := filepath.Join(dir, "Desktop")
	// 文件而非目录 → 走 MkdirAll 应失败
	bad := filepath.Join(dir, "badfile")
	if err := os.WriteFile(bad, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	_, err := Export(ExportOptions{
		DesktopPath: desktop,
		LogDir:      bad,
	})
	if err == nil {
		t.Error("expected error for bad LogDir")
	}
}
