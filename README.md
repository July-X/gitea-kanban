# gitea-kanban

> 一个基于 Gitea / GitHub 的桌面端 Git Graph + 看板工具。
> 给开发者、PM、设计师、市场、运营一起用 —— 一边看代码改动，一边排任务、看流程。

## 这是什么

gitea-kanban 是一个桌面应用（不是网页、不是命令行），装在你的电脑上。
它把你团队在 **Gitea** 或 **GitHub** 上的工作 —— 议题、分支、提交、合并请求 —— 整理成两种好读的形式：

- **Git Graph（核心）**：把一个仓库里所有分支上的 commit 按时间画成一条条线，方便看谁在改什么、分支怎么合并。
- **看板**：像便利贴墙一样，每张卡片是一个议题，可以在列之间拖来拖去（Gitea 完整支持，GitHub 首期隐藏）。

桌面应用的好处：断网也能看缓存、令牌只存在你自己电脑的钥匙串里、不用每次开浏览器登录。
它说"人话"——按钮、提示、错误信息都避免技术词，危险操作都会二次确认。

设计文档见 [`docs/design/00-overview.md`](docs/design/00-overview.md)；v2.0 重大架构变更（Electron→Go+Wails）见 [`docs/adr/0005-electron-to-go-wails-migration.md`](docs/adr/0005-electron-to-go-wails-migration.md)。

## 平台与版本

- **支持平台**：Gitea（完整）+ GitHub（首期仅 Git Graph）
- **客户端技术**：Go 1.22+ + Wails v2（用系统 WebView，**非** Chromium 内嵌）
- **git 客户端**：go-git v5（纯 Go，**不依赖**用户环境的 git 二进制）
- **数据存储**：本地 JSON 文件 + 文件 KV，**零 SQLite 依赖**

## 安装

### 前置依赖

