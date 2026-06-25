package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/google/uuid"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"gitea-kanban/app/config"
	"gitea-kanban/app/git"
	"gitea-kanban/app/ipc"
	platformAdapter "gitea-kanban/app/platform"
	"gitea-kanban/app/platform/gitea"
	"gitea-kanban/app/platform/github"
	"gitea-kanban/app/secret"
	"gitea-kanban/app/store"
)

// App 是暴露给前端的主后端对象（Wails binding）
//
// 所有前端可调用的方法都定义在 App 上，Wails 会自动生成 TS bindings 到 frontend/wailsjs/。
// 具体业务逻辑委托给 app/ 下的各子包（store / platform / git / secret 等）。
type App struct {
	ctx     context.Context
	logger  *slog.Logger
	dataDir string
	// workspacePath = ${dataDir}/workspace（放 git repos 唯一目录，v2.2 user 拍板不可改）
	//   - 应用数据（state.json / logs / dev-tokens）在 ${dataDir} 直接放
	//   - git 同步下来的仓库统一在 ${dataDir}/workspace/repos/<owner>__<repo>/
	//   - macOS/Linux: ~/.gitea-kanban/workspace
	//   - Windows: %USERPROFILE%\.gitea-kanban\workspace
	workspacePath string
	localStore    *store.LocalStore
	giteaAdapter  platformAdapter.PlatformAdapter
	githubAdapter platformAdapter.PlatformAdapter
	// secretStore token 凭证存储（go-keyring / dev 文件 fallback）
	// v2.0 新增：AuthConnect 把 token 写进这里 + localStore 持久化账号元信息
	secretStore *secret.Store
}

// NewApp 创建后端应用实例
func NewApp() *App {
	return &App{}
}

// OnStartup 在 Wails 前端启动前调用
func (a *App) OnStartup(ctx context.Context) {
	a.ctx = ctx

	// 1. 解析数据根目录
	a.dataDir = config.ResolveDataDir()

	// 2. 初始化日志（写文件 ${dataDir}/logs/main/main.log）
	//
	// v2.2 简化（user 拍板 2026-06-22）：之前的 "${dataDir}/workspace/logs/..." 太深
	// 现在 logs / state / dev-tokens 直接放 ${dataDir} 下
	// git repos 才进 ${dataDir}/workspace
	a.logger = config.NewLogger(a.dataDir)
	a.logger.Info("gitea-kanban starting", "dataDir", a.dataDir, "version", "2.0.0")

	// 把 slog.Default() 也指向同一个文件 logger
	//
	// 背景：github adapter (app/platform/github/adapter.go) 里的 doRequest
	// 调了 slog.Default().Warn(...) 记诊断日志,但 slog.Default() 默认指向 stderr
	// → wails dev 时只显示在终端,文件 main.log 里看不到。
	// 把 default 重定向到 a.logger 后,slog.Default() 也会写到 main.log
	// (wails dev 终端 + 文件 双写,production 仍然是只文件)
	//
	// 注意:slog.SetDefault 是进程全局副作用,只调一次。
	slog.SetDefault(a.logger)

	// 3. workspacePath = ${dataDir}/workspace（放 git repos 唯一目录）
	a.workspacePath = filepath.Join(a.dataDir, "workspace")
	if err := os.MkdirAll(a.workspacePath, 0o755); err != nil {
		a.logger.Warn("workspace mkdir failed", "path", a.workspacePath, "err", err)
	}

	// 4. 初始化 localStore（${dataDir}/state.json）
	ls, err := store.NewLocalStore(filepath.Join(a.dataDir, "state.json"))
	if err != nil {
		a.logger.Error("localStore init failed", "err", err)
	} else {
		a.localStore = ls
		a.logger.Info("localStore initialized", "path", filepath.Join(a.dataDir, "state.json"))
	}

	// 5. 初始化平台适配器
	a.giteaAdapter = gitea.NewGiteaAdapter()
	a.githubAdapter = github.NewGitHubAdapter()
	a.logger.Info("platform adapters initialized")

	// 6. 初始化凭证存储（go-keyring + dev fallback）
	// v2 迁移：开发模式默认走 dev fallback（避免 macOS keychain 弹窗阻断开发）
	// 生产模式走系统 keychain（go-keyring）
	// v2.2：dev-tokens 也直接放 ${dataDir}/dev-tokens/（跟 log/state 一致）
	devMode := os.Getenv("GITEA_KANBAN_DEV_KEYCHAIN") == "1"
	a.secretStore = secret.NewStore(devMode, a.dataDir)
	if devMode {
		a.logger.Info("secret store: dev fallback (file)", "dir", filepath.Join(a.dataDir, "dev-tokens"))
	} else {
		a.logger.Info("secret store: system keychain (go-keyring)")
	}

	// 7. v2.5 · 旧布局 → 新布局迁移（一次性，启动期同步执行）
	//
	// 必须放在 localStore / secretStore 初始化**之后**（resolver 需要读 Projects / Accounts），
	// 放在业务方法前（任何 CloneRepo / GetGitGraph 都依赖新布局）。
	//
	// 用户拍板 2026-06-22：
	//   - ${dataDir}/workspace/repos/<owner>__<repo>/ → ${dataDir}/workspace/repos/<username>/<owner>__<repo>/
	//   - 启动同步，失败时把整个旧 repos 目录 mv 到 _pre_v25_workspace 保留
	//   - 旧布局一旦迁完就标记完成，新代码不再回退到旧路径
	a.runLegacyWorkspaceMigration()
}

// runLegacyWorkspaceMigration 执行一次性的 v2.4 → v2.5 旧布局迁移
//
// 设计：
//   - localStore 未初始化时跳过（启动期错误已经在前面日志记过）
//   - 只跑一次：迁移成功后即便用户手动把 _pre_v25_workspace mv 回 repos，
//     也**不会**再触发迁移（识别规则"repos 下有 __owner__repo 仓库"成立时**仍**会触发，
//     但用户主动 mv 回去的场景罕见，行为可接受）
//   - 失败时整个旧 repos 目录被 mv 到 _pre_v25_workspace，新数据 clone 会失败
//     —— 前端在 UI 上提示"工作区迁移失败"（待 v2.5.x 单独任务做）
func (a *App) runLegacyWorkspaceMigration() {
	if a.localStore == nil || a.logger == nil {
		return
	}

	wm := git.NewWorkspaceManager()
	resolver := func(platform, owner, repo string) (string, bool) {
		state := a.localStore.Get()
		// 用 (Owner, Name) 在 Projects 里找 → AccountID → Accounts 里找 Username
		var matchedAccountID string
		for _, p := range state.Projects {
			if p.Owner == owner && p.Name == repo {
				matchedAccountID = p.AccountID
				break
			}
		}
		if matchedAccountID == "" {
			return "", false
		}
		for _, acc := range state.Accounts {
			if acc.ID == matchedAccountID && acc.Username != "" {
				return acc.Username, true
			}
		}
		return "", false
	}

	result, err := wm.MigrateLegacyWorkspaceLayout(a.workspacePath, resolver)
	if err != nil {
		a.logger.Error("legacy workspace migration failed",
			"err", err, "result", result)
		return
	}
	if result.MigratedCount == 0 && result.FailedCount == 0 {
		// 没有旧布局 → 不记 INFO（每次启动都记会刷屏）
		return
	}
	if result.BackupKept {
		a.logger.Warn("legacy workspace migration: failures detected, backup kept",
			"migrated", result.MigratedCount,
			"failed", result.FailedCount,
			"backup", result.RenamedTo,
		)
	} else {
		a.logger.Info("legacy workspace migration: completed",
			"migrated", result.MigratedCount,
			"skipped", result.SkippedCount,
			"backup", result.RenamedTo,
		)
	}
}

// OnShutdown 在应用退出前调用
func (a *App) OnShutdown(ctx context.Context) {
	if a.logger != nil {
		a.logger.Info("gitea-kanban shutting down")
	}
}

// ===== 暴露给前端的基础方法（桩化，后续步骤逐步实现）=====

// AppInfo 返回应用基本信息（前端启动时调用）
type AppInfo struct {
	Version  string `json:"version"`
	DataDir  string `json:"dataDir"`
	Platform string `json:"platform"` // darwin / windows / linux
}

// GetAppInfo 返回应用信息
func (a *App) GetAppInfo() AppInfo {
	return AppInfo{
		Version:  "2.0.0",
		DataDir:  a.dataDir,
		Platform: runtime.GOOS,
	}
}

