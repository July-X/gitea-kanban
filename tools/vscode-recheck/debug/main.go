// Command gitgraph-debug 生成一个独立的 HTML, 内嵌 SVG 展示 Go 端
// BuildGraphVscode 在指定仓库上的输出, 按前端 renderGraphVscode 的
// 1:1 复刻几何公式 (GRID 16x24, 贝塞尔 C, 12 色调色板) 渲染。
//
// 用法:
//   go run ./tools/vscode-recheck/debug <repo_path> [max_commits] > debug.html
//
// 然后用浏览器打开 debug.html 即可看到 vscode-git-graph 风格的 git 图。
package main

import (
	"encoding/json"
	"fmt"
	"html"
	"os"
	"strconv"

	gogit "github.com/go-git/go-git/v5"
	"gitea-kanban/app/git"
	"gitea-kanban/app/git/graph"
)

const (
	// 对齐 vscode-git-graph src/config.ts:278
	// grid.x=16, grid.y=24, offsetX=16, offsetY=12, expandY=250
	GRID_X        = 16
	GRID_Y        = 24
	OFFSET_X      = 16
	OFFSET_Y      = 12
	VERTEX_RADIUS = 4
	EXPAND_Y      = 250

	// 跨 lane 贝塞尔控制点 y 偏移
	// vscode 默认 GRID_Y * 0.8 = 19.2 让曲线拉得"很缓",但跟真实仓里
	// dot-to-dot 紧凑过渡不符 (dot 圆心之间只有 24px 高度,曲线应紧凑)
	// 设为 6px ≈ dot 半径,让弯折在 row1 底→row2 顶 的小空间内完成
	CURVE_CONTROL_DY = 6
)

// 对齐 vscode-git-graph web/graph.ts config.colours 默认 12 色
var VSCODE_COLORS = []string{
	"#0085d9", // 0
	"#d9008f", // 1
	"#00d90a", // 2
	"#d98500", // 3
	"#a300d9", // 4
	"#ff0000", // 5
	"#00d9cc", // 6
	"#e138e8", // 7
	"#85d900", // 8
	"#dc5b23", // 9
	"#6f24d6", // 10
	"#ffcc00", // 11
}

type edgeJSON struct {
	FromRow  int    `json:"from_row"`
	ToRow    int    `json:"to_row"`
	FromLane int    `json:"from_lane"`
	ToLane   int    `json:"to_lane"`
	Color    int    `json:"color"`
	Type     string `json:"type"`
}

type commitJSON struct {
	SHA     string   `json:"sha"`
	Row     int      `json:"row"`
	Lane    int      `json:"lane"`
	Color   int      `json:"color"`
	IsMerge bool     `json:"is_merge"`
	Subject string   `json:"subject"`
	Author  string   `json:"author"`
	Date    string   `json:"date"`
	Parents []string `json:"parents"`
	Refs    []string `json:"refs"`
}

type output struct {
	Meta struct {
		Repo       string `json:"repo"`
		MaxCommits int    `json:"max_commits"`
		Head       string `json:"head"`
	} `json:"meta"`
	Commits []commitJSON `json:"commits"`
	Edges   []edgeJSON   `json:"edges"`
	MaxLane int          `json:"max_lane"`
	Branches []branchJSON `json:"branches"`
}

type lineJSON struct {
	X1          int  `json:"x1"`
	Y1          int  `json:"y1"`
	X2          int  `json:"x2"`
	Y2          int  `json:"y2"`
	LockedFirst bool `json:"locked_first"`
}

type branchJSON struct {
	Color int       `json:"color"`
	End   int       `json:"end"`
	Lines []lineJSON `json:"lines"`
}

type pathOut struct {
	d    string
	hex  string
	idx  int
	kind string // "line" 或 "shadow" (vscode Branch.drawPath:149-159)
}

type nodeOut struct {
	cx, cy  float64
	r       float64
	hex     string
	sha     string
	short   string
	subject string
	isCurrent bool // HEAD 节点 (vscode Vertex.draw: 空心 stroke-only)
	isStash   bool // stash 节点 (外圈 r=4.5 + 内圈 r=2)
}

