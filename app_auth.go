package main

import (
	"errors"
	"fmt"
	"gitea-kanban/app/git"
	"gitea-kanban/app/gitbinary"
	"gitea-kanban/app/ipc"
	platformAdapter "gitea-kanban/app/platform"
	"gitea-kanban/app/platform/github"
	"gitea-kanban/app/secret"
	"gitea-kanban/app/store"
	"github.com/google/uuid"
	"net/url"
	"os"
	"strings"
	"time"
)

// ===== 鉴权（步骤 2.x · v2.0 修复：token 接通链路）=====

// UserDTO 用户信息（暴露给前端，与 platform.UserDTO 对齐）
type UserDTO struct {
	ID        int64  `json:"id"`
	Login     string `json:"login"`
	FullName  string `json:"fullName,omitempty"`
	Email     string `json:"email,omitempty"`
	AvatarURL string `json:"avatarUrl,omitempty"`
}

// AccountDTO 账号信息（暴露给前端，与 store.GiteaAccount 对齐）
//
// 注：返回给前端**不**包含 token（AGENTS §8.2 鉴权铁律）
//
// 字段类型对齐 frontend/src/types/dto.ts 的 GiteaAccountDto：
//   - createdAt → ISO 8601 字符串（前端 formatDate / formatRelative 兼容 Date.parse）
//   - platform → "gitea" | "github"（v2 多平台）
type AccountDTO struct {
	ID              string    `json:"id"`
	Platform        string    `json:"platform"` // gitea | github
	GiteaURL        string    `json:"giteaUrl"`
	Username        string    `json:"username"`
	KeychainService string    `json:"keychainService"`
	CreatedAt       string    `json:"createdAt"` // ISO 8601 字符串
	UserInfo        *UserInfo `json:"userInfo,omitempty"`
}

// UserInfo 账号关联的用户信息
//
// 字段类型对齐 frontend/src/types/dto.ts 的 GiteaAccountDto.userInfo：
//   - updatedAt → ISO 8601 字符串
type UserInfo struct {
	GiteaUserID int64  `json:"giteaUserId"`
	Login       string `json:"login"`
	FullName    string `json:"fullName,omitempty"`
	Email       string `json:"email,omitempty"`
	AvatarURL   string `json:"avatarUrl,omitempty"`
	UpdatedAt   string `json:"updatedAt"` // ISO 8601 字符串
}

// ConnectResult auth.connect 出参
type ConnectResult struct {
	Account AccountDTO `json:"account"`
	User    UserDTO    `json:"user"`
}

// StatusResult auth.status 出参
type StatusResult struct {
	Accounts    []AccountDTO `json:"accounts"`
	CurrentUser *UserDTO     `json:"currentUser,omitempty"`
}

// ConnectArgs auth.connect 入参
//
// v2 拍板：platform 从前端传入（"gitea" | "github"），URL 跟随 platform：
//   - gitea：用户填的 giteaUrl（自托管实例）
//   - github：固定 https://github.com（GitHub 公共 API）
type ConnectArgs struct {
	Platform string `json:"platform"`
	GiteaURL string `json:"giteaUrl"`
	Token    string `json:"token"`
}

