package git

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/go-git/go-git/v5/plumbing/transport"
	"github.com/go-git/go-git/v5/plumbing/transport/http"
	gitSSH "github.com/go-git/go-git/v5/plumbing/transport/ssh"
	"golang.org/x/crypto/ssh"
)

// AuthMethod 认证方式
type AuthMethod string

const (
	AuthMethodSSH   AuthMethod = "ssh"
	AuthMethodHTTPS AuthMethod = "https"
)

// AuthConfig 认证配置
type AuthConfig struct {
	Method   AuthMethod
	URL      string
	Username string
	Token    string
	SSHKey   string
}

// BuildAuth 构建 git 认证（优先 SSH，失败回退到 HTTPS + token）
//
// v2.8：添加 SSH 支持，提升大仓库同步稳定性
//
// 策略：
//  1. 自动检测 ~/.ssh/id_ed25519 或 ~/.ssh/id_rsa（无 passphrase）
//  2. 如果检测到 SSH key，转换 URL 为 SSH 格式并使用 SSH 认证
//  3. 如果 SSH 不可用，回退到 HTTPS + token
//
// 注意：
//  - SSH key 必须无 passphrase（或已添加到 ssh-agent）
//  - 只支持 GitHub 的 SSH（git@github.com:owner/repo.git）
func BuildAuth(httpsURL, username, token string) (transport.AuthMethod, string, AuthMethod) {
	// 1. 尝试 SSH（仅 GitHub）
	if strings.Contains(httpsURL, "github.com") {
		if sshKey, ok := detectSSHKey(); ok {
			if sshAuth, err := loadSSHKey(sshKey); err == nil {
				sshURL := convertToSSHURL(httpsURL)
				return sshAuth, sshURL, AuthMethodSSH
			}
		}
	}

	// 2. 回退到 HTTPS + token
	if username == "" {
		username = "oauth2"
	}
	httpAuth := &http.BasicAuth{
		Username: username,
		Password: token,
	}
	return httpAuth, httpsURL, AuthMethodHTTPS
}

// detectSSHKey 检测可用的 SSH key
//
// 优先级：id_ed25519 > id_rsa
// 只检测无 passphrase 的 key
func detectSSHKey() (string, bool) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", false
	}

	candidates := []string{
		filepath.Join(homeDir, ".ssh", "id_ed25519"),
		filepath.Join(homeDir, ".ssh", "id_rsa"),
	}

	for _, path := range candidates {
		if _, err := os.Stat(path); err == nil {
			// 尝试加载（无 passphrase）
			if _, err := gitSSH.NewPublicKeysFromFile("git", path, ""); err == nil {
				return path, true
			}
		}
	}

	return "", false
}

// loadSSHKey 加载 SSH key 并创建认证
func loadSSHKey(keyPath string) (transport.AuthMethod, error) {
	auth, err := gitSSH.NewPublicKeysFromFile("git", keyPath, "")
	if err != nil {
		return nil, fmt.Errorf("加载 SSH key 失败: %w", err)
	}

	// 设置 host key callback（接受 GitHub 的 host key）
	// 生产环境应该验证 host key，但这里为了兼容性使用 InsecureIgnoreHostKey
	auth.HostKeyCallback = ssh.InsecureIgnoreHostKey()

	return auth, nil
}

// convertToSSHURL 将 HTTPS URL 转换为 SSH URL
//
// 示例：
//   https://github.com/owner/repo -> git@github.com:owner/repo.git
//   https://github.com/owner/repo.git -> git@github.com:owner/repo.git
func convertToSSHURL(httpsURL string) string {
	u, err := url.Parse(httpsURL)
	if err != nil {
		// 解析失败，返回原 URL
		return httpsURL
	}

	host := u.Host
	path := strings.TrimPrefix(u.Path, "/")
	path = strings.TrimSuffix(path, ".git")

	return fmt.Sprintf("git@%s:%s.git", host, path)
}
