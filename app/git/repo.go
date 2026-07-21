package git

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing"

	"gitea-kanban/app/gitbinary"
)

// Repo 封装 go-git Repository，提供便捷查询方法
type Repo struct {
	repo      *git.Repository
	localPath string // 用于 native git 命令
}

// OpenRepo 打开本地仓库
func OpenRepo(localPath string) (*Repo, error) {
	repo, err := git.PlainOpen(localPath)
	if err != nil {
		return nil, fmt.Errorf("打开仓库失败: %w", err)
	}
	return &Repo{repo: repo, localPath: localPath}, nil
}

// CommitGpgStatus 单个 commit 的 GPG 签名状态。
//
// 字段对应 git log --format 的占位符：
//   - Status：%G? 返的单字符状态（G/B/U/X/Y/R/N/E）
//   - Key：%GF 返的签名者 key 指纹（hex）
//   - Name：%GS 返的 UID（昵称 <email>；缺失 UID 时 fallback 返指纹）
//
// 解析失败的 commit（git 命令返错 / 输出不含分隔符）对应字段为空字符串。
type CommitGpgStatus struct {
	Status string `json:"status"`
	Key    string `json:"key"`
	Name   string `json:"name"`
}

// Category 把签名状态归到语义分类：
//   - "valid"        G / g — 有效签名
//   - "unknown-trust"U     — 有效但 trust 未知
//   - "warn"         X / Y / R — key 过期 / 撤销 / 从服务器吊销
//   - "bad"          B     — 签名被破坏
//   - "none"         N     — 无签名
//   - "missing-key"  E     — 无法验证（缺公钥）
//   - "unknown"      其它
func (s CommitGpgStatus) Category() string {
	switch s.Status {
	case "G", "g":
		return "valid"
	case "U":
		return "unknown-trust"
	case "X", "Y", "R":
		return "warn"
	case "B":
		return "bad"
	case "N":
		return "none"
	case "E":
		return "missing-key"
	default:
		return "unknown"
	}
}

// Sha1LikeHex 判断字符串是否为 sha1 风格 hex（长度 40，仅 [0-9a-fA-F]），
// 用于区分 GPG 签名 UID 昵称 vs 指纹 fallback（git %GS 大写 hex）。
func Sha1LikeHex(s string) bool {
	if len(s) != 40 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}

// IsNameFingerprint 判断 Name 字符串实际是 key 指纹。
//
// 背景：git log %GS 在找不到姓名 UID 时会 fallback 返 key 指纹（40/64 字符 hex）。
// 例如 key ID 0x1234ABCD... 没有注册 Name 时，%GS 输出 1234ABCD...（hex）。
// 这种位置显示指纹比显示"UID 缺失"更诚实。
func (s CommitGpgStatus) IsNameFingerprint() bool {
	name := strings.TrimSpace(s.Name)
	if len(name) == 0 {
		return false
	}
	return Sha1LikeHex(name) || len(name) == 64
}

// getCommitGpgStatus 用系统 git log 单次读取签名状态 + 签名者 UID。
//
// 关键 format 占位符：
//   - %G? 单字符签名状态（G/B/U/X/Y/R/N/E）
//   - %GF 签名 key 指纹（hex）
//   - %GS 签名者 UID（昵称 <email>；缺失 UID 时 fallback 返指纹）
//
// 多签名 / merge commit 等复杂场景暂不覆盖：取第一条签名记录。
// go-git 5.16 原生不暴露 %G? 语义，必须走 native git 子进程。
func (r *Repo) getCommitGpgStatus(sha string) (*CommitGpgStatus, error) {
	ctx, cancel := context.WithTimeout(context.Background(), nativeGitTimeout)
	defer cancel()
	bin, err := gitbinary.ResolveGitBinaryPath("")
	if err != nil {
		return nil, err
	}
	subArgs := []string{
		"log", "-1", "--no-walk",
		"--format=%G?%x00%GF%x00%GS",
		sha,
	}
	output, err := gitbinary.RunGit(ctx, bin, r.localPath, subArgs...)
	if err != nil {
		return nil, err
	}
	if len(output) == 0 {
		return nil, nil
	}
	return parseGpgStatus(string(output)), nil
}

