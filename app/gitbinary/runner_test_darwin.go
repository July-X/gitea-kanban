//go:build darwin

package gitbinary

import (
	"os"
	"testing"
)

// TestInit_ReleasesEmbeddedBinary macOS 平台专用：
// embeddedGitBytes() 在 embed_darwin.go 编译进 darwin 二进制
// （0 字节 placeholder / amd64 / arm64 三种）。Init 跑完后：
//   - 0 字节 placeholder → defaultBinaryPath 不会被 Set，测试 Skip
//   - 真实二进制 → defaultBinaryPath 应为 release 路径，测试通过
func TestInit_ReleasesEmbeddedBinary(t *testing.T) {
	resetInitFlag(t)
	tmp := t.TempDir()

	if err := Init(tmp, nil); err != nil {
		t.Fatalf("Init failed: %v", err)
	}

	def := DefaultBinaryPath()
	if def == "" {
		// 0 字节 placeholder（dev 期占位）→ smoke test 跑不到这一步，因为
		// runner.go:123 len(bin)==0 分支直接 defaultBinaryPath.Store("")
		// 并 return nil。所以这里只能是 placeholder 场景。
		t.Skip("macOS 嵌入二进制为 0 字节 placeholder（dev 期占位，release 前 wails build 替换），跳过 expect-release 断言")
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