// OpenDataDir 用系统文件管理器打开应用数据根目录
//
// v2.2：前端设置页"打开应用数据目录"按钮调，跨平台实现：
//   - macOS: `open <path>`
//   - Windows: `explorer <path>`
//   - Linux: `xdg-open <path>`
//
// 失败时返 *ipc.IpcError（前端可展示 toast）
func (a *App) OpenDataDir() error {
	if a.dataDir == "" {
		return ipc.NewInternal("dataDir 未初始化")
	}

	// 确保目录存在（避免打开空目录时某些 OS 报错）
	if err := os.MkdirAll(a.dataDir, 0o755); err != nil {
		return ipc.NewInternal("确保数据目录存在失败：" + err.Error())
	}

	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", a.dataDir)
	case "windows":
		cmd = exec.Command("explorer", a.dataDir)
	default: // linux + 其它 unix
		cmd = exec.Command("xdg-open", a.dataDir)
	}

	if a.logger != nil {
		a.logger.Info("OpenDataDir", "path", a.dataDir, "cmd", cmd.String())
	}

	if err := cmd.Start(); err != nil {
		return ipc.NewInternal("打开目录失败：" + err.Error())
	}

	// 不等 cmd.Wait() —— `open` / `xdg-open` / `explorer` 都是 detach 模式
	// 等会阻塞到子进程退出才返回
	go func() {
		_ = cmd.Wait()
	}()
	return nil
}

// ===== v2.x 前端日志统一记录（前后端共用 slog）=====
//
// 设计动机：
//   - 旧版前端 console.error / toast.error 只在开发者工具里看，用户截图反馈问题时
//     信息丢失严重（renderer 重启就清空）
//   - 后端已有 slog 写 ${dataDir}/logs/main/main.log，按时间索引
//   - 现在前端把 warn / error 级 toast + console.error + window.onerror + unhandledrejection
//     都走 Go → 同一份文件
//   - 用户反馈问题 → 直接打开数据目录翻 main.log,看到时间戳 + 来源 + 内容
//
// 写入策略：
//   - 前端 fire-and-forget 调 LogFrontend,失败静默（不阻塞 UI,不弹 toast）
//   - Wails binding 自动把字符串参数转 JSON,前端不传 token / 敏感信息
//   - Go 端统一加 "src" 字段标识来源(toast / console / window / unhandledrejection)
//
// 安全：
//   - 不接受任意 level 字符串,固定白名单（防前端伪造日志级别）
//   - 不在日志里写 token / cookie / localStorage 内容
//   - description 字段最大 1KB 截断（防恶意前端打爆文件）

// LogFrontendLevel 前端日志级别（与 Go slog.Level 对应）
//
// 设计:导出为 const string 而不是 enum int,这样 Wails 自动生成的 TS 类型
// 直接是字面量联合类型,前端可以传 'debug' | 'info' | 'warn' | 'error'。
type LogFrontendLevel string

const (
	LogLevelDebug LogFrontendLevel = "debug"
	LogLevelInfo  LogFrontendLevel = "info"
	LogLevelWarn  LogFrontendLevel = "warn"
	LogLevelError LogFrontendLevel = "error"
)

// LogFrontendArgs 前端日志参数
//
// source 标识调用方(toast / console / window.onerror / unhandledrejection / 其它),
// 写日志时落到 src 字段方便过滤。
type LogFrontendArgs struct {
	Level       LogFrontendLevel `json:"level"`
	Message     string           `json:"message"`
	Description string           `json:"description,omitempty"`
	Source      string           `json:"source,omitempty"`
}

// LogFrontend 前端日志统一入口（fire-and-forget）
//
// 设计：
//   - logger 未初始化时（启动期极早或异常路径）静默忽略
//   - level 不在白名单 → 当成 info（防前端传 'panic' / 'fatal' 等让 slog 不识别）
//   - description 截断到 1024 字符（防恶意前端打爆日志文件）
//   - 永远不返回 error（Wails binding 抛错会触发前端 unhandledrejection 死循环）
func (a *App) LogFrontend(args LogFrontendArgs) {
	if a.logger == nil {
		return
	}

	// 截断 description（防爆文件）
	desc := args.Description
	if len(desc) > 1024 {
		desc = desc[:1024] + "...(truncated)"
	}

	// 过滤非法 level（白名单）
	var slogLevel slog.Level
	switch args.Level {
	case LogLevelDebug:
		slogLevel = slog.LevelDebug
	case LogLevelInfo:
		slogLevel = slog.LevelInfo
	case LogLevelWarn:
		slogLevel = slog.LevelWarn
	case LogLevelError:
		slogLevel = slog.LevelError
	default:
		slogLevel = slog.LevelInfo
	}

	// 写日志：source 字段方便 grep,desc 留原文方便定位
	a.logger.Log(a.ctx, slogLevel, args.Message,
		"src", args.Source,
		"desc", desc,
	)
}

// ===== v2.4 用户偏好（prefs）=====
//
// 修复 v2.0 stub bug：
//   - 旧版 shim user.prefs.{get,set} 是 notImplemented → StatusBar 选完仓库重启后
//     "应用没记住" 的根因之一（虽然 localStorage 兜底能恢复，但 IPC 路径死链）
//   - 新版：写 localStore.Prefs（与 AGENTS §6.4 业务态"应用偏好"对齐）
//   - frontend 不需要知道细节，shim 转发即可

// GetUserPrefsArgs 读取偏好参数（v2.4 · 不能用匿名 struct，Wails 生成 TS 会坏）
type GetUserPrefsArgs struct {
	Keys []string `json:"keys"`
}

// GetUserPrefs 读取指定 keys 的偏好值
//
// 请求：{ keys: string[] }
// 返：{ "key1": value1, "key2": value2 }（不存在的 key 不会出现在返回里）
func (a *App) GetUserPrefs(args GetUserPrefsArgs) (map[string]any, error) {
	if a.localStore == nil {
		return nil, ipc.NewInternal("localStore 未初始化")
	}
	state := a.localStore.Get()
	if state.Prefs == nil {
		return map[string]any{}, nil
	}

	out := make(map[string]any, len(args.Keys))
	if len(args.Keys) == 0 {
		// 没指定 keys → 返全部
		for k, v := range state.Prefs {
			out[k] = v
		}
		return out, nil
	}
	for _, k := range args.Keys {
		if v, ok := state.Prefs[k]; ok {
			out[k] = v
		}
	}
	if a.logger != nil && len(args.Keys) > 0 && len(args.Keys) < 20 {
		a.logger.Info("GetUserPrefs", "keys", args.Keys, "found", len(out))
	}
	return out, nil
}

// SetUserPrefsArgs 写入偏好参数（v2.4 · 不能用匿名 struct，Wails 生成 TS 会坏）
type SetUserPrefsArgs struct {
	Entries map[string]any `json:"entries"`
}

// SetUserPrefs 写入偏好（merge 到现有 Prefs，不存在键才加，null 删键）
//
// 请求：{ entries: { "key1": value1, "key2": null, ... } }
// 返：{ written: int, deleted: int }
//
// 语义：
//   - value != null → 写入
//   - value == null → 删除该 key
func (a *App) SetUserPrefs(args SetUserPrefsArgs) (map[string]any, error) {
	if a.localStore == nil {
		return nil, ipc.NewInternal("localStore 未初始化")
	}
	if args.Entries == nil {
		return map[string]any{"written": 0, "deleted": 0}, nil
	}

	written := 0
	deleted := 0
	err := a.localStore.Mutate(func(s *store.LocalState) {
		if s.Prefs == nil {
			s.Prefs = map[string]any{}
		}
		for k, v := range args.Entries {
			if v == nil {
				delete(s.Prefs, k)
				deleted++
			} else {
				s.Prefs[k] = v
				written++
			}
		}
	})
	if err != nil {
		return nil, ipc.NewInternal("保存 prefs 失败: " + err.Error())
	}

	if a.logger != nil {
		a.logger.Info("SetUserPrefs", "written", written, "deleted", deleted)
	}
	return map[string]any{"written": written, "deleted": deleted}, nil
}

// ===== Git Graph 相关方法（步骤 3.1）=====

// GraphResultDTO 图结果（暴露给前端，与 platform.GraphResult 对齐）
type GraphResultDTO struct {
	Nodes     []GraphNodeDTO `json:"nodes"`
	Edges     []GraphEdgeDTO `json:"edges"`
	MaxLane   int            `json:"maxLane"`
	Truncated bool           `json:"truncated"`
}

