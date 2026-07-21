// Package store 实现业务态本地存储（state.json），延续 Electron 版 localStore 结构。
//
// 设计（对齐 ADR-0003）：
//   - 1 个 JSON 文件 = 1 个 LocalState 对象
//   - schemaVersion 顶层，迁移时手动 bump
//   - 原子写（tmp + rename）
//   - 并发安全（sync.RWMutex）
//
// 数据结构与 Electron 版 src/main/local/state.ts 一致，便于数据迁移。
package store

import (
	"encoding/json"
	"errors"
	"os"
	"strings"
	"sync"
	"time"
)

// StateSchemaVersion 业务态 schema 版本
const StateSchemaVersion = 1

// GiteaAccount 账号（对齐 TS GiteaAccount，新增 Platform 字段支持多平台）
type GiteaAccount struct {
	ID              string    `json:"id"`
	Platform        string    `json:"platform"` // "gitea" | "github"（v2 新增，旧数据默认 "gitea"）
	GiteaURL        string    `json:"giteaUrl"` // Gitea 实例 URL 或 GitHub API URL
	Username        string    `json:"username"`
	KeychainService string    `json:"keychainService"`
	CreatedAt       int64     `json:"createdAt"` // epoch ms
	UserInfo        *UserInfo `json:"userInfo"`
}

// UserInfo denormalized 用户信息（来自平台 /user 接口）
type UserInfo struct {
	GiteaUserID int64  `json:"giteaUserId"`
	Login       string `json:"login"`
	FullName    string `json:"fullName,omitempty"`
	Email       string `json:"email,omitempty"`
	AvatarURL   string `json:"avatarUrl,omitempty"`
	UpdatedAt   int64  `json:"updatedAt"`
}

// LocalUser 本地用户（v1 仅 1 行 seed）
type LocalUser struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
	CreatedAt   int64  `json:"createdAt"`
}

// RepoProject 仓库项目
type RepoProject struct {
	ID            string `json:"id"`
	Platform      string `json:"platform"` // "gitea" | "github"（v2 新增）
	AccountID     string `json:"accountId"`
	Owner         string `json:"owner"`
	Name          string `json:"name"`
	DefaultBranch string `json:"defaultBranch"`
	LastSyncAt    int64  `json:"lastSyncAt"` // epoch ms, 0 = null
	CreatedAt     int64  `json:"createdAt"`
}

// StarredBranch 收藏的分支
type StarredBranch struct {
	ID        string `json:"id"`
	ProjectID string `json:"projectId"`
	Branch    string `json:"branch"`
	CreatedAt int64  `json:"createdAt"`
}

// LocalState 顶层状态（1 个 JSON 文件）
type LocalState struct {
	SchemaVersion   int             `json:"schemaVersion"`
	Accounts        []GiteaAccount  `json:"accounts"`
	Users           []LocalUser     `json:"users"`
	Prefs           map[string]any  `json:"prefs"`
	Projects        []RepoProject   `json:"projects"`
	StarredBranches []StarredBranch `json:"starredBranches"`
}

// GitBinaryPathPrefKey prefs 中 git 二进制路径的 key（v0.4.0 新增）
//
//   - 空字符串或不在 prefs：使用 app/gitbinary 释放的内嵌二进制（或 PATH 兜底）
//   - 非空字符串：用户填的 git 二进制绝对路径（macOS / Windows / Linux 都允许）
//
// 写入入口：app.SetGitBinaryPath（SettingsView "Git 二进制"卡片 调用）
// 读取入口：app.GetGitBinaryPath / app.gitbinary.ResolveGitBinaryPath
const GitBinaryPathPrefKey = "app.gitBinaryPath"

// GhBinaryPathPrefKey prefs 中 gh 二进制路径的 key（v0.7.21 新增）
//
//   - 空字符串或不在 prefs：使用进程 PATH 探测（macOS .app 启动时已补全）
//   - 非空字符串：用户填的 gh 二进制绝对路径（覆盖自动探测）
//
// 写入入口：app.SetGhBinaryPath（SettingsView "gh 二进制"卡片调用）
// 读取入口：app.GetGhBinaryPath / app.gitbinary.ResolveGhPath
const GhBinaryPathPrefKey = "app.ghBinaryPath"

// LocalStore 业务态存储（原子写 + 并发安全）
type LocalStore struct {
	mu   sync.RWMutex
	path string
	data *LocalState
}

// NewLocalStore 创建并加载 state.json
//
// 文件不存在时初始化默认值（不报错）；
// JSON 损坏时返回错误（调用方决定是否删文件重建）。
func NewLocalStore(path string) (*LocalStore, error) {
	s := &LocalStore{path: path}
	if err := s.load(); err != nil {
		return nil, err
	}
	return s, nil
}