// AuthConnect 验证 token + 写 keychain + 写 localStore 账号元信息
//
// 链路：
//  1. 校验 platform + url + token 非空（trim + 长度）
//  2. 调 adapter.VerifyToken 验证 token 有效性 + 拿用户信息
//  3. token 写 secret.Store（go-keyring / dev fallback）
//  4. localStore.Mutate 加 GiteaAccount（GiteaAccount.Platform 标 gitea/github）
//  5. 返 { account, user } 给前端
//
// 错误处理：
//   - 任何环节失败 → 返 *ipc.IpcError（前端 normalizeError 能正确识别）
//   - secret.Store 失败 → 已经写过的 keychain 也要回滚（Delete）
func (a *App) AuthConnect(args ConnectArgs) (ConnectResult, error) {
	platformName := strings.TrimSpace(args.Platform)
	if platformName == "" {
		return ConnectResult{}, ipc.NewValidationFailed("平台不能为空", "platform is empty")
	}
	if !platformAdapter.IsValid(platformName) {
		return ConnectResult{}, ipc.NewValidationFailed("不支持的平台", "platform="+platformName)
	}

	giteaURL := strings.TrimSpace(args.GiteaURL)
	token := strings.TrimSpace(args.Token)

	// GitHub 固定 URL 用 **API** 域名(不是 https://github.com 网站)
	//
	// 历史 bug(v2.x 修复前):这里写的是 https://github.com,
	// 然后 VerifyToken 拼成 https://github.com/user → 命中 GitHub 网站 HTML 页面
	// → 网站对 Accept: application/vnd.github+json 返 406 Not Acceptable
	// → 用户看到「输入有误:GitHub 不接受请求格式(HTTP 406)」
	//
	// 正确路径:https://api.github.com/user(API endpoint)
	//   - GitHubAPIBase 常量定义在 app/platform/github/adapter.go
	//   - 这里直接引用,避免硬编码漂移
	if platformName == string(platformAdapter.GitHub) {
		if _, err := gitbinary.ResolveGhPath(); err != nil {
			// v0.7.21：Connect 入口也用 gh_not_installed 错误码，前端 toast 一致
			var ghNotFound *gitbinary.GhNotFoundError
			if errors.As(err, &ghNotFound) {
				return ConnectResult{}, ipc.NewGhNotInstalled(ghNotFound.Cause)
			}
			return ConnectResult{}, ipc.NewGhNotInstalled(err.Error())
		}
		giteaURL = github.GitHubAPIBase
	} else {
		if giteaURL == "" {
			return ConnectResult{}, ipc.NewValidationFailed("gitea 地址不能为空", "url is empty")
		}
		if u, err := url.Parse(giteaURL); err != nil || (u.Scheme != "http" && u.Scheme != "https") {
			return ConnectResult{}, ipc.NewValidationFailed("gitea 地址必须以 http:// 或 https:// 开头", giteaURL)
		}
	}
	if len(token) < 8 {
		return ConnectResult{}, ipc.NewValidationFailed("令牌长度至少 8 个字符", fmt.Sprintf("len=%d", len(token)))
	}

	adapter := a.getAdapter(platformName)
	if adapter == nil {
		return ConnectResult{}, ipc.NewInternal("平台适配器未初始化: " + platformName)
	}

	// 1. 校验 token + 拿用户信息
	if a.logger != nil {
		a.logger.Info("AuthConnect: verifying token", "platform", platformName, "url", giteaURL)
	}
	user, err := adapter.VerifyToken(a.ctx, giteaURL, token)
	if err != nil {
		// adapter 返回的 *ipc.IpcError 已经结构化（带 code + hint）
		// 兜底：万一是非 IpcError，包成 internal
		var ipcErr *ipc.IpcError
		if !errors.As(err, &ipcErr) {
			return ConnectResult{}, ipc.NewInternal("验证 token 失败：" + err.Error())
		}
		return ConnectResult{}, err
	}

	// 2. 写 keychain（先写，写成功再加账号；失败抛 keychain 错误）
	keychainService := secret.KeyringService(platformName, giteaURL)
	if err := a.secretStore.Set(secret.Credential{
		Platform: platformName,
		HostURL:  giteaURL,
		Username: user.Login,
		Token:    token,
	}); err != nil {
		return ConnectResult{}, classifyKeychainError(err)
	}

	// 3. localStore 加账号（幂等：已存在的同 URL+username 账号不重复加）
	now := time.Now().UnixMilli()
	accountID := ""
	var createdAccount store.GiteaAccount
	addedNew := false
	if err := a.localStore.Mutate(func(s *store.LocalState) {
		for i := range s.Accounts {
			if s.Accounts[i].GiteaURL == giteaURL && s.Accounts[i].Username == user.Login && s.Accounts[i].Platform == platformName {
				// 复用旧账号 ID，仅刷新 userInfo
				accountID = s.Accounts[i].ID
				s.Accounts[i].UserInfo = &store.UserInfo{
					GiteaUserID: user.ID,
					Login:       user.Login,
					FullName:    user.FullName,
					Email:       user.Email,
					AvatarURL:   user.AvatarURL,
					UpdatedAt:   now,
				}
				createdAccount = s.Accounts[i]
				return
			}
		}
		// 新账号
		newAccount := store.GiteaAccount{
			ID:              uuid.NewString(),
			Platform:        platformName,
			GiteaURL:        giteaURL,
			Username:        user.Login,
			KeychainService: keychainService,
			CreatedAt:       now,
			UserInfo: &store.UserInfo{
				GiteaUserID: user.ID,
				Login:       user.Login,
				FullName:    user.FullName,
				Email:       user.Email,
				AvatarURL:   user.AvatarURL,
				UpdatedAt:   now,
			},
		}
		s.Accounts = append(s.Accounts, newAccount)
		createdAccount = newAccount
		accountID = newAccount.ID
		addedNew = true
	}); err != nil {
		// localStore 写失败 → 回滚 keychain
		_ = a.secretStore.Delete(platformName, giteaURL, user.Login)
		return ConnectResult{}, ipc.NewInternal("保存账号元信息失败：" + err.Error())
	}

	if a.logger != nil {
		if addedNew {
			a.logger.Info("AuthConnect: account added", "accountId", accountID, "username", user.Login)
		} else {
			a.logger.Info("AuthConnect: account updated", "accountId", accountID, "username", user.Login)
		}
	}

	return ConnectResult{
		Account: accountToDTO(createdAccount),
		User:    userToDTO(user),
	}, nil
}

