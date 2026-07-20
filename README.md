# gitea-kanban

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Latest Release](https://img.shields.io/github/v/release/July-X/gitea-kanban)](https://github.com/July-X/gitea-kanban/releases/latest)
[![Platform: macOS+Windows](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey)](https://github.com/July-X/gitea-kanban/releases)
[![Go Version](https://img.shields.io/badge/Go-1.22+-00ADD8?logo=go&logoColor=white)](https://go.dev)
[![Wails v2](https://img.shields.io/badge/Wails-v2.12-red)](https://wails.io)

> 基于 **Gitea / GitHub** 的桌面端 Git Graph + 看板工具。
> 给开发者、PM、设计师、市场、运营一起用 —— 一边看代码改动，一边排任务、看流程。

---

## 这是什么

gitea-kanban 是一个**桌面应用**（不是网页、不是命令行），装在你的电脑上。
它把你团队在 **Gitea** 或 **GitHub** 上的工作 —— 议题、分支、提交、合并请求 —— 整理成两种好读的形式：

- **Git Graph（核心）**：把一个仓库所有分支的 commit 按时间画成线，方便看谁在改什么、分支怎么合并。
- **看板**：像便利贴墙一样，每张卡片是一个议题，可以在列之间拖来拖去（Gitea 完整支持；GitHub 暂未支持）。

桌面应用的好处：断网也能看缓存、令牌只存在你自己电脑的钥匙串里、不用每次开浏览器登录。
它说"人话"——按钮、提示、错误信息都避免技术词，危险操作都会二次确认。

## 特性

- **Git Graph（v0.6.0+）**：自研 lane 布局算法，1:1 复刻 [vscode-git-graph](https://github.com/mhutchie/vscode-git-graph)；commit DAG、分支、ref badge、**提交签名验证（9 种 GPG 状态）**、提交搜索、深历史按需 deepen。
- **PR 管理（v0.6.0+）**：列表 / 详情 / 合并 / 关闭 / 评论（含 Reaction）/ Review（含行内评论）/ 文件 Diff / Milestone / 标签 / 指派人 / 评审人。
- **多平台**：Gitea 完整支持；GitHub 已支持 PR 闭环 + 属性编辑器（v0.7.0+）。
- **离线友好**：本地 JSON + go-git `NoCheckout` 轻量模式（只拉元数据，磁盘 -99%）。
- **安全**：token 存系统 keychain（macOS Keychain / Windows Credential Vault / Linux Secret Service），从不落盘。
- **自动更新（v0.8.0+）**：内置 ed25519 签名验证 + 分平台安装，启动期后台检查更新。
- **零术语**：UI 文案走"人话"，不出现 manifest / signature / canary 等原词。
- **暗色 / 亮色双主题**：v1.2 拍板，2 主题 fixed，不搞多主题切换。

## 平台能力对照（v0.7.0+ 状态）

| 能力 | Gitea | GitHub |
|---|---|---|
| 验证 token | ✅ | ✅ |
| 列仓库 | ✅ | ✅ |
| 同步 + Git Graph | ✅ | ✅ |
| PR 列表 / 详情 / 合并 / 关闭 | ✅ | ✅ |
| PR 评论（含 Reaction） | ✅ | ✅ |
| PR Review（含行内评论） | ✅ | ✅ |
| PR 文件列表 + Diff | ✅ | ✅ |
| PR 标签 / 指派人 / 评审人 | ✅ | ✅（v0.7.0 补全后端）|
| PR Milestone | ✅ | ✅（v0.7.0 补全后端）|
| Issue 列表 / 看板 | ✅ | ⏳ 暂不做（PR 闭环优先）|

## 安装

### 下载预编译包

到 [Releases 页](https://github.com/July-X/gitea-kanban/releases) 下载对应平台：

| 平台 | 文件 | 大小 |
|---|---|---|
| macOS (Intel) | `gitea-kanban-v0.x.x-macos-amd64.zip` | ~21 MB |
| Windows (x64) | `gitea-kanban-v0.x.x-windows-amd64.exe` | ~22 MB |

每个二进制旁边都有同名 `.sig`（ed25519 detached signature）+ `latest.json`（更新检查 manifest）。

### 从源码编译

```bash
git clone https://github.com/July-X/gitea-kanban.git
cd gitea-kanban
```

**前置依赖**：

- Go 1.22+
- Node.js 20 LTS
- pnpm 10+
- Wails CLI v2.12+：`go install github.com/wailsapp/wails/v2/cmd/wails@v2.12.0`

#### macOS

```bash
brew install go node@20 pnpm
go install github.com/wailsapp/wails/v2/cmd/wails@v2.12.0
export PATH=$PATH:$(go env GOPATH)/bin
```

#### Windows

下载安装包：

- Go: <https://go.dev/dl/>
- Node.js 20 LTS: <https://nodejs.org/en/download>（选 `Windows Installer (.msi)` 64 位）

```powershell
npm install -g pnpm@10
go install github.com/wailsapp/wails/v2/cmd/wails@v2.12.0
```

#### Linux

> ⚠️ **v0.8.0 不发 Linux 包**（user 拍板）。从源码仍可在 Linux dev，但 Wails 在 Linux 上需 webkit2gtk-4.0：
>
> ```bash
> sudo apt install libgtk-3-dev libwebkit2gtk-4.0-dev
> ```

**构建前端**：

```bash
cd frontend && pnpm install && pnpm build && cd ..
```

**构建应用**：

```bash
wails build -clean \
  -ldflags "-X main.appVersion=$(git describe --tags) -X main.appChannel=stable"
```

产物在 `build/bin/`：

- macOS: `gitea-kanban.app/` → 解压 zip 出 `gitea-kanban.app/` 完整 bundle
- Windows: `gitea-kanban.exe` → 直接双击

## 开发

```bash
wails dev
```

启动后自动弹桌面窗口（HMR 热更新：改前端立即生效，改 Go 自动重编）。

```bash
wails doctor    # 环境检查
```

## 测试

```bash
# Go 单元测试（14 个包）
go test -count=1 ./app/...

# 前端单元测试（vitest）
cd frontend && pnpm test

# 类型检查
cd frontend && pnpm run typecheck    # 0 错

# 生产构建
cd frontend && pnpm run build

# CI 验证 release 链（触发 GitHub Actions）
git tag v0.8.0-rc1 && git push --tags
```

## 数据与日志路径

默认 `${HOME}/.gitea-kanban/`，可覆盖 `GITEA_KANBAN_DATA_DIR` 环境变量（容器 / 沙箱场景）。

```
${DATA_ROOT}/
├── state.json              # 业务态（账号 / 项目 / 看板 / 收藏）
├── workspace/
│   └── repos/
│       └── ${owner}__${repo}/  # Git Graph 仓库本地存储（go-git NoCheckout）
├── logs/
│   └── main/
│       └── main-YYYY-MM-DD.log  # slog 日志（按天切分）
└── dev-tokens/             # 仅 dev 模式：token fallback（0600 权限）
```

## 路线图

### v0.8.0（最新）—— 应用自动更新 ✅

- [x] 内置自动更新器（manifest + ed25519 签名 + 分平台安装）
- [x] 启动期异步检查更新（不阻塞 UI）
- [x] macOS 未签名 build 走"前往下载页"兜底（OpenDownloadPage）
- [x] Windows in-place 安装 + restart-helper.cmd 避开文件锁
- [x] GitHub Actions 自动打包（macos-14 + windows-latest × amd64）
- [x] Apache-2.0 LICENSE + NOTICE 归因文件
- [x] 修 master HEAD windows 6 个 platform-specific FAIL（run rc28 跑通）

### v0.7.0~v0.7.19 ✅

19 个版本迭代（详见 [docs/releases/](docs/releases/)）。代表特性：

- Gitea PR review_request 事件 / timeline 渲染对齐 Gitea web
- GitHub PR 属性编辑器（Labels / Assignees / Reviewers / Milestones 后端数据补全 + 前端 UI 放开）
- DisplayName 全链路（优先 fullName，回退 username）
- Frontend vitest（8 个 useUpdate 测试）
- 提交签名验证（9 种 GPG 状态）+ commit 计数 badge
- 性能优化（滚动按需 deepen / console 拦截器 / 大数据量上限）
- pnpm typecheck 60 → 0 错

### v0.6.0 ✅

- app.go 从 3563 行拆分为 9 个领域文件（主文件精简到 226 行）
- Gitea / GitHub PR 闭环（列表 / 详情 / 合并 / 评论 / Review / Diff / 行内评论）
- Gitea Milestone 全链路（列表 / 选择 / 展示 / 过滤）
- 提交签名验证 + commit 计数 badge
- 跨平台 CI（GitHub Actions build.yml）

### 不做（user 拍板，永久挂起）

参见 [`CLAUDE.md` 不决事项](CLAUDE.md)：

- ❌ 不做 OAuth2 / SSH key 鉴权（保留 PAT）
- ❌ 不做 in-app 冲突解决（推到本地 git CLI）
- ❌ 不做实时协作 / 多用户
- ❌ 不做 in-app 编辑器（review 用 IDE / 编辑器）
- ❌ 不做 Linux 客户端（v0.8.0 起 user 锁定只 Windows + macOS）

## 架构

```
┌────────────────────────────────────┐
│ Vue 3 Renderer (frontend/dist)     │  ← wails build 嵌入
│   Pinia · Vue Router · lucide     │
└────────────────────────────────────┘
        ↕ IPC (Wails 自动生成 bindings)
┌────────────────────────────────────┐
│ Go Backend                         │
│   app/ — 9 个领域文件              │
│   app/updater — v0.8.0 自动更新    │
│   app/platform — Gitea/GitHub 适配  │
│   app/git — go-git NoCheckout      │
│   app/store — JSON + 文件 KV       │
│   app/secret — go-keyring          │
└────────────────────────────────────┘
        ↕ HTTPS REST + Git Smart HTTP
┌────────────────────────────────────┐
│ Gitea / GitHub API                  │
└────────────────────────────────────┘
```

详细设计：

- 架构决策：[`docs/adr/0005-electron-to-go-wails-migration.md`](docs/adr/0005-electron-to-go-wails-migration.md)
- 给 AI / 人类协作者的入口规范：[`AGENTS.md`](AGENTS.md)
- 设计综述：[`docs/design/00-overview.md`](docs/design/00-overview.md)
- 前端设计：[`docs/design/03-frontend.md`](docs/design/03-frontend.md)
- 设计系统（颜色 / 字体 / 零术语翻译表）：[`design-system/gitea-kanban/OVERRIDE.md`](design-system/gitea-kanban/OVERRIDE.md)

## 贡献

1. Fork + Clone
2. 创建 feature branch：`git checkout -b feat/your-feature`
3. 提交：`commit message 中文，type 用 feat / fix / refactor / perf / chore / test / docs / style`
4. Push + 开 Pull Request 到 `master`

**重要原则**（详见 [`AGENTS.md`](AGENTS.md)）：

- 单一职责 commit，不攒大 commit
- 改 Wails binding 同步检查 `frontend/wailsjs/wailsjs/go/main/App.d.ts` 是否需要重新生成
- 改 UI 前看 [设计系统](design-system/gitea-kanban/OVERRIDE.md) 的零术语翻译表
- **鉴权铁律**：token 永远不离开 Go 进程内存和系统 keychain
- 改 platform adapter 同步检查 Gitea / GitHub 两端

## 反馈 / Issue

- [Issues](https://github.com/July-X/gitea-kanban/issues) — Bug / Feature request
- [Discussions](https://github.com/July-X/gitea-kanban/discussions) — 设计 / 用法讨论

提问题时附上：

- 操作系统 + 版本
- `go version` / `node -v` / `pnpm -v` / `wails --version` 输出
- `wails doctor` 输出
- 复现步骤（越具体越好）
- 应用日志：`${GITEA_KANBAN_DATA_DIR:-~/.gitea-kanban}/logs/main/main-*.log`

## License

[Apache License 2.0](LICENSE) — `Copyright 2026 gitea-kanban authors`

Third-party attributions in [NOTICE](NOTICE).

## Acknowledgments

设计参考（仅设计研究，未 vendored 任何代码）：

- [vscode-git-graph](https://github.com/mhutchie/vscode-git-graph) — Git Graph lane 布局算法 1:1 复刻对象
- [DeepSeek-Reasonix](https://github.com/esengine/DeepSeek-Reasonix) — v0.8.0 自动更新架构设计参考
- [Gitea Web UI](https://github.com/go-gitea/gitea) — timeline / review_request 渲染对齐对象
- [lucide](https://lucide.dev) — 图标库