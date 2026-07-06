// Package platform 定义多平台常量与类型。
//
// v2 架构支持多平台（Gitea / GitHub），本包是平台标识的 single source of truth。
// 账号（GiteaAccount）和仓库项目（RepoProject）都用 Platform 字段标记所属平台。
package platform

// Platform 平台类型
type Platform string

const (
	// Gitea Gitea 自托管平台
	Gitea Platform = "gitea"
	// GitHub GitHub 平台
	GitHub Platform = "github"
)