// AuthStatus 返回所有账号 + 当前用户（**不**含 token）
func (a *App) AuthStatus() (StatusResult, error) {
	if a.localStore == nil {
		return StatusResult{}, ipc.NewInternal("localStore 未初始化")
	}
	state := a.localStore.Get()

	accounts := make([]AccountDTO, 0, len(state.Accounts))
	for _, acc := range state.Accounts {
		accounts = append(accounts, accountToDTO(acc))
	}

	// currentUser = 第一个账号的 userInfo
	var currentUser *UserDTO
	if len(state.Accounts) > 0 && state.Accounts[0].UserInfo != nil {
		u := userInfoToDTO(*state.Accounts[0].UserInfo)
		currentUser = &u
	}

	return StatusResult{
		Accounts:    accounts,
		CurrentUser: currentUser,
	}, nil
}

// DisconnectArgs auth.disconnect 入参（按 giteaUrl 定位，删整站所有账号）
type DisconnectArgs struct {
	GiteaURL string `json:"giteaUrl"`
}

// AuthDisconnect 断开某个 gitea URL 的所有账号（删 keychain + 删 localStore 记录）
func (a *App) AuthDisconnect(args DisconnectArgs) error {
	return a.disconnectImpl(args.GiteaURL, "")
}

// DisconnectOneArgs auth.disconnectOne 入参（按 giteaUrl + username 精确定位单个账号）
type DisconnectOneArgs struct {
	GiteaURL string `json:"giteaUrl"`
	Username string `json:"username"`
}

// AuthDisconnectOne 断开单个账号（删 keychain + 删 localStore 单条记录）
func (a *App) AuthDisconnectOne(args DisconnectOneArgs) error {
	return a.disconnectImpl(args.GiteaURL, args.Username)
}

// RemoveWorkspaceReposArgs 移除账号 workspace 仓库的入参
type RemoveWorkspaceReposArgs struct {
	Username string `json:"username"`
}