type line struct {
	p1x, p1y, p2x, p2y int
	lockedFirst        bool
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: debug <repo_path> [max_commits]")
		os.Exit(2)
	}
	repo := os.Args[1]
	globalRepoName = repo
	maxCommits := 0 // 0 = 全部 commit (不截断)
	if len(os.Args) >= 3 {
		n, err := strconv.Atoi(os.Args[2])
		if err != nil {
			fmt.Fprintf(os.Stderr, "invalid max_commits: %v\n", err)
			os.Exit(2)
		}
		maxCommits = n
	}

	logOpts := git.LogOptions{LocalPath: repo, MaxCount: maxCommits}
	logRes, err := git.LogCommits(logOpts)
	if err != nil {
		fmt.Fprintf(os.Stderr, "LogCommits failed: %v\n", err)
		os.Exit(1)
	}
	head := resolveHead(repo)

	g := graph.BuildGraphVscodeWithHead(logRes.Commits, head)

	out := output{}
	out.Meta.Repo = repo
	out.Meta.MaxCommits = maxCommits
	out.Meta.Head = head
	out.MaxLane = g.MaxLane

	for _, n := range g.Nodes {
		t := "normal"
		_ = t
		c := commitJSON{
			SHA: n.SHA, Row: n.Row, Lane: n.Lane, Color: n.Color,
			IsMerge: n.IsMerge, Subject: n.Subject,
			Author: n.AuthorName, Date: n.Date,
			Parents: n.Parents, Refs: n.Refs,
		}
		out.Commits = append(out.Commits, c)
	}
	for _, e := range g.Edges {
		t := "normal"
		switch e.Type {
		case graph.EdgeBranch:
			t = "branch"
		case graph.EdgeMerge:
			t = "merge"
		}
		out.Edges = append(out.Edges, edgeJSON{
			FromRow: e.FromRow, ToRow: e.ToRow,
			FromLane: e.FromLane, ToLane: e.ToLane,
			Color: e.Color, Type: t,
		})
	}

	// 序列化 branches (vscode 真实输出格式: color + end + lines)
	for _, b := range g.Branches {
		lines := make([]lineJSON, 0, len(b.Lines))
		for _, ln := range b.Lines {
			lines = append(lines, lineJSON{X1: ln.X1, Y1: ln.Y1, X2: ln.X2, Y2: ln.Y2, LockedFirst: ln.LockedFirst})
		}
		out.Branches = append(out.Branches, branchJSON{Color: b.Color, End: b.End, Lines: lines})
	}

	paths, nodes := renderGraphVscode(g)
	svg := buildSVG(paths, nodes, g.MaxLane, len(g.Nodes))

	jsonBytes, _ := json.MarshalIndent(out, "", "  ")
	// commit 列表默认显示前 200 个, JSON 包含全部 (供排查用)
	displayLimit := 200
	if len(out.Commits) > displayLimit {
		displayLimit = len(out.Commits) // debug 工具尽量显示全部, 除非实在太大 (>200)
	}
	fmt.Println(buildHTML(svg, string(jsonBytes), out.Commits, displayLimit))
}

func resolveHead(repo string) string {
	r, err := gogit.PlainOpen(repo)
	if err != nil {
		return ""
	}
	head, err := r.Head()
	if err != nil {
		return ""
	}
	return head.Hash().String()
}

