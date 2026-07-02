# tools/vscode-recheck

vscode-git-graph 几何对比工具集 —— 验证 Go 端 `BuildGraphVscode` 输出跟 vscode-git-graph 参考实现 1:1 一致。

## 替代关系

本目录（v0.3.0 merge `bd2aca3` 引入）替代了早期 v3.x refactor 阶段的 `.tools/vscode-standalone/`（Python + driver.ts 方案）。`.tools/vscode-standalone/` 已在 v0.3.0 merge 时被本目录取代，物理目录保留在 `.tools/` 下作历史参考，但 .gitignore 排除不再 git 跟踪。

如果 `.tools/vscode-standalone/` 不在你的本地存在，可以从 git 历史找回（`bd2aca3^` 之前的所有 commit）。

## 用法

### 1. 跑 Go 端 BuildGraphVscode 输出 JSON
```bash
go run ./tools/vscode-recheck <repo_path> [max_commits] > go-result.json
```

### 2. 跟 Python 端 vscode-git-graph 参考实现对比
```bash
python3 tools/vscode-recheck/compare.py go-result.json
```

### 3. 单页 HTML 调试输出
```bash
go run ./tools/vscode-recheck/debug <repo_path> [max_commits] > debug.html
```
浏览器打开 `debug.html` 即可看到 Go 端 BuildGraphVscode 在指定仓库上的 vscode-git-graph 风格 SVG 渲染。

### 4. 端到端回归套件
```bash
python3 tools/vscode-recheck/suite.py
```

## 文件清单

- `main.go` — Go 端：跑 BuildGraphVscode + 序列化 JSON
- `compare.py` — Python 端：对比 lane/color/edges 跟 vscode-git-graph 参考实现
- `vscode_graph.py` — Python 端：vscode-git-graph web/graph.ts 的 Python 复刻（参考实现）
- `dump-vscodecommits/main.go` — Go 端：从 go-git dump 真实 commit JSON（用于构造测试 fixture）
- `debug/main.go` — Go 端：独立 HTML + 内嵌 SVG 展示
- `suite.py` — Python 端：端到端回归套件
- `.gitignore` — 排除 `__pycache__/` + `*.pyc` / `*.pyo`

## 历史包袱

v0.3.0 review (`bd2aca3`) 指出：v3.0 早期存在两个并行的 vscode-git-graph 对比工具实现：
- `.tools/vscode-standalone/`（Python driver.ts 方案，.gitignore 排除）
- `tools/vscode-recheck/`（Go main.go 方案，git 跟踪）

二者功能重叠，但方案不一致。v0.3.0 merge 后以 `tools/vscode-recheck/` 为准；`.tools/vscode-standalone/` 物理保留作历史参考，无 git 引用，无代码引用。

## 后续清理

如果确认 `.tools/vscode-standalone/` 长期不被引用，可以物理删除整个 `.tools/` 目录。`.gitignore` 第 61 行的 `.tools/` 规则即使没有物理目录也保留，作为"防御性占位"防止未来误引入。