// RemoveWorkspaceReposResult 移除结果
type RemoveWorkspaceReposResult struct {
	RemovedCount int    `json:"removedCount"` // 被删除的仓库数量（-1 = 账号目录不存在，幂等成功）
	Message      string `json:"message"`      // 供前端 toast 展示
}

// RemoveWorkspaceRepos 删除指定账号下的所有 workspace 仓库
//
// 调用方：AccountManagerDialog 移除账号时同步清理该账号 clone 的仓库数据。
//
// 安全策略：
//   - 只删 ${workspacePath}/repos/${username}/ 目录
//   - 二次确认由前端 UI 保证（本函数不弹窗）
func (a *App) RemoveWorkspaceRepos(args RemoveWorkspaceReposArgs) (RemoveWorkspaceReposResult, error) {
	username := strings.TrimSpace(args.Username)
	if username == "" {
		return RemoveWorkspaceReposResult{RemovedCount: 0, Message: "用户名不能为空"},
			ipc.NewValidationFailed("用户名不能为空", "")
	}

	wm := git.NewWorkspaceManager()
	count, err := wm.RemoveReposForAccount(a.workspacePath, username)
	if err != nil {
		a.logger.Error("RemoveWorkspaceRepos failed", "username", username, "err", err)
		return RemoveWorkspaceReposResult{RemovedCount: 0, Message: "删除失败: " + err.Error()}, err
	}

	if count < 0 {
		return RemoveWorkspaceReposResult{RemovedCount: 0, Message: "账号无本地仓库数据，无需清理"}, nil
	}

	msg := fmt.Sprintf("已清理 %d 个仓库的本地数据", count)
	if count == 0 {
		msg = "账号无本地仓库数据，无需清理"
	}
	a.logger.Info("RemoveWorkspaceRepos done", "username", username, "removed_count", count)
	return RemoveWorkspaceReposResult{RemovedCount: count, Message: msg}, nil
}

// disconnectImpl 共用断开逻辑
//
// username 为空 → 删整站（GiteaURL 所有 username）；否则只删单个
func (a *App) disconnectImpl(giteaURL, username string) error {
	giteaURL = strings.TrimSpace(giteaURL)
	if giteaURL == "" {
		return ipc.NewValidationFailed("gitea 地址不能为空", "")
	}

	// 1. 找要删的账号
	state := a.localStore.Get()
	var toDelete []store.GiteaAccount
	for _, acc := range state.Accounts {
		if acc.GiteaURL != giteaURL {
			continue
		}
		if username != "" && acc.Username != username {
			continue
		}
		toDelete = append(toDelete, acc)
	}
	if len(toDelete) == 0 {
		return ipc.NewNotFound("账号不存在：" + giteaURL + " " + username)
	}

	// 2. 删 keychain（先删本地，再删远端凭据；本地删失败也不阻断远端）
	for _, acc := range toDelete {
		if err := a.secretStore.Delete(acc.Platform, acc.GiteaURL, acc.Username); err != nil {
			if a.logger != nil {
				a.logger.Warn("AuthDisconnect: keychain delete failed", "err", err, "username", acc.Username)
			}
		}
	}

	// 3. 删 localStore
	return a.localStore.Mutate(func(s *store.LocalState) {
		kept := make([]store.GiteaAccount, 0, len(s.Accounts))
		for _, acc := range s.Accounts {
			if acc.GiteaURL == giteaURL && (username == "" || acc.Username == username) {
				continue
			}
			kept = append(kept, acc)
		}
		s.Accounts = kept
	})
}

// SwitchAccountArgs auth.switchAccount 入参（按 accountId 重排 accounts 顺序）
type SwitchAccountArgs struct {
	AccountID string `json:"accountId"`
}