// load 从磁盘加载 state.json
func (s *LocalStore) load() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	raw, err := os.ReadFile(s.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			// 文件不存在 → 初始化默认值
			s.data = defaultState()
			return nil
		}
		return err
	}

	var state LocalState
	if err := json.Unmarshal(raw, &state); err != nil {
		return err
	}

	// 数据迁移：旧数据无 Platform 字段 → 默认 "gitea"
	for i := range state.Accounts {
		if state.Accounts[i].Platform == "" {
			state.Accounts[i].Platform = "gitea"
		}
	}
	for i := range state.Projects {
		if state.Projects[i].Platform == "" {
			state.Projects[i].Platform = "gitea"
		}
	}

	s.data = &state
	return nil
}

// Get 返回当前状态的只读副本（调用方可安全读取，但不应修改返回值）
func (s *LocalStore) Get() *LocalState {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.data
}

// Mutate 在写锁保护下修改状态，修改后自动原子写盘
//
// 用法：
//
//	store.Mutate(func(s *LocalState) {
//	    s.Accounts = append(s.Accounts, newAccount)
//	})
func (s *LocalStore) Mutate(fn func(*LocalState)) error {
	s.mu.Lock()
	fn(s.data)
	s.mu.Unlock()
	return s.flush()
}

// flush 原子写盘（tmp + rename）
func (s *LocalStore) flush() error {
	s.mu.RLock()
	data := s.data
	s.mu.RUnlock()

	raw, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}

	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// defaultState 默认状态
func defaultState() *LocalState {
	now := time.Now().UnixMilli()
	return &LocalState{
		SchemaVersion: StateSchemaVersion,
		Accounts:      []GiteaAccount{},
		Users: []LocalUser{
			{ID: "local-user", DisplayName: "Local User", CreatedAt: now},
		},
		Prefs:           map[string]any{},
		Projects:        []RepoProject{},
		StarredBranches: []StarredBranch{},
	}
}

// GetWorkspacePath 从 localStore 读 workspace 路径
//
// 不存在 / 空 / 非 string 类型时返空字符串（= 走 app/gitbinary.ResolveGitBinaryPath 默认）。
func GetGitBinaryPath(s *LocalStore) string {
	if s == nil {
		return ""
	}
	state := s.Get()
	if state == nil || state.Prefs == nil {
		return ""
	}
	if v, ok := state.Prefs[GitBinaryPathPrefKey].(string); ok {
		return v
	}
	return ""
}

// SetGitBinaryPath 把用户填的 git 二进制路径写到 prefs。
//
// 空字符串 = 清空用户配置（运行时回退到内嵌 / PATH git）。
// 非空字符串 = 强校验 stat 存在且非目录（失败的 err 让 SettingsView "保存"按钮提示）。
func SetGitBinaryPath(s *LocalStore, path string) error {
	return s.Mutate(func(state *LocalState) {
		if state.Prefs == nil {
			state.Prefs = map[string]any{}
		}
		path = strings.TrimSpace(path)
		if path == "" {
			delete(state.Prefs, GitBinaryPathPrefKey)
		} else {
			state.Prefs[GitBinaryPathPrefKey] = path
		}
	})
}

// GetGhBinaryPath 读 prefs["app.ghBinaryPath"]（gh CLI 覆盖路径）
//
// 不存在 / 空 / 非 string 类型时返空字符串（= 走 gitbinary.ResolveGhPath 默认）。
func GetGhBinaryPath(s *LocalStore) string {
	if s == nil {
		return ""
	}
	state := s.Get()
	if state == nil || state.Prefs == nil {
		return ""
	}
	if v, ok := state.Prefs[GhBinaryPathPrefKey].(string); ok {
		return v
	}
	return ""
}

// SetGhBinaryPath 把用户填的 gh 二进制路径写到 prefs。
//
// 空字符串 = 清空用户配置（运行时回退到 PATH 探测，macOS 启动期已补 PATH）
// 非空字符串 = 强校验 stat 存在且非目录
func SetGhBinaryPath(s *LocalStore, path string) error {
	return s.Mutate(func(state *LocalState) {
		if state.Prefs == nil {
			state.Prefs = map[string]any{}
		}
		path = strings.TrimSpace(path)
		if path == "" {
			delete(state.Prefs, GhBinaryPathPrefKey)
		} else {
			state.Prefs[GhBinaryPathPrefKey] = path
		}
	})
}

// GetPrefBool 读 boolean 偏好，缺失/类型不对返 defaultVal。
//
// 用法：app_updater_app.go 的 checkUpdatesAtStartup 读 prefs["app.checkUpdates"]。
func GetPrefBool(s *LocalStore, key string, defaultVal bool) bool {
	if s == nil {
		return defaultVal
	}
	state := s.Get()
	if state == nil || state.Prefs == nil {
		return defaultVal
	}
	if v, ok := state.Prefs[key].(bool); ok {
		return v
	}
	return defaultVal
}

// SetPrefBool 把 boolean 偏好写到 prefs。
func SetPrefBool(s *LocalStore, key string, val bool) error {
	return s.Mutate(func(state *LocalState) {
		if state.Prefs == nil {
			state.Prefs = map[string]any{}
		}
		state.Prefs[key] = val
	})
}

// CheckUpdatesPrefKey v0.8.0 启动检查更新开关的 pref key。
const CheckUpdatesPrefKey = "app.checkUpdates"