// parseGpgStatus 解析 "<Status><NULL><Fingerprint><NULL><UID>" 单行输出。
// 任何分隔符缺失 / 字段为空时用空字符串兜底，不返 error。
func parseGpgStatus(line string) *CommitGpgStatus {
	fields := strings.SplitN(line, "\x00", 4)
	gs := &CommitGpgStatus{}
	if len(fields) >= 1 {
		gs.Status = strings.TrimRight(fields[0], "\r\n")
	}
	if len(fields) >= 2 {
		gs.Key = strings.TrimSpace(strings.TrimRight(fields[1], "\r\n"))
	}
	if len(fields) >= 3 {
		gs.Name = strings.TrimSpace(strings.TrimRight(fields[2], "\r\n"))
	}
	return gs
}

// CommitDetail commit 详情（含完整 message）
type CommitDetail struct {
	SHA         string
	ShortSHA    string
	Subject     string
	AuthorName  string
	AuthorEmail string
	AuthorWhen  string
	Message     string
	Parents     []string
	Gpg         *CommitGpgStatus
}

// GetCommit 获取单个 commit 的详情
func (r *Repo) GetCommit(sha string) (*CommitDetail, error) {
	hash := plumbing.NewHash(sha)
	commit, err := r.repo.CommitObject(hash)
	if err != nil {
		return nil, fmt.Errorf("找不到 commit %s: %w", sha, err)
	}

	parents := make([]string, len(commit.ParentHashes))
	for i, h := range commit.ParentHashes {
		parents[i] = h.String()
	}

	var gpg *CommitGpgStatus
	if gs, err := r.getCommitGpgStatus(hash.String()); err == nil {
		gpg = gs
	}

	return &CommitDetail{
		SHA:         commit.Hash.String(),
		ShortSHA:    commit.Hash.String()[:7],
		Subject:     extractSubject(commit.Message),
		AuthorName:  commit.Author.Name,
		AuthorEmail: commit.Author.Email,
		AuthorWhen:  commit.Author.When.Format("2006-01-02T15:04:05Z07:00"),
		Message:     commit.Message,
		Parents:     parents,
		Gpg:         gpg,
	}, nil
}

// getCommitFileStatsGit 使用系统 git diff-tree 获取文件变更行数。
//
// 优先于 go-git commit.Stats()：系统 git 能正确处理 partial clone / blobless clone，
// 即使 blobs 未预下载也能按需获取（go-git 的 Stats() 在 blobless clone 下返回全 0）。
//
// 对于 blobless clone（GitHub 超大仓库使用 gh blobless clone --filter=blob:none），
// commit.Stats() 需要读取 blob 内容才能计算行数，但 blob 未在本地 → 返回 0。
// 系统 git diff-tree --numstat 只需 tree 对象和 commit 对象，不依赖 blob 内容。
func (r *Repo) getCommitFileStatsGit(sha string) (map[string][2]int, error) {
	args := []string{
		"-C", r.localPath,
		"diff-tree",
		"--numstat", // 输出格式：<adds>\t<dels>\t<path>
	}

	commit, err := r.repo.CommitObject(plumbing.NewHash(sha))
	if err != nil {
		return nil, fmt.Errorf("找不到 commit %s: %w", sha, err)
	}

	if len(commit.ParentHashes) > 0 {
		args = append(args, commit.ParentHashes[0].String(), sha)
	} else {
		args = append(args, "--root", sha)
	}

	ctx, cancel := context.WithTimeout(context.Background(), nativeGitTimeout)
	defer cancel()
	bin, err := gitbinary.ResolveGitBinaryPath("")
	if err != nil {
		// 与 v2.7 旧 fallback 行为一致：git diff-tree 失败时返空 map
		return map[string][2]int{}, nil
	}
	subArgs := args[2:] // 去掉 "-C", r.localPath 前缀，RunGit 会重新拼
	output, err := gitbinary.RunGit(ctx, bin, r.localPath, subArgs...)
	if err != nil {
		return map[string][2]int{}, nil
	}

	stats := map[string][2]int{}
	scanner := bufio.NewScanner(bytes.NewReader(output))
	for scanner.Scan() {
		line := scanner.Text()
		parts := strings.SplitN(line, "\t", 3)
		if len(parts) < 3 {
			continue
		}
		adds, _ := strconv.Atoi(parts[0])
		dels, _ := strconv.Atoi(parts[1])
		path := parts[2]
		stats[path] = [2]int{adds, dels}
	}

	return stats, nil
}

