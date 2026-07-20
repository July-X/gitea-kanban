package sign

import (
	"io"
	"os"
)

// osOpenImpl / osWriteFileImpl / osRenameImpl 是 sign 包的 default IO 实现。
//
// 抽出来是为了让 sign_test.go 能用 memory filesystem 注入测试（设置
// openFile/writeFileFull/renameFile var 指向 mock 实现）。

func osOpenImpl(path string) (io.ReadCloser, error) {
	return os.Open(path)
}

func osWriteFileImpl(path string, data []byte, perm uint32) error {
	return os.WriteFile(path, data, os.FileMode(perm))
}

func osRenameImpl(oldPath, newPath string) error {
	return os.Rename(oldPath, newPath)
}
