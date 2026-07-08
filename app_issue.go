package main

import (
	"fmt"
	platformAdapter "gitea-kanban/app/platform"
)

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