// AuthSwitchAccount 切换当前活跃账号（重排 accounts 顺序：指定 ID 变第一）
//
// UI 用途：账号管理弹窗里"切到该账号"按钮 → 把指定账号提到首位 → AuthStatus 返回的 currentUser 跟着变
func (a *App) AuthSwitchAccount(args SwitchAccountArgs) error {
	accountID := strings.TrimSpace(args.AccountID)
	if accountID == "" {
		return ipc.NewValidationFailed("账号 ID 不能为空", "")
	}

	state := a.localStore.Get()
	targetIdx := -1
	for i, acc := range state.Accounts {
		if acc.ID == accountID {
			targetIdx = i
			break
		}
	}
	if targetIdx < 0 {
		return ipc.NewNotFound("账号不存在：" + accountID)
	}
	if targetIdx == 0 {
		// 已经是首位 → noop
		return nil
	}

	return a.localStore.Mutate(func(s *store.LocalState) {
		// 把 target 提到第一位（其他相对顺序不变）
		target := s.Accounts[targetIdx]
		s.Accounts = append(s.Accounts[:targetIdx], s.Accounts[targetIdx+1:]...)
		s.Accounts = append([]store.GiteaAccount{target}, s.Accounts...)
	})
}

// ===== auth 辅助函数 =====

// accountToDTO 把 store.GiteaAccount 转成 AccountDTO
//
// epoch ms → ISO 8601 字符串对齐前端 GiteaAccountDto 契约
func accountToDTO(acc store.GiteaAccount) AccountDTO {
	dto := AccountDTO{
		ID:              acc.ID,
		Platform:        acc.Platform,
		GiteaURL:        acc.GiteaURL,
		Username:        acc.Username,
		KeychainService: acc.KeychainService,
		CreatedAt:       epochMsToISO(acc.CreatedAt),
	}
	if acc.UserInfo != nil {
		ui := UserInfo{
			GiteaUserID: acc.UserInfo.GiteaUserID,
			Login:       acc.UserInfo.Login,
			FullName:    acc.UserInfo.FullName,
			Email:       acc.UserInfo.Email,
			AvatarURL:   acc.UserInfo.AvatarURL,
			UpdatedAt:   epochMsToISO(acc.UserInfo.UpdatedAt),
		}
		dto.UserInfo = &ui
	}
	return dto
}

// userToDTO 把 platform.UserDTO 转成 App 的 UserDTO
func userToDTO(u *platformAdapter.UserDTO) UserDTO {
	if u == nil {
		return UserDTO{}
	}
	return UserDTO{
		ID:        u.ID,
		Login:     u.Login,
		FullName:  u.FullName,
		Email:     u.Email,
		AvatarURL: u.AvatarURL,
	}
}

// userInfoToDTO 把 store.UserInfo 转成 UserDTO
//
// epoch ms → ISO 8601 字符串对齐前端契约
func userInfoToDTO(u store.UserInfo) UserDTO {
	return UserDTO{
		ID:        u.GiteaUserID,
		Login:     u.Login,
		FullName:  u.FullName,
		Email:     u.Email,
		AvatarURL: u.AvatarURL,
	}
}

// epochMsToISO 把 epoch 毫秒转 ISO 8601 字符串（前端 new Date() 兼容）
//
// 0（未设置）→ 空字符串，让前端走"未设置"分支而不是显示 1970-01-01
func epochMsToISO(ms int64) string {
	if ms <= 0 {
		return ""
	}
	return time.UnixMilli(ms).UTC().Format(time.RFC3339)
}

// classifyKeychainError 把 secret.Store 的错误映射成 *ipc.IpcError
func classifyKeychainError(err error) *ipc.IpcError {
	msg := err.Error()
	// Linux 上 keyring 不可用时的常见错误
	if strings.Contains(msg, "keyring") ||
		strings.Contains(msg, "dbus") ||
		strings.Contains(msg, "Secret Service") ||
		strings.Contains(msg, "not supported") {
		return ipc.NewKeychainUnavailable(msg)
	}
	// 拒绝访问（macOS 用户拒绝授权 / Windows ACL）
	if strings.Contains(msg, "access denied") ||
		strings.Contains(msg, "permission denied") ||
		strings.Contains(msg, "User cancelled") {
		return ipc.NewKeychainAccessDenied(msg)
	}
	return ipc.NewInternal("凭证存储失败：" + msg)
}