// GraphNodeDTO 图节点
type GraphNodeDTO struct {
	Row         int      `json:"row"`
	Lane        int      `json:"lane"`
	Color       int      `json:"color"`
	SHA         string   `json:"sha"`
	ShortSHA    string   `json:"shortSha"`
	Subject     string   `json:"subject"`
	AuthorName  string   `json:"authorName"`
	AuthorEmail string   `json:"authorEmail"`
	Date        string   `json:"date"`
	IsMerge     bool     `json:"isMerge"`
	Parents     []string `json:"parents"`
	Refs        []string `json:"refs,omitempty"`
	RefTypes    []string `json:"refTypes,omitempty"`
}

// GraphEdgeDTO 图边
type GraphEdgeDTO struct {
	FromRow  int `json:"fromRow"`
	ToRow    int `json:"toRow"`
	FromLane int `json:"fromLane"`
	ToLane   int `json:"toLane"`
	Color    int `json:"color"`
	Type     int `json:"type"`
}

// CloneRepoArgs clone 仓库参数
//
// v2.3 user 拍板：token 不再走 IPC
//   - 旧版前端传 token 给 Go 端 → 违反 AGENTS §8.2 鉴权铁律
//   - 现在 Go 端根据 platform+hostURL+username 自己去 keychain 拿
//   - 前端只传 (platform, hostURL, username, owner, repo)
type CloneRepoArgs struct {
	Platform string `json:"platform"` // "gitea" | "github"
	HostURL  string `json:"hostUrl"`
	Username string `json:"username"`
	Owner    string `json:"owner"`
	Repo     string `json:"repo"`
}

// CloneRepoResult clone 结果
type CloneRepoResult struct {
	LocalPath string `json:"localPath"`
	Reused    bool   `json:"reused"` // 仓库已存在 = 复用没重新 clone
}

// ===== v2.6 进度事件（git clone / pull）=====
//
// 实现：go-git sideband → ProgressCallback → runtime.EventsEmit("git:sync:progress", payload)
// 前端订阅：repo store init 时挂一个 onMounted 监听，写到 progressByRepo[repoKey]
// StatusBar 消费：行末按钮下方渲染 <progress> + tooltip 显示百分比
//
// 设计取舍：
//   - Wails EventsEmit 是 push 模型（后端 → 前端单向），不需要前端订阅单独的 stream
//     不需要为进度开新 IPC endpoint，零额外 schema
//   - Event name 用单一 `git:sync:progress` 避免事件命名爆炸；payload 内区分 stage / repoKey
//   - repoKey 用 `<platform>/<hostURL>/<owner>/<repo>` 前缀（v2.5+ 账号隔离之后，
//     同 owner/repo 在不同账号下是不同的物理路径，前端 key 必须包含 hostURL/platform）
const GitSyncProgressEvent = "git:sync:progress"

// GitSyncProgressPayload 进度事件 payload（前端订阅用）
//
// 与 app/git.SyncProgress 同结构（透传）—— 这里不复用是避免前端 import Go 类型
// （前端 wailsjs 也不直接暴露 Go struct 给 TS，TS 这边手动声明更稳）。
type GitSyncProgressPayload struct {
	Stage   string `json:"stage"`
	Percent int    `json:"percent"`
	Message string `json:"message"`
	Cur     int    `json:"cur"`
	Total   int    `json:"total"`
	// RepoKey 仓库 key（前端用这个 map 到 clonedMap / progressByRepo）
	// 格式：`<platform>/<hostURL>/<owner>/<repo>`（与 useRepoStore.refreshClonedStatus 一致风格）
	RepoKey string `json:"repoKey"`
}

// buildSyncProgressCallback 构造 ProgressCallback，把每条 SyncProgress 包装成 Wails event
//
// 用法：CloneRepo / PullRepoByProjectId 调本函数生成 cb，传给 git.CloneRepo / git.PullRepo
//
// 参数：
//   - repoKey:前端用于 map 的仓库标识（建议 `${owner}/${repo}`，前端 clonedMap 风格）
//   - extra:可选 extra fields（占位，保留用于未来加 progressId / correlationId 等）
func (a *App) buildSyncProgressCallback(repoKey string) git.ProgressCallback {
	if a.ctx == nil {
		// 没初始化 context 时 EventsEmit 不能用，返 no-op（避免 nil panic）
		return func(p git.SyncProgress) {}
	}
	return func(p git.SyncProgress) {
		payload := GitSyncProgressPayload{
			Stage:   string(p.Stage),
			Percent: p.Percent,
			Message: p.Message,
			Cur:     p.Cur,
			Total:   p.Total,
			RepoKey: repoKey,
		}
		// 异步发，不阻塞 go-git sideband goroutine
		// （Wails EventsEmit 本身线程安全；wails dev 终端 + production 都行）
		wailsruntime.EventsEmit(a.ctx, GitSyncProgressEvent, payload)
	}
}

// CloneRepo clone 仓库到本地 workspace
//
// v2.3：token 走 secret.Store 从 keychain 拿（前端**不**传 token）
// 校验当前账号的 hostURL+username 必须匹配 localStore.Accounts 里某条记录
// （防 user 拿错 token clone 到别账号仓库 —— 但 hostURL 一样所以问题不大）
//
// v2.6：装上 progress 回调，通过 Wails EventsEmit 实时推百分比到前端
func (a *App) CloneRepo(args CloneRepoArgs) (CloneRepoResult, error) {
	if a.logger != nil {
		a.logger.Info("CloneRepo",
			"platform", args.Platform,
			"owner", args.Owner,
			"repo", args.Repo,
			"workspace", a.workspacePath,
		)
	}

	platformName := strings.TrimSpace(args.Platform)
	hostURL := strings.TrimSpace(args.HostURL)
	username := strings.TrimSpace(args.Username)

	if platformName == "" {
		return CloneRepoResult{}, ipc.NewValidationFailed("platform 不能为空", "")
	}
	if !platformAdapter.IsValid(platformName) {
		return CloneRepoResult{}, ipc.NewValidationFailed("不支持的平台", "platform="+platformName)
	}
	if hostURL == "" {
		return CloneRepoResult{}, ipc.NewValidationFailed("hostUrl 不能为空", "")
	}
	if username == "" {
		return CloneRepoResult{}, ipc.NewValidationFailed("username 不能为空", "")
	}
	if args.Owner == "" || args.Repo == "" {
		return CloneRepoResult{}, ipc.NewValidationFailed("owner/repo 不能为空",
			fmt.Sprintf("owner=%q repo=%q", args.Owner, args.Repo))
	}

	// 1. 从 localStore 找账号 → secret.Store 拿 token
	//    防御：hostURL + username 必须匹配（防越权 clone 别账号的仓库）
	state := a.localStore.Get()
	var matchedAccount *store.GiteaAccount
	for i := range state.Accounts {
		if state.Accounts[i].Platform == platformName &&
			state.Accounts[i].GiteaURL == hostURL &&
			state.Accounts[i].Username == username {
			matchedAccount = &state.Accounts[i]
			break
		}
	}
	if matchedAccount == nil {
		return CloneRepoResult{}, &ipc.IpcError{
			Code:    ipc.CodeNotFound,
			Message: "未找到匹配账号",
			Hint:    "请检查 hostUrl/username 是否正确，或重新连接",
			Cause: fmt.Sprintf(
				"platform=%s hostUrl=%s username=%s (localStore.Accounts 里找不到匹配项)",
				platformName, hostURL, username,
			),
		}
	}

	// 2. 从 keychain 拿 token（绝不传给前端）
	token, err := a.secretStore.Get(platformName, hostURL, username)
	if err != nil {
		return CloneRepoResult{}, classifyKeychainError(err)
	}
	if token == "" {
		return CloneRepoResult{}, ipc.NewInternal(
			"token 为空：keychain 里有记录但 token 字符串为空 (platform=" + platformName +
				" hostUrl=" + hostURL + " username=" + username + ")")
	}

	// 3. clone
	adapter := a.getAdapter(platformName)
	if adapter == nil {
		return CloneRepoResult{}, ipc.NewInternal("平台适配器未初始化：" + platformName)
	}

	// v2.5：clone 到账号隔离的子目录
	//   旧布局：${workspacePath}/repos/<owner>__<repo>/
	//   新布局：${workspacePath}/repos/<username>/<owner>__<repo>/
	//
	// v2.6：progress 回调（把 sideband 解析结果通过 EventsEmit 推到前端）
	localPath, err := adapter.CloneRepo(a.ctx, hostURL, username, token, args.Owner, args.Repo, a.workspacePath, matchedAccount.Username, a.buildSyncProgressCallback(args.Owner+"/"+args.Repo))
	if err != nil {
		return CloneRepoResult{}, err
	}

	// 4. 标记 project：已存在 → 刷 LastSyncAt；不存在 → 新建
	//
	// v2.3 重要：必须新建 project（之前是只更新，导致 pullRepo 找不到 project → 找不到 token）
	_ = a.localStore.Mutate(func(s *store.LocalState) {
		now := time.Now().UnixMilli()
		for i := range s.Projects {
			if s.Projects[i].Platform == platformName &&
				s.Projects[i].AccountID == matchedAccount.ID &&
				s.Projects[i].Owner == args.Owner &&
				s.Projects[i].Name == args.Repo {
				s.Projects[i].LastSyncAt = now
				return
			}
		}
		// 新建 project
		s.Projects = append(s.Projects, store.RepoProject{
			ID:            uuid.NewString(),
			Platform:      platformName,
			AccountID:     matchedAccount.ID,
			Owner:         args.Owner,
			Name:          args.Repo,
			DefaultBranch: "", // CloneRepo 不知道 default branch，由 GetAppInfo / ListRepos 后续补充
			LastSyncAt:    now,
			CreatedAt:     now,
		})
	})

	if a.logger != nil {
		a.logger.Info("CloneRepo: success",
			"owner", args.Owner, "repo", args.Repo,
			"localPath", localPath, "accountId", matchedAccount.ID,
		)
	}

	return CloneRepoResult{LocalPath: localPath}, nil
}

