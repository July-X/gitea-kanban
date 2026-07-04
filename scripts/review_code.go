// ===== 行内评审评论 API (v0.5.0 M4) =====

// giteaReviewCommentRaw Gitea /pulls/{index}/comments 原始响应
type giteaReviewCommentRaw struct {
	ID        int64         `json:"id"`
	Body      string        `json:"body"`
	User      *giteaUserRaw `json:"user"`
	Path      string        `json:"path"`
	Line      int           `json:"new_position"`
	Created   string        `json:"created_at"`
	Updated   string        `json:"updated_at"`
}

// giteaReviewCommentToDTO 映射为平台中性 PullReviewCommentDto
func giteaReviewCommentToDTO(r giteaReviewCommentRaw) platform.PullReviewCommentDto {
	out := platform.PullReviewCommentDto{
		ID:        r.ID,
		Body:      r.Body,
		Path:      r.Path,
		Line:      r.Line,
		CreatedAt: r.Created,
		UpdatedAt: r.Updated,
	}
	if r.User != nil {
		out.Author = &platform.PullUserDTO{
			Username:  r.User.Login,
			AvatarURL: r.User.AvatarURL,
		}
	}
	return out
}

// ListPullReviewComments 列行内评审评论 (GET /repos/{owner}/{repo}/pulls/{index}/comments)
func (a *GiteaAdapter) ListPullReviewComments(ctx context.Context, hostURL, username, token, owner, repo string, index int) ([]platform.PullReviewCommentDto, error) {
	var raw []giteaReviewCommentRaw
	path := fmt.Sprintf("/repos/%s/%s/pulls/%d/comments", owner, repo, index)
	if err := a.doRequest(ctx, hostURL, token, "GET", path, nil, &raw); err != nil {
		return nil, err
	}
	out := make([]platform.PullReviewCommentDto, 0, len(raw))
	for _, r := range raw {
		out = append(out, giteaReviewCommentToDTO(r))
	}
	return out, nil
}

// CreatePullReviewComment 创建行内评审评论 (POST /repos/{owner}/{repo}/pulls/{index}/comments)
func (a *GiteaAdapter) CreatePullReviewComment(ctx context.Context, hostURL, username, token, owner, repo string, index int, body string, filePath string, line int) (*platform.PullReviewCommentDto, error) {
	if strings.TrimSpace(body) == "" {
		return nil, ipc.NewValidationFailed("评论内容不能为空", "")
	}
	payload := map[string]any{
		"body":         body,
		"path":         filePath,
		"new_position": line,
	}
	reader, err := encodeJSONBody(payload)
	if err != nil {
		return nil, err
	}
	var raw giteaReviewCommentRaw
	apiPath := fmt.Sprintf("/repos/%s/%s/pulls/%d/comments", owner, repo, index)
	if err := a.doRequest(ctx, hostURL, token, "POST", apiPath, reader, &raw); err != nil {
		return nil, err
	}
	dto := giteaReviewCommentToDTO(raw)
	return &dto, nil
}