func renderGraphVscode(g *graph.GraphResult) ([]pathOut, []nodeOut) {
	// 按 vscode 真实做法: 一个 branch 一条 SVG path
	// Branch 内部的 line 列表是"沿 column 顺时针"的连续序列, 首尾相接,
	// 拼成一条 path 就形成 column 0 主线贯通的视觉效果
	// (vscode Branch.draw:118-146)
	paths := []pathOut{}
	for bidx, b := range g.Branches {
		hex := VSCODE_COLORS[b.Color%len(VSCODE_COLORS)]

		// 1) 转像素坐标 + 处理 expandAt
		type placedT struct {
			p1x, p1y, p2x, p2y float64
			lockedFirst        bool
		}
		placed := []placedT{}
		for _, ln := range b.Lines {
			x1 := float64(ln.X1)*GRID_X + OFFSET_X
			y1 := float64(ln.Y1)*GRID_Y + OFFSET_Y
			x2 := float64(ln.X2)*GRID_X + OFFSET_X
			y2 := float64(ln.Y2)*GRID_Y + OFFSET_Y
			placed = append(placed, placedT{x1, y1, x2, y2, ln.LockedFirst})
		}
		// 2) 简化同列共线段 (vscode Branch.draw:106-116)
		//    "同列 + 首尾相接" 才合并 (跨 lane 永远保留为独立 line)
		simplified := []placedT{}
		for _, seg := range placed {
			last := len(simplified) - 1
			if last >= 0 && simplified[last].p2x == seg.p1x && simplified[last].p2y == seg.p1y && simplified[last].p2x == seg.p2x {
				simplified[last].p2y = seg.p2y
			} else {
				simplified = append(simplified, seg)
			}
		}
		// 3) 拼 path d: 跨 lane 用 C 贝塞尔 + 真实 dy = GRID_Y * 0.8 (vscode 默认)
		//    C 贝塞尔的控制点偏移 = 0.8*GRID_Y = 19.2, 跟 vscode Branch.draw:76 一致
		//    之前 debug 工具用 dy=3 是为了"dot 之间紧凑", 但跟 vscode 真实渲染不一致,
		//    这里恢复 vscode 默认 0.8*GRID_Y, 看真实视觉效果
		dy := GRID_Y * 0.8
		cur := ""
		for i, seg := range simplified {
			x1, y1, x2, y2 := seg.p1x, seg.p1y, seg.p2x, seg.p2y
			// vscode Branch.draw:131: 新段起点跟前段终点不连续时才开 M
			// (但我们 line list 已经按 column 顺时针排序, 永远连续, 所以通常不开 M)
			continuous := i > 0 && cur != "" &&
				simplified[i-1].p2x == x1 && simplified[i-1].p2y == y1
			if !continuous {
				cur += fmt.Sprintf("M %.0f %.1f", x1, y1)
			}
			if x1 == x2 {
				// 垂直线 (L)
				cur += fmt.Sprintf(" L %.0f %.1f", x2, y2)
			} else {
				// C 贝塞尔: 控制点 (x1, y1+dy) (x2, y2-dy) 端点 (x2, y2)
				cur += fmt.Sprintf(" C %.0f %.1f %.0f %.1f %.0f %.1f",
					x1, y1+dy, x2, y2-dy, x2, y2)
			}
		}
		if cur != "" {
			// vscode Branch.drawPath (graph.ts:149-159) 每条 path 画 2 遍:
			//   shadow (stroke-width=4 stroke-opacity=0.25) + line (stroke-width=2)
			paths = append(paths, pathOut{d: cur, hex: hex, idx: bidx, kind: "shadow"})
			paths = append(paths, pathOut{d: cur, hex: hex, idx: bidx, kind: "line"})
		}
	}

	nodes := []nodeOut{}
	for _, n := range g.Nodes {
		cx := float64(n.Lane)*GRID_X + OFFSET_X
		cy := float64(n.Row)*GRID_Y + OFFSET_Y
		hex := VSCODE_COLORS[n.Color%len(VSCODE_COLORS)]
		short := n.SHA
		if len(short) > 7 {
			short = short[:7]
		}
		nodes = append(nodes, nodeOut{
			cx: cx, cy: cy, r: VERTEX_RADIUS,
			hex: hex, sha: n.SHA, short: short, subject: n.Subject,
			isCurrent: n.IsCurrent,
			isStash:   n.IsStash,
		})
	}
	return paths, nodes
}

func buildSVG(paths []pathOut, nodes []nodeOut, maxLane, nCommits int) string {
	width := 2*OFFSET_X + (maxLane+1)*GRID_X
	height := nCommits*GRID_Y + OFFSET_Y
	var s string
	s += fmt.Sprintf(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" width="%d" height="%d" style="background:#fafafa">`,
		width, height, width, height)
	for _, p := range paths {
		if p.kind == "shadow" {
			// vscode main.css:110-114: shadow stroke-width=4 stroke-opacity=0.75
			// 这里 stroke-opacity=0.25 比 vscode 略淡, 跟浅底色背景更协调
			s += fmt.Sprintf(`<path d="%s" stroke="%s" stroke-width="4" stroke-opacity="0.25" fill="none" stroke-linecap="round"/>`,
				html.EscapeString(p.d), p.hex)
		} else {
			s += fmt.Sprintf(`<path d="%s" stroke="%s" stroke-width="2" fill="none" stroke-linecap="round"/>`,
				html.EscapeString(p.d), p.hex)
		}
	}
	for _, n := range nodes {
		// vscode Vertex.draw: dot r=4, HEAD 空心 (fill=#bg stroke=color stroke-width=2),
		// 普通 dot stroke=#bg stroke-width=1 stroke-opacity=0.75
		if n.isCurrent {
			// HEAD: fill=白底, stroke=color, stroke-width=2
			s += fmt.Sprintf(`<circle cx="%.1f" cy="%.1f" r="%.1f" fill="#fff" stroke="%s" stroke-width="2"/>`,
				n.cx, n.cy, n.r, n.hex)
		} else if n.isStash {
			// stash: 外圈 r=4.5 + 内圈 r=2
			s += fmt.Sprintf(`<circle cx="%.1f" cy="%.1f" r="%.1f" fill="none" stroke="%s" stroke-width="1.5"/>`,
				n.cx, n.cy, n.r, n.hex)
			s += fmt.Sprintf(`<circle cx="%.1f" cy="%.1f" r="%.1f" fill="none" stroke="%s" stroke-width="1"/>`,
				n.cx, n.cy, n.r-2.5, n.hex)
		} else {
			s += fmt.Sprintf(`<circle cx="%.1f" cy="%.1f" r="%.1f" fill="%s" stroke="#fff" stroke-width="1" stroke-opacity="0.75"/>`,
				n.cx, n.cy, n.r, n.hex)
		}
	}
	s += `</svg>`
	return s
}