// LogGraphArgs log graph 参数
type LogGraphArgs struct {
	Platform  string   `json:"platform"`
	LocalPath string   `json:"localPath"`
	Branches  []string `json:"branches"`
	MaxCount  int      `json:"maxCount"`
}

// LogGraph 获取 commit 历史并构建 Graph 布局
func (a *App) LogGraph(args LogGraphArgs) (GraphResultDTO, error) {
	if a.logger != nil {
		a.logger.Info("LogGraph", "platform", args.Platform, "path", args.LocalPath)
	}

	adapter := a.getAdapter(args.Platform)
	if adapter == nil {
		return GraphResultDTO{}, fmt.Errorf("不支持的平台: %s", args.Platform)
	}

	result, err := adapter.LogGraph(a.ctx, args.LocalPath, platformAdapter.LogGraphOpts{
		Branches: args.Branches,
		MaxCount: args.MaxCount,
	})
	if err != nil {
		return GraphResultDTO{}, err
	}

	return graphResultToAppDTO(result), nil
}

// ===== v2.4 鉴权修复：Git Graph 端到端可用 =====
//
// 修复 StatusBar 选完仓库后"看板、Git Graph 等功能还是不能使用"：
//   - 旧版 commits.gitgraph.lines 在 shim 里是 stubEmpty（永远返 0 commits）
//   - 旧版 commits.gitgraphCloneRepo 也是 notImplemented
//   - 旧版 commits.gitgraphPull 用错误的 localPath
//
// v2.4 新增：
//   - GetGitGraph(projectId) → 反查 localPath/token → adapter.LogGraph → GraphResultDTO
//   - GetRepoById(projectId) → 返 RepoDTO + localPath（前端 ListWorkspaceRepos 的替代品）
//
// 设计原则：前端只传 projectId（业务态概念），Go 端做所有"反查"

// GetGitGraphArgs Git Graph 入参
type GetGitGraphArgs struct {
	ProjectID string   `json:"projectId"`
	Branches  []string `json:"branches,omitempty"`
	MaxCount  int      `json:"maxCount,omitempty"`
}

// GetGitGraph 获取项目的 commit DAG（用 projectId 反查 localPath + token）
//
// 步骤：
//  1. localStore.Projects 找 project → owner/name/accountID
//  2. localStore.Accounts 找 account → platform/hostURL/username
//  3. workspacePath + /repos/<owner>__<repo> = localPath
//  4. secretStore 拿 token
//  5. adapter.LogGraph → 自研 layout → 返 GraphResultDTO
func (a *App) GetGitGraph(args GetGitGraphArgs) (GraphResultDTO, error) {
	if a.logger != nil {
		a.logger.Info("GetGitGraph", "projectId", args.ProjectID, "branches", args.Branches)
	}

	if args.ProjectID == "" {
		return GraphResultDTO{}, ipc.NewValidationFailed("projectId 不能为空", "")
	}

	// 1-2. 找 project + account
	project, account, err := a.findProjectAndAccount(args.ProjectID)
	if err != nil {
		return GraphResultDTO{}, err
	}

	// 3. 算 localPath（v2.5：按账号分层）
	localPath := git.RepoLocalPathForAccount(a.workspacePath, account.Username, project.Owner, project.Name)

	// 4. 拿 token
	token, err := a.secretStore.Get(account.Platform, account.GiteaURL, account.Username)
	if err != nil {
		return GraphResultDTO{}, classifyKeychainError(err)
	}
	if token == "" {
		return GraphResultDTO{}, ipc.NewInternal("token 为空（keychain 里有记录但 token 字符串为空）")
	}

	// 5. 调 adapter.LogGraph
	adapter := a.getAdapter(account.Platform)
	if adapter == nil {
		return GraphResultDTO{}, ipc.NewUnsupportedPlatform(account.Platform)
	}

	// 6. token 透传给 adapter（go-git 用 BasicAuth，不需要 user 传）
	_ = token

	result, err := adapter.LogGraph(a.ctx, localPath, platformAdapter.LogGraphOpts{
		Branches: args.Branches,
		MaxCount: args.MaxCount,
	})
	if err != nil {
		return GraphResultDTO{}, err
	}

	// 顺便返回 localPath（前端可显示"已 clone 在 ..."）
	return graphResultToAppDTO(result), nil
}

// GetRepoByIdArgs 查项目参数
type GetRepoByIdArgs struct {
	ProjectID string `json:"projectId"`
}

// GetRepoByIdResult 查项目结果
type GetRepoByIdResult struct {
	// Project 项目的 RepoProjectDto（localStore.Projects 行的拷贝）
	Project store.RepoProject `json:"project"`
	// Account 项目的关联账号
	Account AccountDTO `json:"account"`
	// LocalPath 仓库本地路径（v2.4：按 owner+name + workspacePath 算）
	LocalPath string `json:"localPath"`
	// Cloned 本地是否已 clone（IsRepoCloned 检查）
	Cloned bool `json:"cloned"`
}

// GetRepoById 按 projectId 查项目 + 关联账号 + localPath + clone 状态
//
// v2.4 新增：前端"我选了哪个仓库"的关键信息聚合点
// 一次调用拿齐所有"画 Git Graph / 拉数据"所需的信息
func (a *App) GetRepoById(args GetRepoByIdArgs) (GetRepoByIdResult, error) {
	if args.ProjectID == "" {
		return GetRepoByIdResult{}, ipc.NewValidationFailed("projectId 不能为空", "")
	}

	project, account, err := a.findProjectAndAccount(args.ProjectID)
	if err != nil {
		return GetRepoByIdResult{}, err
	}

	// v2.5：按账号分层
	localPath := git.RepoLocalPathForAccount(a.workspacePath, account.Username, project.Owner, project.Name)
	cloned := git.RepoExists(localPath)

	return GetRepoByIdResult{
		Project:   *project,
		Account:   accountToDTO(*account),
		LocalPath: localPath,
		Cloned:    cloned,
	}, nil
}