- **Go 1.22 或更高版本**（[下载](https://go.dev/dl/)）
- **Node.js 20 LTS** + **pnpm 10**（前端构建用）
- **Wails CLI v2.12+**（`go install github.com/wailsapp/wails/v2/cmd/wails@v2.12.0`）

#### macOS

```bash
brew install go node@20 pnpm
go install github.com/wailsapp/wails/v2/cmd/wails@v2.12.0
export PATH=$PATH:$(go env GOPATH)/bin
```

如果已经装了别的 Node 版本，用 [nvm](https://github.com/nvm-sh/nvm) 切到 20：

```bash
nvm install 20
nvm use 20
npm install -g pnpm@10
```

#### Windows

下载安装包：
- Go: <https://go.dev/dl/>
- Node.js 20 LTS: <https://nodejs.org/en/download>（选 `Windows Installer (.msi)` 的 64 位）

```powershell
npm install -g pnpm@10
go install github.com/wailsapp/wails/v2/cmd/wails@v2.12.0
```

#### Linux

```bash
# Ubuntu / Debian（其他发行版类似）
sudo apt install golang-go

# Node 20 + pnpm
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
npm install -g pnpm@10

# Wails v2 还需要 webkit2gtk（仅 Linux build 时需要，dev 模式可跳过）
sudo apt install libgtk-3-dev libwebkit2gtk-4.0-dev
go install github.com/wailsapp/wails/v2/cmd/wails@v2.12.0
```

### 拉源码

```bash
git clone <你的仓库地址>
cd gitea-kanban
```

### 安装前端依赖

```bash
cd frontend
pnpm install
cd ..
```

> **注意**：v2 不再需要 `pnpm install` 安装根目录依赖（v1 的 `package.json` 已归档到 `legacy/electron/`）。前端依赖是**唯一**的 pnpm 步骤。

### 验证环境

```bash
wails doctor
```

会检查 Go / Node / pnpm / 系统依赖是否齐全。

## 启动开发版

```bash
wails dev
```

跑完会自动弹出一个桌面窗口。改前端代码窗口会自动热更新（HMR），改 Go 代码会触发增量编译。

> **退出**：在窗口里按 `Cmd + Q`（macOS）或关窗口（Windows / Linux）。

### 首次启动看到什么

1. **AuthView 引导页**（未连接任何平台时）
2. 选平台 tab：**Gitea（自托管）** 或 **GitHub**
3. 填 host + token，提交
4. 进入 Git Graph 主视图

> 看不到任何 view？先用 `wails dev` 启动起来再看。

## 接入 Gitea（完整功能）

### 1. 准备 Gitea 服务地址

- 你的 Gitea 实例 URL，例如 `https://gitea.example.com`（自托管）
- 本地测试用任何一个本地 Gitea 实例即可（Docker / 自托管都行）

### 2. 生成个人访问令牌

- 在 Gitea 网页上「设置 → 应用 → 生成令牌」
- 勾选跟仓库读写、议题读写相关的权限（read:user / read:repo / write:issue 等）
- 复制令牌字符串（**只显示一次**）

### 3. 在应用里填

- AuthView 选 **Gitea（自托管）** tab
- 填 Gitea 地址 + 令牌
- 提交

填完之后，**令牌会被存进你电脑系统的钥匙串**（macOS Keychain / Windows Credential Vault / Linux Secret Service），不会写进任何文件。

## 接入 GitHub（首期仅 Git Graph）

### 1. 生成 Personal Access Token

- GitHub → Settings → Developer settings → Personal access tokens → **Tokens (classic)**
- 勾选 `repo` scope（读仓库即可；写权限 GitHub 暂未用）
- 复制令牌

### 2. 在应用里填

- AuthView 选 **GitHub** tab
- host 固定 `https://github.com`（不用填）
- 填 GitHub username + token（username 仅用于 keychain 标识，clone 鉴权不依赖它）
- 提交

### 3. GitHub 首期能用 / 不能用

| 功能 | GitHub | Gitea |
|---|---|---|
| 仓库列表 | ❌ | ✅ |
| 仓库 clone 到本地 | ✅ | ✅ |
| **Git Graph**（commit DAG 渲染） | ✅ | ✅ |
| 议题 / PR / 标签 / 成员 | ❌（首期） | ✅ |

GitHub 的 issue/PR 操作按钮在 UI 上会**自动隐藏**，避免用户点了发现后端返 `ErrNotSupported`。

## 试 Git Graph（核心功能）

1. 选好平台并连上后，**首次访问 Git Graph** 视图会弹"选择仓库"对话框
2. 选一个仓库（owner / name）
3. 应用自动 clone 仓库到本地 workspace（默认 `~/.gitea-kanban/workspace/repos/${owner}__${repo}/`）
4. 等 clone 完（进度条会显示），Git Graph 渲染 commit DAG
5. 可以点"刷新"按钮重新 fetch 远端新 commit

**workspace 路径**可在设置里改（持久化到 `state.json` 的 `prefs['app.workspacePath']`）。

## 打包发布版

```bash
# 当前平台（macOS → .app / Windows → .exe / Linux → AppImage）
wails build

# 跨架构
wails build -platform darwin/universal    # macOS x86_64 + arm64

# 干净重建
wails build -clean
```

产物：
- **macOS**：`build/bin/gitea-kanban.app`（17MB，含 universal binary）
- **Windows**：`build/bin/gitea-kanban.exe`（必须在 Windows 机器上跑）
- **Linux**：`build/bin/gitea-kanban.AppImage`（必须在 Linux 机器上跑）

> 跨平台说明：macOS 上可编译 Linux `CGO_ENABLED=0` 的 Go 二进制，但 Wails 打包步骤（生成 .app/.exe/.AppImage）必须在对应平台执行。CI 通常用 `matrix: [macos-latest, windows-latest, ubuntu-latest]`。

## 数据与日志路径

所有应用数据统一在**数据根目录**下：

| 优先级 | 路径 |
|---|---|
| 1 | `$GITEA_KANBAN_DATA_DIR`（环境变量，必须绝对路径） |
| 2 | 兜底 `~/.gitea-kanban` |

数据根目录下的子目录：

```
${DATA_ROOT}/
├── state.json              # 业务态（账号/项目/看板/收藏等）
├── workspace/              # Git Graph 仓库本地存储
│   └── repos/
│       └── ${owner}__${repo}/
├── logs/
│   └── main/
│       └── main.log        # slog 日志（dev/preview 写文件，不是 stdout）
└── dev-tokens/             # dev 模式 token fallback（仅 dev 模式存在）
    └── <service>__<user>.json
```

### 沙箱容器内

如果你的环境是 AI agent 沙箱 / Docker / k8s（**默认 `~/.gitea-kanban` 写不进去**）：

```bash
export GITEA_KANBAN_DATA_DIR=/tmp/gitea-kanban-test
rm -rf "$GITEA_KANBAN_DATA_DIR"
GITEA_KANBAN_DATA_DIR="$GITEA_KANBAN_DATA_DIR" wails dev
```

## 跑测试

### Go 单元测试（推荐）

```bash
go test ./app/...            # 全部 9 个包
go test -v ./app/git/...     # 单包详细
go test -race ./app/...      # 竞态检测
go test -cover ./app/...     # 覆盖率
```

共 **50+ 测试用例**覆盖 9 个 Go 包：
- `app/config`（3 测试）：数据目录解析、slog 日志
- `app/git`（10 测试）：clone 路径/URL/sanitize、commit DAG、workspace、fetch/pull、per-repo 锁
- `app/git/graph`（5 测试）：线性/DAG 布局、空图、排序
- `app/platform`（2 测试）：Platform 常量
- `app/platform/gitea`（6 测试）：httptest mock Gitea API
- `app/platform/github`（5 测试）：Bearer 鉴权、NotSupported 场景
- `app/secret`（5 测试）：go-keyring + dev 文件 fallback
- `app/store`（4 测试）：业务态、Mutate+持久化、Platform 迁移
- `app/sync`（4 测试）：queue.jsonl 队列 + GC

### 前端构建

```bash
cd frontend
pnpm build        # vite build（typecheck 暂跳过，旧代码 strict 模式）
pnpm typecheck    # vue-tsc --noEmit（迁移期可能失败，v2.0.1 修复）
```

### E2E（v2 待规划）

v1 时代用 Playwright + Electron。v2 Wails 环境的 E2E 还在规划中（Playwright + Wails 集成），暂时靠 Go 单元测试 + 手动 GUI 验证。

## 常见问题

### 启动后白屏 / 看不到窗口

1. **检查 Go 版本**：`go version` 应该是 1.22+
2. **检查 Node 版本**：`node -v` 应该是 20.x
3. **检查 pnpm**：`pnpm -v` 应该是 10.x
4. **跑 `wails doctor`** 看环境检查
5. **看日志**：dev 模式 slog 走文件 transport，**不在 stdout**：
   ```bash
   tail -50 "${GITEA_KANBAN_DATA_DIR:-~/.gitea-kanban}/logs/main/main.log"
   ```

### 报"原生模块不匹配" / Go 编译失败

v2 改用纯 Go 实现，**没有** native binding 依赖（vs v1 的 `@napi-rs/keyring` Rust napi）。如果遇到编译问题：

1. `go clean -cache`
2. `go mod tidy`
3. 重新 `wails dev`

### Git Graph clone 失败

1. **token 无效** → 在 Gitea/GitHub 重新生成 token，回到 AuthView 重新连接
2. **网络问题** → 检查 `curl -I https://gitea.example.com` 或 `https://api.github.com`
3. **workspace 路径无写权限** → 设置里改到 `~/gitea-kanban-workspace` 或 `/tmp/...`
4. **看 slog 日志** 找具体错误码

### 令牌存不进去 / 钥匙串报错

- **macOS**：第一次存令牌时系统会弹"钥匙串访问想要访问 xxx"——点"始终允许"。
- **Windows**：检查「控制面板 → 凭据管理器 → Windows 凭据」里有没有 `gitea-kanban` 条目。
- **Linux**：需要 `gnome-keyring` 或 `kwallet` 在后台运行。
- **headless Linux / 容器**：钥匙串不可用——自动 fallback 到 `dev-tokens/*.json`（0600 权限），**仅 dev 模式**。生产环境必须用图形界面。

### 令牌失效 / 想要换账号

到应用内 AuthView 重新填一个新的令牌即可。新的令牌会覆盖旧的，不需要手动去钥匙串里删。

### Go 版本不对 / 报编译错误

```bash
go version   # 应该是 go1.22 或更高
go env GOOS GOARCH
```

如果用 asdf / gvm / 旧版 Go，确保工具链是 1.22+。

### "Wails CLI not found"

```bash
go install github.com/wailsapp/wails/v2/cmd/wails@v2.12.0
export PATH=$PATH:$(go env GOPATH)/bin
wails doctor
```

### 沙箱容器跑不起来

**症状**：wails dev 启动后没反应 / 进程消失 / state.json 报 EPERM。

**修法**（参见 [`AGENTS.md §8.5`](AGENTS.md)）：

```bash
export GITEA_KANBAN_DATA_DIR=/tmp/gitea-kanban-test
rm -rf "$GITEA_KANBAN_DATA_DIR"
GITEA_KANBAN_DATA_DIR="$GITEA_KANBAN_DATA_DIR" wails dev
```

## 反馈 / 贡献

- 设计文档入口：[`docs/design/00-overview.md`](docs/design/00-overview.md)（v2 部分已加横幅，仍含 v1 章节）
- 前端设计：[`docs/design/03-frontend.md`](docs/design/03-frontend.md)
- **v2.0 架构迁移决策**：[`docs/adr/0005-electron-to-go-wails-migration.md`](docs/adr/0005-electron-to-go-wails-migration.md)
- 旧架构（**DEPRECATED**）：[`docs/design/02-architecture.md`](docs/design/02-architecture.md)
- 旧 v1 源码归档（**仅参考**）：[`legacy/electron/`](legacy/electron/)
- 设计系统（颜色、字体、术语翻译表）：[`design-system/gitea-kanban/OVERRIDE.md`](design-system/gitea-kanban/OVERRIDE.md)
- **给所有 AI / 人类协作者的入口规范（v2.0）**：[`AGENTS.md`](AGENTS.md)
- Claude 工作摘要：[`CLAUDE.md`](CLAUDE.md)

提问题或建议时，建议附上：

- 你的操作系统 + 版本
- `go version` / `node -v` / `pnpm -v` 的输出
- `wails doctor` 输出
- 复现步骤（越具体越好）
- 截图或 slog 日志内容（`${GITEA_KANBAN_DATA_DIR}/logs/main/main.log`）

> 本仓库使用中文 commit message，每个交付物一个 commit。v2.0 单分支 `main`（v1 是 `master`，已迁回 `main`）。
