package main

import (
	"gitea-kanban/app/git"
	"gitea-kanban/app/ipc"
	"gitea-kanban/app/platform/github"
)


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
	token, err := a.resolveToken(account)
	if err != nil {
		return PullRepoResult{}, err
	}

	if account.Platform == "github" {
		if gh, ok := a.githubAdapter.(*github.GitHubAdapter); ok {
			_ = gh.EnsureForkParentRemote(a.ctx, account.GiteaURL, token, project.Owner, project.Name, localPath)
		}
	}

	// 5. 调 git.PullRepo（v2.6：装 progress 回调）
	//
	// v0.6.3 架构调整（user 拍板 2026-07-04）：
	//   去掉所有 hardcoded fetch depth 限制，由用户掌控要加载多少 commit 到本地。
	//   配合 loadMoreGraph 动态加载，首次 sync 可以拉全量元数据（depth=0），
	//   需要用户主动权衡磁盘/网络代价（UnrealEngine 全量 ~28 GB 元数据）。
	//
	//   - depth=0：fetch 全量 commit + tree 元数据（不下载 blob，blobless + NoCheckout 仍然生效）
	//   - countLimit=0：精确统计全量 commit 数（usedCountLimit=0 时 go-git 走全量遍历）
	//   - singleBranch=false：fetch 所有分支（refs/heads/* + refs/tags/*），不限定为默认分支
	//   - noTags=false：fetch tag refs（不走 git.NoTags）
	//
	// 旧 v2.7~v2.9 设计的 singleBranch / isHugeRepo 启发式判断（unreal/chromium/linux/webkit
	// 关键词）全部移除——这逻辑是过渡期 hack，现在 Git Graph 有动态加载后不再需要。

	result, err := git.PullRepo(git.PullOptions{
		LocalPath: localPath,
		Token:     token,
		Username:  account.Username,
		// v0.6.3：depth=0（全量元数据），countLimit=0（精确统计全部）
		// GitHub / Gitea 统一走完整 fetch，不再按平台差异化限制
		CountLimit:   0,
		Depth:        0,
		SingleBranch: false,
		NoTags:       false,
		Progress:     a.buildSyncProgressCallback(project.Owner + "/" + project.Name),
		UseGitHubCLI: account.Platform == "github",
	})
	if err != nil {
		// v2.6 错误溯源：wrap 时把 owner/repo/localPath 一并带上
		//   之前只 wrap "fetch 失败" 这种话，前端 normalize 后只看到 '未知错误'
		//   现在 include 路径 + 原始 err.Error() 让前端能展示'打开仓库失败: <real err>'
		//   注：slog INFO 已经在入口打了 projectId；这里 ERROR 是冗余但更精准
		if a.logger != nil {
			a.logger.Error("PullRepoByProjectId: pull failed",
				"owner", project.Owner,
				"repo", project.Name,
				"localPath", localPath,
				"err", err.Error(),
			)
		}
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