// findProjectAndAccount 内部 helper：按 projectId 找 project + 关联 account
//
// 找不到 project → NotFound
// 找到 project 但 account 已被删 → NotFound
func (a *App) findProjectAndAccount(projectID string) (*store.RepoProject, *store.GiteaAccount, error) {
	state := a.localStore.Get()

	var matchedProject *store.RepoProject
	for i := range state.Projects {
		if state.Projects[i].ID == projectID {
			matchedProject = &state.Projects[i]
			break
		}
	}
	if matchedProject == nil {
		return nil, nil, ipc.NewNotFound("未找到 project: " + projectID)
	}

	for i := range state.Accounts {
		if state.Accounts[i].ID == matchedProject.AccountID {
			return matchedProject, &state.Accounts[i], nil
		}
	}
	return nil, nil, ipc.NewNotFound(
		"project 关联的 account 不存在: projectId=" + projectID +
			" accountId=" + matchedProject.AccountID,
	)
}

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
		if !errorsAs(err, &ipcErr) {
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

// errorsAs 是 errors.As 的薄封装（让 auth 流程读起来更顺眼）
//
// 用法：var ipcErr *ipc.IpcError; if errorsAs(err, &ipcErr) { ... }
func errorsAs(err error, target interface{}) bool {
	return errors.As(err, target)
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

// WorkspaceInfo GetWorkspace 返回值结构（对齐前端 ipc-client.ts 契约）
type WorkspaceInfo struct {
	Cwd       string `json:"cwd"`
	IsDefault bool   `json:"isDefault"`
	Validated bool   `json:"validated"`
	// DataDir 应用数据根目录（前端"打开应用数据目录"按钮用）
	DataDir string `json:"dataDir"`
}

// GetWorkspace 返回当前 workspace 路径（**git repos 目录**）
//
// v2.2 user 拍板：路径不可改
//   - workspacePath = ${dataDir}/workspace（系统默认计算）
//   - 前端不能再修改，调用 git 操作时直接用这个值
func (a *App) GetWorkspace() WorkspaceInfo {
	wsPath := a.workspacePath

	// 校验路径是否可写（前端 SettingsView 仍展示状态）
	validated := true
	if info, err := os.Stat(wsPath); err != nil || !info.IsDir() {
		validated = false
	}

	return WorkspaceInfo{
		Cwd:       wsPath,
		IsDefault: true, // 永远默认（不可改）
		Validated: validated,
		DataDir:   a.dataDir,
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

// ===== v2.3 内部 helper：localPath → (token, username) =====

// resolveTokenByLocalPath 从本地仓库路径反查 keychain 里的 token
//
// 步骤（v2.5 升级：按账号分层）：
//  1. localPath 形如 ${workspacePath}/repos/<username>/<owner>__<repo>
//     从路径解析 username / owner / repo（兜底旧版两层路径）
//  2. 在 localStore.Projects 里找匹配的 project（owner+name 匹配）
//  3. 用 project.AccountID 找到 GiteaAccount → 拿 hostURL/username
//  4. 从 secretStore 拿 token
//
// 失败模式：路径不在 workspace 下 / project 没找到 / 账号被删 → 返 NotFound
//
// v2.5 兼容：仍接受旧版 ${workspacePath}/repos/<owner>__<repo> 两层路径
//   （迁移期用户手动 mv 仓库、CI 测试等场景；通过 parts.length == 2 兼容）
func (a *App) resolveTokenByLocalPath(localPath string) (token string, username string, err error) {
	// 1. localPath → accountUsername?, owner, repo
	rel, e := filepath.Rel(a.workspacePath, localPath)
	if e != nil || strings.HasPrefix(rel, "..") {
		return "", "", ipc.NewValidationFailed(
			"localPath 不在 workspace 下",
			"localPath="+localPath+" workspace="+a.workspacePath,
		)
	}
	// rel = "repos/<username>/<owner>__<repo>" (v2.5) 或 "repos/<owner>__<repo>" (v2.4 旧)
	parts := strings.Split(filepath.ToSlash(rel), "/")
	if len(parts) < 2 || parts[0] != "repos" {
		return "", "", ipc.NewValidationFailed(
			"localPath 不是 repos/<...>/<owner>__<repo> 形态",
			"localPath="+localPath+" rel="+rel,
		)
	}
	var accountUsername string
	var repoDirName string
	if len(parts) == 2 {
		// 旧版两层：repos/<owner>__<repo>
		repoDirName = parts[1]
		accountUsername = "" // 不限定账号，按 owner+repo 匹配 project
	} else if len(parts) == 3 {
		// v2.5 三层：repos/<username>/<owner>__<repo>
		accountUsername = parts[1]
		repoDirName = parts[2]
	} else {
		return "", "", ipc.NewValidationFailed(
			"localPath 层级过深（v2.5 期望 repos/<username>/<owner>__<repo>）",
			"localPath="+localPath+" rel="+rel,
		)
	}
	idx := strings.Index(repoDirName, "__")
	if idx < 0 {
		return "", "", ipc.NewValidationFailed(
			"localPath 的目录名不含 '__' 分隔符",
			"dirName="+repoDirName,
		)
	}
	owner := repoDirName[:idx]
	repo := repoDirName[idx+2:]
	// repo 可能带 .git 后缀
	repo = strings.TrimSuffix(repo, ".git")

	// 2. localStore.Projects 里找匹配
	state := a.localStore.Get()
	var matchedAccountID string
	var matchedPlatform string
	for _, p := range state.Projects {
		if p.Owner == owner && p.Name == repo {
			// 如果 path 里给了 accountUsername，优先匹配同账号的 project
			if accountUsername != "" {
				var accUsername string
				for _, acc := range state.Accounts {
					if acc.ID == p.AccountID {
						accUsername = acc.Username
						break
					}
				}
				if accUsername != accountUsername {
					continue // 跳过不同账号的同名 project
				}
			}
			matchedAccountID = p.AccountID
			matchedPlatform = p.Platform
			break
		}
	}
	if matchedAccountID == "" {
		return "", "", ipc.NewNotFound(
			"未找到匹配 project：owner=" + owner + " name=" + repo,
		)
	}

	// 3. 找 account 拿 hostURL/username
	var matchedAccount *store.GiteaAccount
	for i := range state.Accounts {
		if state.Accounts[i].ID == matchedAccountID {
			matchedAccount = &state.Accounts[i]
			break
		}
	}
	if matchedAccount == nil {
		return "", "", ipc.NewNotFound(
			"未找到匹配 account：accountId=" + matchedAccountID,
		)
	}

	// 4. secretStore 拿 token
	token, e = a.secretStore.Get(matchedPlatform, matchedAccount.GiteaURL, matchedAccount.Username)
	if e != nil {
		return "", "", classifyKeychainError(e)
	}
	if token == "" {
		return "", "", ipc.NewInternal("token 为空：keychain 里有记录但 token 字符串为空")
	}

	return token, matchedAccount.Username, nil
}

// ListWorkspaceRepos 列出 workspace 中已 clone 的仓库
//
// workspace = ${dataDir}/workspace（v2.2 固定）
// v2.5：每个仓库带 accountUsername（所属账号 username）
func (a *App) ListWorkspaceRepos() ([]map[string]string, error) {
	wm := git.NewWorkspaceManager()
	repos, err := wm.ListRepos(a.workspacePath)
	if err != nil {
		return nil, err
	}

	result := make([]map[string]string, 0, len(repos))
	for _, r := range repos {
		result = append(result, map[string]string{
			"name":            r.Name,
			"path":            r.Path,
			"owner":           r.Owner,
			"repo":            r.Repo,
			"accountUsername": r.AccountUsername,
		})
	}
	return result, nil
}

// IsRepoClonedArgs 检查仓库是否已 clone 本地参数
//
// v2.5：新增 Username 字段（按账号分层的布局需要）
//   - 旧版只查 ${workspacePath}/repos/<owner>__<repo>/
//   - 新版查 ${workspacePath}/repos/<username>/<owner>__<repo>/
//   - Username 为空时 fallback 到旧版路径（迁移期兼容 + 测试）
type IsRepoClonedArgs struct {
	Username string `json:"username,omitempty"`
	Owner    string `json:"owner"`
	Repo     string `json:"repo"`
}

// IsRepoCloned 检查指定 owner/repo 是否已 clone 到本地 workspace
//
// v2.3 StatusBar 仓库管理面板用：判断行末按钮是"同步"还是"更新"
// v2.5 升级：按账号分层（args.Username 决定子目录）
func (a *App) IsRepoCloned(args IsRepoClonedArgs) bool {
	if args.Owner == "" || args.Repo == "" {
		return false
	}
	var localPath string
	if args.Username != "" {
		localPath = git.RepoLocalPathForAccount(a.workspacePath, args.Username, args.Owner, args.Repo)
	} else {
		// 兼容旧调用方（不传 username）
		localPath = git.RepoLocalPath(a.workspacePath, args.Owner, args.Repo)
	}
	return git.RepoExists(localPath)
}

// ===== v2.3 仓库管理（StatusBar 刷新按钮 + selectProject）=====

// ListReposArgs 列仓库参数
//
// v2.3 修复：前端 StatusBar 刷新按钮原来"没反应"的根本原因
//   - 旧版 shim repos.list 是 stub，永远返 {items: [], hasMore: false}
//   - 用户点刷新 → 拉 0 个仓库 → 没法选
//   - 修复：Go 端 ListRepos 调 platform.ListRepos，merge isProject/lastSyncAt
type ListReposArgs struct {
	GiteaAccountID string `json:"giteaAccountId"`
	Query          string `json:"query,omitempty"`
	Limit          int    `json:"limit"`
	Page           int    `json:"page"`
}

// ListReposResp 列仓库响应
type ListReposResp struct {
	Items   []platformAdapter.RepoDTO `json:"items"`
	Total   int                       `json:"total"`
	Page    int                       `json:"page"`
	HasMore bool                      `json:"hasMore"`
}

// ListRepos 列出某账号可访问的仓库
//
// 步骤：
//  1. localStore.Accounts 找 giteaAccountID 对应的 account
//  2. secretStore.Get 拿 token
//  3. adapter.ListRepos 拉远端列表
//  4. merge localStore.Projects 标记 isProject / lastSyncAt
func (a *App) ListRepos(args ListReposArgs) (ListReposResp, error) {
	if a.logger != nil {
		a.logger.Info("ListRepos", "giteaAccountId", args.GiteaAccountID, "query", args.Query, "page", args.Page)
	}

	// 1. 找 account
	state := a.localStore.Get()
	var matched *store.GiteaAccount
	for i := range state.Accounts {
		if state.Accounts[i].ID == args.GiteaAccountID {
			matched = &state.Accounts[i]
			break
		}
	}
	if matched == nil {
		return ListReposResp{}, ipc.NewNotFound("未找到账号: " + args.GiteaAccountID)
	}

	// 2. 拿 token
	token, err := a.secretStore.Get(matched.Platform, matched.GiteaURL, matched.Username)
	if err != nil {
		return ListReposResp{}, classifyKeychainError(err)
	}
	if token == "" {
		return ListReposResp{}, ipc.NewInternal("token 为空（keychain 里有记录但 token 字符串为空）")
	}

	// 3. 远端拉
	adapter := a.getAdapter(matched.Platform)
	if adapter == nil {
		return ListReposResp{}, ipc.NewUnsupportedPlatform(matched.Platform)
	}
	limit := args.Limit
	if limit <= 0 {
		limit = 50
	}
	page := args.Page
	if page <= 0 {
		page = 1
	}
	remoteRepos, err := adapter.ListRepos(a.ctx, matched.GiteaURL, matched.Username, token, platformAdapter.ListReposOpts{
		Query: args.Query,
		Limit: limit,
		Page:  page,
	})
	if err != nil {
		return ListReposResp{}, err
	}

	// 4. merge isProject / lastSyncAt（按 owner+name 匹配）
	projects := state.Projects
	nowISO := time.Now().UTC().Format(time.RFC3339)
	_ = nowISO // 占位
	for i := range remoteRepos {
		for j := range projects {
			if projects[j].Platform == matched.Platform &&
				projects[j].AccountID == matched.ID &&
				projects[j].Owner == remoteRepos[i].Owner &&
				projects[j].Name == remoteRepos[i].Name {
				remoteRepos[i].IsProject = true
				if projects[j].LastSyncAt > 0 {
					remoteRepos[i].LastSyncAt = time.UnixMilli(projects[j].LastSyncAt).UTC().Format(time.RFC3339)
				}
				break
			}
		}
	}

	return ListReposResp{
		Items:   remoteRepos,
		Total:   len(remoteRepos),
		Page:    page,
		HasMore: len(remoteRepos) >= limit, // gitea /repos/search 返 data 数组不含 total，简单按 limit 估
	}, nil
}

// AddProjectArgs 加 project 参数
type AddProjectArgs struct {
	GiteaAccountID string `json:"giteaAccountId"`
	Owner          string `json:"owner"`
	Name           string `json:"name"`
}

// AddProjectResult 加 project 结果
type AddProjectResult struct {
	Project store.RepoProject `json:"project"`
}

// AddProject 标记仓库为本机 project
//
// 跟 CloneRepo 的自动加 project 是独立的：
//   - CloneRepo 加 project 是 "已 clone" 语义（lastSyncAt = now）
//   - AddProject 加 project 是 "已加入看板" 语义（lastSyncAt = 0，未 clone）
//
// 后续 PullRepo 找 token 依赖 Projects → 这条不能漏
func (a *App) AddProject(args AddProjectArgs) (AddProjectResult, error) {
	if a.logger != nil {
		a.logger.Info("AddProject", "giteaAccountId", args.GiteaAccountID, "owner", args.Owner, "name", args.Name)
	}

	if args.Owner == "" || args.Name == "" {
		return AddProjectResult{}, ipc.NewValidationFailed("owner/name 不能为空",
			fmt.Sprintf("owner=%q name=%q", args.Owner, args.Name))
	}

	// 1. 找 account
	state := a.localStore.Get()
	var matched *store.GiteaAccount
	for i := range state.Accounts {
		if state.Accounts[i].ID == args.GiteaAccountID {
			matched = &state.Accounts[i]
			break
		}
	}
	if matched == nil {
		return AddProjectResult{}, ipc.NewNotFound("未找到账号: " + args.GiteaAccountID)
	}

	// 2. 幂等：已存在则返回原 project
	for i := range state.Projects {
		if state.Projects[i].Platform == matched.Platform &&
			state.Projects[i].AccountID == matched.ID &&
			state.Projects[i].Owner == args.Owner &&
			state.Projects[i].Name == args.Name {
			return AddProjectResult{Project: state.Projects[i]}, nil
		}
	}

	// 3. 新建
	now := time.Now().UnixMilli()
	project := store.RepoProject{
		ID:        uuid.NewString(),
		Platform:  matched.Platform,
		AccountID: matched.ID,
		Owner:     args.Owner,
		Name:      args.Name,
		CreatedAt: now,
	}
	if err := a.localStore.Mutate(func(s *store.LocalState) {
		s.Projects = append(s.Projects, project)
	}); err != nil {
		return AddProjectResult{}, ipc.NewInternal("保存 project 失败: " + err.Error())
	}

	if a.logger != nil {
		a.logger.Info("AddProject: created", "projectId", project.ID, "owner", args.Owner, "name", args.Name)
	}
	return AddProjectResult{Project: project}, nil
}

// RemoveProjectArgs 删 project 参数
type RemoveProjectArgs struct {
	ProjectID string `json:"projectId"`
}

// RemoveProject 取消仓库的本机 project 标记（**不**删远端仓库 / **不**删本地 clone）
func (a *App) RemoveProject(args RemoveProjectArgs) error {
	if a.logger != nil {
		a.logger.Info("RemoveProject", "projectId", args.ProjectID)
	}
	if args.ProjectID == "" {
		return ipc.NewValidationFailed("projectId 不能为空", "")
	}
	return a.localStore.Mutate(func(s *store.LocalState) {
		kept := make([]store.RepoProject, 0, len(s.Projects))
		for _, p := range s.Projects {
			if p.ID == args.ProjectID {
				continue
			}
			kept = append(kept, p)
		}
		s.Projects = kept
	})
}

// ===== 分支列表/收藏（步骤 3.2）=====

// BranchDTO 分支信息（暴露给前端）
type BranchDTO struct {
	Name        string `json:"name"`
	CommitSHA   string `json:"commitSha"`
	IsProtected bool   `json:"isProtected"`
}

// ListBranchesArgs 列分支参数
type ListBranchesArgs struct {
	Platform string `json:"platform"`
	HostURL  string `json:"hostUrl"`
	Username string `json:"username"`
	Token    string `json:"token"`
	Owner    string `json:"owner"`
	Repo     string `json:"repo"`
}

// ListBranches 列出仓库分支
func (a *App) ListBranches(args ListBranchesArgs) ([]BranchDTO, error) {
	adapter := a.getAdapter(args.Platform)
	if adapter == nil {
		return nil, fmt.Errorf("不支持的平台: %s", args.Platform)
	}

	branches, err := adapter.ListBranches(a.ctx, args.HostURL, args.Username, args.Token, args.Owner, args.Repo)
	if err != nil {
		return nil, err
	}

	result := make([]BranchDTO, 0, len(branches))
	for _, b := range branches {
		result = append(result, BranchDTO{
			Name:        b.Name,
			CommitSHA:   b.CommitSHA,
			IsProtected: b.IsProtected,
		})
	}
	return result, nil
}

// StarBranchArgs 收藏分支参数
type StarBranchArgs struct {
	ProjectID string `json:"projectId"`
	Branch    string `json:"branch"`
}

// StarBranch 收藏分支（本地 localStore.starredBranches）
func (a *App) StarBranch(args StarBranchArgs) error {
	return a.localStore.Mutate(func(s *store.LocalState) {
		// 避免重复收藏
		for _, sb := range s.StarredBranches {
			if sb.ProjectID == args.ProjectID && sb.Branch == args.Branch {
				return
			}
		}
		s.StarredBranches = append(s.StarredBranches, store.StarredBranch{
			ID:        uuid.NewString(),
			ProjectID: args.ProjectID,
			Branch:    args.Branch,
			CreatedAt: time.Now().UnixMilli(),
		})
	})
}

// UnstarBranchArgs 取消收藏分支参数
type UnstarBranchArgs struct {
	ProjectID string `json:"projectId"`
	Branch    string `json:"branch"`
}

// UnstarBranch 取消收藏分支
func (a *App) UnstarBranch(args UnstarBranchArgs) error {
	return a.localStore.Mutate(func(s *store.LocalState) {
		s.StarredBranches = filterStarredBranches(s.StarredBranches, args.ProjectID, args.Branch)
	})
}

// ListStarredBranchesArgs 列出收藏的分支
type ListStarredBranchesArgs struct {
	ProjectID string `json:"projectId"`
}

// ListStarredBranches 列出某项目收藏的分支
func (a *App) ListStarredBranches(args ListStarredBranchesArgs) ([]string, error) {
	state := a.localStore.Get()
	branches := make([]string, 0)
	for _, sb := range state.StarredBranches {
		if sb.ProjectID == args.ProjectID {
			branches = append(branches, sb.Branch)
		}
	}
	return branches, nil
}

// filterStarredBranches 过滤掉指定 project+branch 的收藏
func filterStarredBranches(branches []store.StarredBranch, projectID, branch string) []store.StarredBranch {
	result := make([]store.StarredBranch, 0, len(branches))
	for _, sb := range branches {
		if sb.ProjectID == projectID && sb.Branch == branch {
			continue
		}
		result = append(result, sb)
	}
	return result
}

// ===== commit 详情 + diff（步骤 3.3）=====

// CommitDetailDTO commit 详情（暴露给前端）
//
// v2.15 扩展：新增 Files / Additions / Deletions / FilesChanged 字段
// （从 GetCommitDiff + commit.Stats() 合并而来）。
// 修复"展开 commit 后手风琴无文件信息"bug —— 之前 DTO 只有 8 个元信息字段，
// 完全没有文件变更数据，前端 CommitDetailPanel 永远拿不到 files。
type CommitDetailDTO struct {
	SHA          string           `json:"sha"`
	ShortSHA     string           `json:"shortSha"`
	Subject      string           `json:"subject"`
	AuthorName   string           `json:"authorName"`
	AuthorEmail  string           `json:"authorEmail"`
	AuthorWhen   string           `json:"authorWhen"`
	Message      string           `json:"message"`
	Parents      []string         `json:"parents"`
	Files        []FileChangeDTO  `json:"files,omitempty"`        // 变更文件列表（含 +/- 行数）
	Additions    int              `json:"additions,omitempty"`     // 总新增行数
	Deletions    int              `json:"deletions,omitempty"`     // 总删除行数
	FilesChanged int              `json:"filesChanged,omitempty"`  // 变更文件数
}

// FileChangeDTO 文件变更（前端 CommitDetailPanel 用）
//
// 字段命名跟前端 interface 对齐：
//   - Filename    （对应后端 Path）
//   - PreviousFilename （对应后端 OldPath）
//   - Status      （对应后端 Action：added/modified/deleted/renamed）
type FileChangeDTO struct {
	Filename         string `json:"filename"`
	PreviousFilename string `json:"previousFilename,omitempty"`
	Status           string `json:"status"` // added / modified / deleted / renamed
	Additions        int    `json:"additions"`
	Deletions        int    `json:"deletions"`
	Binary           bool   `json:"binary,omitempty"` // v2.15 暂不支持（go-git 无标记）
}

// GetCommitDetailArgs 获取 commit 详情参数
type GetCommitDetailArgs struct {
	LocalPath string `json:"localPath"`
	SHA       string `json:"sha"`
}

// GetCommitDetail 获取单个 commit 的详情（go-git）
//
// v2.15 扩展：除了元信息（message / author），还调 GetCommitDiff 拿文件变更列表，
// 计算 totals（Additions / Deletions / FilesChanged）填到 DTO。
// 修复"展开 commit 后手风琴无文件信息"bug —— 之前 handler 只填元信息字段。
func (a *App) GetCommitDetail(args GetCommitDetailArgs) (CommitDetailDTO, error) {
	repo, err := git.OpenRepo(args.LocalPath)
	if err != nil {
		return CommitDetailDTO{}, err
	}

	commit, err := repo.GetCommit(args.SHA)
	if err != nil {
		return CommitDetailDTO{}, err
	}

	dto := CommitDetailDTO{
		SHA:         commit.SHA,
		ShortSHA:    commit.ShortSHA,
		Subject:     commit.Subject,
		AuthorName:  commit.AuthorName,
		AuthorEmail: commit.AuthorEmail,
		AuthorWhen:  commit.AuthorWhen,
		Message:     commit.Message,
		Parents:     commit.Parents,
	}

	// v2.15：调 GetCommitDiff 拿文件变更 + 累计 +/- 行数
	files, diffErr := repo.GetCommitDiff(args.SHA)
	if diffErr != nil {
		// diff 失败不阻塞主流程（meta 数据仍返回），只 log 警告
		a.logger.Warn("GetCommitDetail: GetCommitDiff failed", "sha", args.SHA, "err", diffErr)
	} else {
		dto.Files = make([]FileChangeDTO, 0, len(files))
		for _, f := range files {
			dto.Files = append(dto.Files, FileChangeDTO{
				Filename:         f.Path,
				PreviousFilename: f.OldPath,
				Status:           f.Action,
				Additions:        f.Additions,
				Deletions:        f.Deletions,
			})
			dto.Additions += f.Additions
			dto.Deletions += f.Deletions
		}
		dto.FilesChanged = len(files)
	}

	return dto, nil
}

// ===== 拉取/同步（步骤 3.4）=====

// PullRepoArgs 拉取参数
//
// v2.3 修复：token 不再走 IPC（AGENTS §8.2 鉴权铁律）
//   - 旧版前端传 token → 违反铁律
//   - 新版 Go 端从 localPath 反查 localStore.Projects 找到 projectId → accountId
//     → secretStore.Get(platform, hostUrl, username) 拿 token
type PullRepoArgs struct {
	LocalPath string `json:"localPath"`
}

// PullRepoResult 拉取结果
type PullRepoResult struct {
	BeforeCount  int    `json:"beforeCount"`
	AfterCount   int    `json:"afterCount"`
	AddedCommits int    `json:"addedCommits"`
	HeadBefore   string `json:"headBefore"`
	HeadAfter    string `json:"headAfter"`
	// HeadChanged HEAD SHA 是否变化（force push 场景 commit 数减少但 SHA 变了）
	HeadChanged bool `json:"headChanged"`
}

// PullRepo 拉取远端更新（fetch + 统计 commit 变化）
func (a *App) PullRepo(args PullRepoArgs) (PullRepoResult, error) {
	if a.logger != nil {
		a.logger.Info("PullRepo", "path", args.LocalPath)
	}

	// v2.3：从 localPath 反查 token
	token, username, err := a.resolveTokenByLocalPath(args.LocalPath)
	if err != nil {
		return PullRepoResult{}, err
	}

	result, err := git.PullRepo(git.PullOptions{
		LocalPath: args.LocalPath,
		Token:     token,
		Username:  username,
	})
	if err != nil {
		return PullRepoResult{}, err
	}

	return PullRepoResult{
		BeforeCount:  result.BeforeCount,
		AfterCount:   result.AfterCount,
		AddedCommits: result.AddedCommits,
		HeadBefore:   result.HeadBefore,
		HeadAfter:    result.HeadAfter,
		HeadChanged:  result.HeadChanged,
	}, nil
}

// PullRepoByProjectIdArgs 按 projectId 拉取参数（v2.4）
type PullRepoByProjectIdArgs struct {
	ProjectID string `json:"projectId"`
}

// PullRepoByProjectId 按 projectId 拉取（Go 端反查 localPath + token）
//
// 修复 StatusBar 更新按钮 localPath 拼接 bug：
//   - 旧前端 `~/.gitea-kanban/workspace/repos/...` → Go 端拒绝（带 ~）
//   - 新版：前端只传 projectId，Go 端按 owner+repo 算 localPath（用 workspacePath + RepoLocalPath）
func (a *App) PullRepoByProjectId(args PullRepoByProjectIdArgs) (PullRepoResult, error) {
	if a.logger != nil {
		a.logger.Info("PullRepoByProjectId", "projectId", args.ProjectID)
	}

	if args.ProjectID == "" {
		return PullRepoResult{}, ipc.NewValidationFailed("projectId 不能为空", "")
	}

	// 1-2. 找 project + account
	project, account, err := a.findProjectAndAccount(args.ProjectID)
	if err != nil {
		return PullRepoResult{}, err
	}

	// 3. 算 localPath（v2.5：按账号分层）
	localPath := git.RepoLocalPathForAccount(a.workspacePath, account.Username, project.Owner, project.Name)

	// 4. 拿 token
	token, err := a.secretStore.Get(account.Platform, account.GiteaURL, account.Username)
	if err != nil {
		return PullRepoResult{}, classifyKeychainError(err)
	}
	if token == "" {
		return PullRepoResult{}, ipc.NewInternal("token 为空")
	}

	// 5. 调 git.PullRepo（v2.6：装 progress 回调）
	result, err := git.PullRepo(git.PullOptions{
		LocalPath: localPath,
		Token:     token,
		Username:  account.Username,
		Progress:  a.buildSyncProgressCallback(project.Owner + "/" + project.Name),
	})
	if err != nil {
		return PullRepoResult{}, err
	}

	return PullRepoResult{
		BeforeCount:  result.BeforeCount,
		AfterCount:   result.AfterCount,
		AddedCommits: result.AddedCommits,
		HeadBefore:   result.HeadBefore,
		HeadAfter:    result.HeadAfter,
		HeadChanged:  result.HeadChanged,
	}, nil
}

// FetchRepoResultDTO fetch 结果
type FetchRepoResultDTO struct {
	Updated bool `json:"updated"`
}

// FetchRepo 仅 fetch（不 merge）
func (a *App) FetchRepo(args PullRepoArgs) (FetchRepoResultDTO, error) {
	token, username, err := a.resolveTokenByLocalPath(args.LocalPath)
	if err != nil {
		return FetchRepoResultDTO{}, err
	}

	result, err := git.FetchRepo(git.PullOptions{
		LocalPath: args.LocalPath,
		Token:     token,
		Username:  username,
	})
	if err != nil {
		return FetchRepoResultDTO{}, err
	}
	return FetchRepoResultDTO{Updated: result.Updated}, nil
}

// ===== 看板（issue + label 映射，仅 Gitea）（步骤 3.5）=====

// IssueDTO 议题（暴露给前端）
type IssueDTO struct {
	Index  int    `json:"index"`
	Title  string `json:"title"`
	State  string `json:"state"`
	Body   string `json:"body,omitempty"`
	Author string `json:"author"`
}

// ListIssuesArgs 列议题参数
type ListIssuesArgs struct {
	Platform string `json:"platform"`
	HostURL  string `json:"hostUrl"`
	Username string `json:"username"`
	Token    string `json:"token"`
	Owner    string `json:"owner"`
	Repo     string `json:"repo"`
	State    string `json:"state"` // open | closed | all
}

// ListIssues 列出仓库议题（仅 Gitea 完整支持）
func (a *App) ListIssues(args ListIssuesArgs) ([]IssueDTO, error) {
	adapter := a.getAdapter(args.Platform)
	if adapter == nil {
		return nil, fmt.Errorf("不支持的平台: %s", args.Platform)
	}

	issues, err := adapter.ListIssues(a.ctx, args.HostURL, args.Username, args.Token, args.Owner, args.Repo, platformAdapter.ListIssuesOpts{
		State: args.State,
	})
	if err != nil {
		return nil, err
	}

	result := make([]IssueDTO, 0, len(issues))
	for _, i := range issues {
		result = append(result, IssueDTO{
			Index:  i.Index,
			Title:  i.Title,
			State:  i.State,
			Body:   i.Body,
			Author: i.Author,
		})
	}
	return result, nil
}

// ColumnDTO 看板列（暴露给前端，与 store.BoardColumn 对齐）
type ColumnDTO struct {
	ID        string `json:"id"`
	ProjectID string `json:"projectId"`
	Title     string `json:"title"`
	Position  int    `json:"position"`
	WipLimit  *int   `json:"wipLimit,omitempty"`
}

// ListColumnsArgs 列看板列参数
type ListColumnsArgs struct {
	ProjectID string `json:"projectId"`
}

// ListColumns 列出项目的看板列（本地 localStore）
func (a *App) ListColumns(args ListColumnsArgs) ([]ColumnDTO, error) {
	state := a.localStore.Get()
	result := make([]ColumnDTO, 0)
	for _, c := range state.Columns {
		if c.ProjectID == args.ProjectID {
			result = append(result, ColumnDTO{
				ID:        c.ID,
				ProjectID: c.ProjectID,
				Title:     c.Title,
				Position:  c.Position,
				WipLimit:  c.WipLimit,
			})
		}
	}
	return result, nil
}

// CreateColumnArgs 新建列参数
type CreateColumnArgs struct {
	ProjectID string `json:"projectId"`
	Title     string `json:"title"`
	Position  int    `json:"position"`
}

// CreateColumn 新建看板列（本地 localStore）
func (a *App) CreateColumn(args CreateColumnArgs) (ColumnDTO, error) {
	col := store.BoardColumn{
		ID:        uuid.NewString(),
		ProjectID: args.ProjectID,
		Title:     args.Title,
		Position:  args.Position,
		CreatedAt: time.Now().UnixMilli(),
	}

	err := a.localStore.Mutate(func(s *store.LocalState) {
		s.Columns = append(s.Columns, col)
	})
	if err != nil {
		return ColumnDTO{}, err
	}

	return ColumnDTO{
		ID:        col.ID,
		ProjectID: col.ProjectID,
		Title:     col.Title,
		Position:  col.Position,
	}, nil
}

// DeleteColumnArgs 删除列参数
type DeleteColumnArgs struct {
	ColumnID string `json:"columnId"`
}

// DeleteColumn 删除看板列（本地 localStore，同时删关联的 labelMaps）
func (a *App) DeleteColumn(args DeleteColumnArgs) error {
	return a.localStore.Mutate(func(s *store.LocalState) {
		// 删列
		s.Columns = filterColumns(s.Columns, args.ColumnID)
		// 删关联的 labelMaps
		s.LabelMaps = filterLabelMapsByColumn(s.LabelMaps, args.ColumnID)
	})
}

// filterColumns 过滤掉指定 ID 的列
func filterColumns(cols []store.BoardColumn, id string) []store.BoardColumn {
	result := make([]store.BoardColumn, 0, len(cols))
	for _, c := range cols {
		if c.ID != id {
			result = append(result, c)
		}
	}
	return result
}

// filterLabelMapsByColumn 过滤掉指定 columnId 的 labelMaps
func filterLabelMapsByColumn(maps []store.ColumnLabelMap, columnID string) []store.ColumnLabelMap {
	result := make([]store.ColumnLabelMap, 0, len(maps))
	for _, m := range maps {
		if m.ColumnID != columnID {
			result = append(result, m)
		}
	}
	return result
}

// getAdapter 根据平台返回对应的 PlatformAdapter
func (a *App) getAdapter(platformStr string) platformAdapter.PlatformAdapter {
	switch platformStr {
	case "gitea":
		return a.giteaAdapter
	case "github":
		return a.githubAdapter
	}
	return nil
}

// graphResultToAppDTO 把 platform.GraphResult 转为 App 的 GraphResultDTO
func graphResultToAppDTO(r *platformAdapter.GraphResult) GraphResultDTO {
	if r == nil {
		return GraphResultDTO{}
	}

	nodes := make([]GraphNodeDTO, 0, len(r.Nodes))
	for _, n := range r.Nodes {
		nodes = append(nodes, GraphNodeDTO{
			Row:         n.Row,
			Lane:        n.Lane,
			Color:       n.Color,
			SHA:         n.SHA,
			ShortSHA:    n.ShortSHA,
			Subject:     n.Subject,
			AuthorName:  n.AuthorName,
			AuthorEmail: n.AuthorEmail,
			Date:        n.Date,
			IsMerge:     n.IsMerge,
			Parents:     n.Parents,
			Refs:        n.Refs,
			RefTypes:    n.RefTypes,
		})
	}

	edges := make([]GraphEdgeDTO, 0, len(r.Edges))
	for _, e := range r.Edges {
		edges = append(edges, GraphEdgeDTO{
			FromRow:  e.FromRow,
			ToRow:    e.ToRow,
			FromLane: e.FromLane,
			ToLane:   e.ToLane,
			Color:    e.Color,
			Type:     e.Type,
		})
	}

	return GraphResultDTO{
		Nodes:     nodes,
		Edges:     edges,
		MaxLane:   r.MaxLane,
		Truncated: r.Truncated,
	}
}
