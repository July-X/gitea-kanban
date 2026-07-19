//go:build windows

package gitbinary

import (
	"os"
	"testing"
)

// TestInit_ReleasesEmbeddedBinary windows 平台专用：
// embeddedGitBytes() 在 embed_windows.go 编译进 windows 二进制。
func TestInit_ReleasesEmbeddedBinary(t *testing.T) {
	resetInitFlag(t)
	tmp := t.TempDir()

	if err := Init(tmp, nil); err != nil {
		t.Fatalf("Init failed: %v", err)
	}

	def := DefaultBinaryPath()
	if def == "" {
		t.Skip("windows 嵌入二进制为 0 字节 placeholder（dev 期占位，release 前 wails build 替换），跳过 expect-release 断言")
	}

	info, err := os.Stat(def)
	if err != nil {
		t.Fatalf("嵌入二进制不存在: %v", err)
	}
	if info.IsDir() {
		t.Fatalf("嵌入二进制路径指向目录: %s", def)
	}
	if info.Size() == 0 {
		t.Logf("嵌入二进制为 0 字节 placeholder：%s（dev 期占位，release 前替换）", def)
		return
	}
}
