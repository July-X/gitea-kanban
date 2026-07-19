//go:build !darwin && !windows

package gitbinary

import "testing"

// TestInit_ReleasesEmbeddedBinary 非 darwin/windows 平台专用：
// embeddedGitBytes() 在 embed_other.go 返 nil，Init 直接 Skip。
// 这测试不会跑（永远 Skip），但保留 stub 避免 runner_test.go 里无 build tag
// 的函数声明在编译时要求 embeddedGitBytes 返回正确类型。
func TestInit_ReleasesEmbeddedBinary(t *testing.T) {
	t.Skip("非 darwin/windows 平台不嵌入 git 二进制（embed_other.go embeddedGitBytes 返 nil），跳过 expect-release 断言")
}