func buildHTML(svg, jsonStr string, commits []commitJSON, displayLimit int) string {
	repoShort := repoBaseName()
	return fmt.Sprintf(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>vscode-git-graph 渲染</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 24px; background: #f0f0f0; }
  h1 { margin: 0 0 8px 0; font-size: 20px; }
  h2 { margin: 24px 0 8px 0; font-size: 16px; padding: 8px 12px; background: #2d2d2d; color: #fff; border-radius: 4px; }
  h2 .tag { display: inline-block; padding: 2px 8px; border-radius: 3px; font-size: 11px; margin-left: 8px; vertical-align: middle; background: #0085d9; }
  .meta { color: #666; font-size: 13px; margin-bottom: 16px; }
  .container { background: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); padding: 16px; overflow-x: auto; }
  .layout { display: flex; gap: 24px; align-items: flex-start; }
  .graph { flex-shrink: 0; border: 1px dashed #ddd; }
  .commit-list { flex: 1; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12px; }
  .commit-row { display: flex; align-items: center; height: 24px; gap: 8px; }
  .commit-row .lane-info { color: #999; font-size: 10px; min-width: 80px; font-family: ui-monospace, monospace; }
  .commit-row .short-sha { color: #888; }
  .commit-row .subject { color: #333; }
  .commit-row.merge .subject { color: #666; }
  .json { margin-top: 24px; padding: 16px; background: #f8f8f8; border-radius: 6px; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 11px; max-height: 400px; overflow: auto; }
  .ref { display: inline-block; padding: 1px 5px; border-radius: 3px; font-size: 10px; margin-right: 2px; }
  .ref-branch { background: #e3f2fd; color: #1565c0; }
  .ref-tag { background: #fff3e0; color: #e65100; }
  .ref-remote { background: #f3e5f5; color: #6a1b9a; }
</style>
</head>
<body>
<h1>vscode-git-graph 风格渲染: %s</h1>
<div class="meta">
  commits: %d &middot;
  algorithm: BuildGraphVscode (1:1 复刻 web/graph.ts::Branch.draw)
</div>

<div class="container">
  <h2>SVG 渲染 <span class="tag">vscode 风格</span></h2>
  <div class="layout">
    <div class="graph">%s</div>
    <div class="commit-list">%s</div>
  </div>
</div>

<details><summary>Raw JSON (BuildGraphVscode 输出, 共 %d 个 commit)</summary><pre class="json">%s</pre></details>

</body>
</html>`,
		html.EscapeString(repoShort),
		len(commits),
		svg,
		buildCommitList(commits, displayLimit),
		len(commits),
		html.EscapeString(jsonStr),
	)
}

var globalRepoName = ""

func repoBaseName() string {
	// 简单取最后一个路径段
	if globalRepoName == "" {
		return "repo"
	}
	for i := len(globalRepoName) - 1; i >= 0; i-- {
		if globalRepoName[i] == '/' {
			return globalRepoName[i+1:]
		}
	}
	return globalRepoName
}

func buildCommitList(commits []commitJSON, limit int) string {
	var s string
	shown := commits
	if limit > 0 && len(commits) > limit {
		shown = commits[:limit]
	}
	for _, c := range shown {
		refsHTML := ""
		for _, r := range c.Refs {
			cls := "ref-branch"
			if startsWith(r, "v") || startsWith(r, "release") {
				cls = "ref-tag"
			} else if startsWith(r, "origin/") || startsWith(r, "upstream/") {
				cls = "ref-remote"
			}
			refsHTML += fmt.Sprintf(`<span class="ref %s">%s</span>`, cls, html.EscapeString(r))
		}
		mergeCls := ""
		if c.IsMerge {
			mergeCls = " merge"
		}
		short := c.SHA
		if len(short) > 7 {
			short = short[:7]
		}
		dateShort := c.Date
		if len(dateShort) > 10 {
			dateShort = dateShort[:10]
		}
		s += fmt.Sprintf(
			`<div class="commit-row%s">
        <span class="lane-info">L%d C%d</span>
        <span class="short-sha">%s</span>
        <span class="refs">%s</span>
        <span class="subject">%s</span>
        <span class="lane-info">%s</span>
      </div>`,
			mergeCls, c.Lane, c.Color, short, refsHTML,
			html.EscapeString(c.Subject), dateShort,
		)
	}
	return s
}

func startsWith(s, prefix string) bool {
	return len(s) >= len(prefix) && s[:len(prefix)] == prefix
}