// GetCommitDiff 获取 commit 的 diff（v0.8.x 优化版：完全走 git subprocess，移除 go-git tree.Diff）
//
// 方案 B 核心改动（消除主因）：
//   - 移除 `parentTree.Diff(commitTree)`（go-git 递归遍历整棵树，O(N)，大仓库耗时 1~3s）
//   - 改用两个 git diff-tree subprocess 调用：
//     1. `--numstat` 获取每个文件的 additions/deletions（兼容 blobless clone）
//     2. `--name-status` 获取每个文件的操作类型（added/modified/deleted/renamed）
//   - 两个调用都只读 tree/commit 对象，不依赖 blob 内容
//   - 耗时 ≈ 1 × subprocess ≈ 30~80ms，替代之前的 1~3s
//
// 兼容 Gitea/GitHub 双数据源：都走本地 git，不依赖平台 API（AGENTS §1.1）。
func (r *Repo) GetCommitDiff(sha string) ([]FileChange, error) {
	hash := plumbing.NewHash(sha)
	commit, err := r.repo.CommitObject(hash)
	if err != nil {
		return nil, fmt.Errorf("找不到 commit %s: %w", sha, err)
	}

	// 1. git diff-tree --numstat：获取每个文件的 additions/deletions
	//    兼容 blobless clone（不依赖 blob 内容）
	statsMap, _ := r.getCommitFileStatsGit(sha)

	// 2. git diff-tree --name-status：获取每个文件的操作类型
	//    NUL 分隔（支持含特殊字符的文件名），比 go-git tree.Diff 轻量 10x
	actionsMap, _ := r.getCommitActionsGit(sha)

	changes := []FileChange{}
	hasParent := len(commit.ParentHashes) > 0

	if hasParent {
		// 有 parent：逐文件构建 FileChange
		// 优先用 actionsMap（git subprocess 精确判断 added/modified/deleted/renamed）
		// statsMap 有 additions/deletions（blobless clone 友好）
		for path, st := range statsMap {
			action := actionsMap[path]
			if action == "" {
				action = "modified" // 兜底
			}
			fc := FileChange{
				Path:      path,
				Additions: st[0],
				Deletions: st[1],
				Action:    action,
			}
			// 对于 renamed，OldPath 需要从 go-git 获取（subprocess 不直接暴露 rename source）
			if action == "renamed" {
				if rename, ok := r.getRenameSourceGit(sha, path); ok {
					fc.OldPath = rename
				}
			}
			changes = append(changes, fc)
		}
	} else {
		// 根 commit：所有文件都是新增
		for path, st := range statsMap {
			changes = append(changes, FileChange{
				Path:      path,
				Additions: st[0],
				Deletions: st[1],
				Action:    "added",
			})
		}
	}

	// 兜底：actionsMap 有但 statsMap 没有的文件（理论上不应出现，但健壮处理）
	for path, action := range actionsMap {
		if _, ok := statsMap[path]; !ok {
			if action == "deleted" {
				changes = append(changes, FileChange{
					Path:   path,
					Action: "deleted",
				})
			}
			// added 在 statsMap 里一定有，所以 added 不会落这里
		}
	}

	return changes, nil
}