// resolveToken 从 keychain 取账号 token，统一错误处理
//
// 6 处调用方共用：resolvePullContext / ListRepos / GetGitGraph / CloneRepo /
// PullRepoByProjectId / resolveTokenByLocalPath。
func (a *App) resolveToken(account *store.GiteaAccount) (string, error) {
	token, err := a.secretStore.Get(account.Platform, account.GiteaURL, account.Username)
	if err != nil {
		return "", classifyKeychainError(err)
	}
	if token == "" {
		return "", ipc.NewInternal("token 为空（keychain 里有记录但 token 字符串为空）")
	}
	return token, nil
}

// findAccountByID 按 accountID 在 localStore 中查找账号
func (a *App) findAccountByID(accountID string) (*store.GiteaAccount, error) {
	state := a.localStore.Get()
	for i := range state.Accounts {
		if state.Accounts[i].ID == accountID {
			return &state.Accounts[i], nil
		}
	}
	return nil, ipc.NewNotFound("未找到账号: " + accountID)
}

// WorkspaceInfo GetWorkspace 返回值结构（对齐前端 ipc-client.ts 契约）
type WorkspaceInfo struct {
	// DataRoot 数据根目录（用户可感知的"全局路径"，默认 ~/.gitea-kanban）
	// 应用的所有持久化数据 (state.json / logs / workspace) 都放在 DataRoot 下。
	// 启动期若不存在自动 mkdir -p。
	DataRoot string `json:"dataRoot"`
	// WorkspacePath 内部 git 仓库目录 (= DataRoot + "/workspace")
	// 由应用根据业务自动创建，前端不应让用户直接选择这个路径
	// (用户只选 DataRoot 即可，workspace 是应用内部约定)。
	WorkspacePath string `json:"workspacePath"`
	IsDefault     bool   `json:"isDefault"`
	Validated     bool   `json:"validated"`
}

// GetWorkspace 返回当前数据根目录（**用户可感知的"全局路径"**）
//
// v2.x 重新设计：用户选的是数据根目录 (DataRoot)，不是 workspace 子目录
//   - DataRoot = ${GITEA_KANBAN_DATA_DIR | ~/.gitea-kanban} (启动期确定)
//   - WorkspacePath = ${DataRoot}/workspace (应用自动创建)
//   - 前端展示 DataRoot，git 操作走 WorkspacePath
func (a *App) GetWorkspace() WorkspaceInfo {
	root := a.dataDir
	wsPath := a.workspacePath

	// 校验路径是否可写（前端 SettingsView 仍展示状态）
	validated := true
	if info, err := os.Stat(root); err != nil || !info.IsDir() {
		validated = false
	}

	return WorkspaceInfo{
		DataRoot:      root,
		WorkspacePath: wsPath,
		IsDefault:     true, // 永远默认（不可改）
		Validated:     validated,
	}
}

// SetWorkspaceArgs 设置 workspace 参数
type SetWorkspaceArgs struct {
	Cwd string `json:"cwd"`
}

// SetWorkspace 设置 workspace 路径
//
// v2.2 user 拍板：路径不可改。本方法保留为 stub 返回 error（前端不再调用，但 App.d.ts 还有 binding）
// 任何调用都拒绝，error 走 slog 记录
func (a *App) SetWorkspace(args SetWorkspaceArgs) error {
	if a.logger != nil {
		a.logger.Warn("SetWorkspace called but workspace path is no longer user-configurable (v2.2)",
			"requestedCwd", args.Cwd)
	}
	return ipc.NewValidationFailed(
		"工作区路径不可修改",
		"v2.2 后 workspace 固定为 ${dataDir}/workspace，无法自定义",
	)
}
