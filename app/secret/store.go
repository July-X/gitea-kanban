// Package secret 封装凭证存储（token），替代旧版 @napi-rs/keyring。
//
// 设计（对齐 AGENTS.md §8.1 鉴权铁律）：
//   - token 永远不离开 Go 进程内存 + 系统 keychain
//   - 生产环境：go-keyring 读写系统 keychain（macOS Keychain / Windows Credential Vault / Linux Secret Service）
//   - 开发环境：fallback 到文件（0600，userData/dev-tokens/*.json）
//   - token 不写日志 / 不写 state.json / 不传给前端
//
// 凭证 key 规则（与旧版 keychain.ts 一致）：
//   - service: gitea-kanban@${hostURL}（或 github@${hostURL}）
//   - username: 平台用户名
package secret

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"github.com/zalando/go-keyring"
)

// Credential 凭证信息
type Credential struct {
	Platform string // "gitea" | "github"
	HostURL  string // 平台 URL
	Username string // 用户名
	Token    string // PAT
}

// KeyringService 构造 keychain service 名
//
// gitea-kanban@${hostURL}（与旧版 keychain.ts 一致）
func KeyringService(platform, hostURL string) string {
	return fmt.Sprintf("gitea-kanban@%s", hostURL)
}

// Store 存储凭证
//
// 生产：go-keyring（系统 keychain）
// 开发：文件 fallback（0600）
type Store struct {
	// devMode 开发模式（文件 fallback）
	devMode bool
	// devTokenDir 开发模式 token 文件目录
	devTokenDir string
	// mu 保护 devTokenDir 创建
	mu sync.Mutex
}

// NewStore 创建凭证存储
//
// devMode=true 时走文件 fallback（对齐旧版 dev-tokens 机制）
// 同时 lazy mkdir devTokenDir（确保目录存在，否则首次 Set 才创建会让用户看不到）
func NewStore(devMode bool, userDataDir string) *Store {
	s := &Store{devMode: devMode}
	if devMode {
		s.devTokenDir = filepath.Join(userDataDir, "dev-tokens")
		_ = os.MkdirAll(s.devTokenDir, 0o700)
	}
	return s
}

// Set 存储 token
func (s *Store) Set(cred Credential) error {
	service := KeyringService(cred.Platform, cred.HostURL)

	if s.devMode {
		return s.setDevToken(service, cred.Username, cred.Token)
	}

	return keyring.Set(service, cred.Username, cred.Token)
}

// Get 读取 token
func (s *Store) Get(platform, hostURL, username string) (string, error) {
	service := KeyringService(platform, hostURL)

	if s.devMode {
		return s.getDevToken(service, username)
	}

	return keyring.Get(service, username)
}

// Delete 删除 token
func (s *Store) Delete(platform, hostURL, username string) error {
	service := KeyringService(platform, hostURL)

	if s.devMode {
		return s.deleteDevToken(service, username)
	}

	return keyring.Delete(service, username)
}

// ===== 开发模式文件 fallback =====

func (s *Store) devTokenPath(service, username string) string {
	safe := func(str string) string {
		var b []byte
		for _, r := range str {
			if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' || r == '-' {
				b = append(b, byte(r))
			} else {
				b = append(b, '_')
			}
		}
		return string(b)
	}
	return filepath.Join(s.devTokenDir, fmt.Sprintf("%s__%s.json", safe(service), safe(username)))
}

func (s *Store) setDevToken(service, username, token string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if err := os.MkdirAll(s.devTokenDir, 0o700); err != nil {
		return fmt.Errorf("创建 dev-tokens 目录失败: %w", err)
	}

	data, err := json.Marshal(map[string]string{"token": token})
	if err != nil {
		return err
	}

	path := s.devTokenPath(service, username)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return fmt.Errorf("写入 dev token 失败: %w", err)
	}
	return nil
}

func (s *Store) getDevToken(service, username string) (string, error) {
	path := s.devTokenPath(service, username)
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", fmt.Errorf("token 文件不存在: %s", path)
		}
		return "", fmt.Errorf("读取 dev token 文件失败: %w", err)
	}

	var raw map[string]string
	if err := json.Unmarshal(data, &raw); err != nil {
		return "", fmt.Errorf("dev token 文件 JSON 解析失败: %w", err)
	}

	token, ok := raw["token"]
	if !ok {
		// 列出实际 keys 便于诊断（不泄露值）
		keys := make([]string, 0, len(raw))
		for k := range raw {
			keys = append(keys, k)
		}
		return "", fmt.Errorf("dev token 文件缺少 'token' 字段，实际 keys: %v", keys)
	}
	return token, nil
}

func (s *Store) deleteDevToken(service, username string) error {
	path := s.devTokenPath(service, username)
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}