// getCommitActionsGit 用系统 git diff-tree 获取变更文件列表及操作类型。
//
// 相比 go-git parentTree.Diff() 的优势：
//   - subprocess 只读 tree/commit 对象，不遍历 blob，速度快 10x
//   - --name-status 格式：A=added M=modified D=deleted R=renamed
//   - -z NUL 分隔天然支持含换行/空格/特殊字符的文件名
//
// root commit 用 --root 参数，无 parent。
func (r *Repo) getCommitActionsGit(sha string) (map[string]string, error) {
	args := []string{
		"-C", r.localPath,
		"diff-tree",
		"--name-status", // 输出格式：<A|M|D|R>\t<path>
		"-z",            // NUL 分隔（安全处理特殊字符）
	}

	commit, err := r.repo.CommitObject(plumbing.NewHash(sha))
	if err != nil {
		return nil, fmt.Errorf("找不到 commit %s: %w", sha, err)
	}

	if len(commit.ParentHashes) > 0 {
		args = append(args, commit.ParentHashes[0].String(), sha)
	} else {
		args = append(args, "--root", sha)
	}

	ctx, cancel := context.WithTimeout(context.Background(), nativeGitTimeout)
	defer cancel()
	bin, err := gitbinary.ResolveGitBinaryPath("")
	if err != nil {
		return map[string]string{}, nil
	}
	subArgs := args[2:]
	output, err := gitbinary.RunGit(ctx, bin, r.localPath, subArgs...)
	if err != nil {
		return map[string]string{}, nil
	}

	// 解析 "<A|M|D|R>\0<path>\0..." NUL 分隔流
	actions := map[string]string{}
	parts := bytes.Split(output, []byte{'\x00'})
	for i := 0; i+1 < len(parts); i += 2 {
		status := string(parts[i])
		path := string(parts[i+1])
		if path == "" {
			continue
		}
		var action string
		switch status {
		case "A":
			action = "added"
		case "M":
			action = "modified"
		case "D":
			action = "deleted"
		case "R":
			action = "renamed"
		case "C":
			action = "copied" // git 内部的 copied，视为 modified
		default:
			action = "modified"
		}
		actions[path] = action
	}

	return actions, nil
}

// getRenameSourceGit 用 git diff-tree 获取重命名文件的原始路径。
//
// git diff-tree --name-status -C 在检测到 rename 时会输出：
//
//	R<N>\t<old_path>\t<new_path>
//
// 其中 N 是相似度（0~100）。
// 我们用 --diff-filter=R 只取 renamed，然后用正则从输出中抠 old_path。
func (r *Repo) getRenameSourceGit(sha string, newPath string) (string, bool) {
	args := []string{
		"-C", r.localPath,
		"diff-tree",
		"--diff-filter=R",
		"--name-status",
		"-z",
	}

	commit, err := r.repo.CommitObject(plumbing.NewHash(sha))
	if err != nil {
		return "", false
	}

	if len(commit.ParentHashes) == 0 {
		return "", false
	}

	ctx, cancel := context.WithTimeout(context.Background(), nativeGitTimeout)
	defer cancel()
	bin, err := gitbinary.ResolveGitBinaryPath("")
	if err != nil {
		return "", false
	}
	subArgs := args[2:]
	output, err := gitbinary.RunGit(ctx, bin, r.localPath, subArgs...)
	if err != nil {
		return "", false
	}

	// 解析 "<R<N>>\0<old>\0<new>\0..." NUL 分隔流
	parts := bytes.Split(output, []byte{'\x00'})
	for i := 0; i+1 < len(parts); i += 3 {
		_ = string(parts[i]) // "R<number>" 状态
		oldPath := string(parts[i+1])
		newPathPart := string(parts[i+2])
		if newPathPart == newPath && oldPath != "" {
			return oldPath, true
		}
	}

	return "", false
}

// FileChange 文件变更
type FileChange struct {
	Path      string `json:"path"`
	OldPath   string `json:"oldPath,omitempty"`
	Action    string `json:"action"` // added / modified / deleted / renamed
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
}

// ResolveLocalHead 用 go-git 读本地 HEAD 的完整 SHA。
//
// 失败返回空字符串（不会报错），让调用方决定 fallback 策略。
// 用途：app.GetGitGraph 拿不到 opts.Head 时回退成本地 HEAD，让 layout 的
// isCurrent 标记有值；GitHub adapter 老版本没有这个 fallback，导致 local
// HEAD 的 dot 不会画成空心圆、tooltip 误标"不在 HEAD 中"。
func ResolveLocalHead(localPath string) string {
	r, err := git.PlainOpen(localPath)
	if err != nil {
		return ""
	}
	head, err := r.Head()
	if err != nil {
		return ""
	}
	return head.Hash().String()
}
