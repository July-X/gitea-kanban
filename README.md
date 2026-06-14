# gitea-kanban

> 一个基于 Gitea 的桌面端看板 + 时间轴工具。
> 给开发者、PM、设计师、市场、运营一起用 —— 一边看代码改动，一边排任务、看流程。

## 这是什么

gitea-kanban 是一个桌面应用（不是网页、不是命令行），装在你的电脑上。
它把你团队在 Gitea 上的工作——议题、分支、提交、合并请求——整理成两种好读的形式：

- **看板**：像便利贴墙一样，每张卡片是一个议题，可以在列之间拖来拖去。
- **时间轴**：把一个仓库里所有分支上的提交，按时间画成一条条线，方便看谁在改什么。

桌面应用的好处：断网也能看缓存、令牌只存在你自己电脑的钥匙串里、不用每次开浏览器登录。
它说"人话"——按钮、提示、错误信息都避免技术词，危险操作都会二次确认。

设计文档见 [`docs/design/00-overview.md`](docs/design/00-overview.md)，里面有更详细的背景和决策记录。

## 安装

### 前置依赖

- **Node.js 20 LTS**（不要装 18 或 21，会跑不起来）
- **pnpm 10**（包管理工具，不是 npm、不是 yarn）

#### macOS

用 Homebrew：

```bash
brew install node@20 pnpm
```

如果已经装了别的 Node，可以用 [nvm](https://github.com/nvm-sh/nvm) 切到 20：

```bash
nvm install 20
nvm use 20
npm install -g pnpm@10
```

#### Windows

下载 Node.js 20 LTS 安装包：<https://nodejs.org/en/download>（选 `Windows Installer (.msi)` 的 64 位）。
装完之后用 PowerShell：

```powershell
npm install -g pnpm@10
```

#### Linux

用你发行版的包管理器（以 Ubuntu / Debian 为例）：

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
npm install -g pnpm@10
```

其他发行版（Fedora / Arch）类似，把 `apt` 换成 `dnf` 或 `pacman`，安装源换成对应仓库。

### 拉源码

```bash
git clone <你的仓库地址>
cd gitea-kanban
```

### 安装依赖 + 编译原生模块

```bash
pnpm install
pnpm rebuild:native
```

`pnpm rebuild:native` 会重新下载 SQLite 的本地模块，让它匹配 Electron 的版本。如果跳过这一步，启动时可能会白屏或报错 "native module ABI 不匹配"。

> `pnpm install` 在装包时会自动跑 `pnpm rebuild:native`（`postinstall` 钩子），一般不用手动再跑。手动跑是为了"装完后我又改了点东西"或"重装"的场景。

## 启动开发版

```bash
pnpm dev
```

跑完会自动弹出一个桌面窗口。改源码后窗口会自动热更新，不用手动重启。

> 退出：在窗口里按 `Cmd + Q`（macOS）或关窗口（Windows / Linux）。

## 首次接入 Gitea

应用启动后，**第一次**会引导你填两项：

1. **Gitea 服务地址**——你的 Gitea 实例的网址，例如 `https://gitea.example.com`。
   - 如果只是本地测试用，[`giteaDemo/README.md`](giteaDemo/README.md) 里有一个用 Docker 启动的本地实例。
2. **个人访问令牌**——在 Gitea 网页上「设置 → 应用 → 生成令牌」，勾上跟仓库读写、议题读写相关的权限。
   - 申请令牌的具体步骤会因 Gitea 版本略有不同，按网页提示走即可。

填完之后，**令牌会被存进你电脑系统的钥匙串**，不会写进任何文件：

- macOS：钥匙串访问
- Windows：凭据管理器
- Linux：Secret Service（GNOME Keyring / KWallet 等）

之后每次启动应用都不用再填。如果以后想换 Gitea 实例或换令牌，到设置页里改。

> 看不到设置页？先用 `pnpm dev` 启动起来再看。

## 打包发布版

```bash
pnpm build
```

跑完会生成可以直接运行的本地构建产物（落在 `out/` 目录下）。打包成最终分发包（macOS dmg / Windows exe / Linux AppImage）的配置在 [`electron-builder.yml`](electron-builder.yml) 里——最终产物会落在 `release/<版本号>/` 目录下，按平台和架构命名（参考 `electron-builder.yml` 的 `artifactName`）。

> 当前仓库的 `pnpm build` 只产出可运行的本地构建，**没有**把"打包成 dmg / exe / AppImage"包装成一个一键命令。要走完整的分发包流程，直接调 `electron-builder` 即可，后续会补一个一键脚本。

## 跑端到端测试

开发者参考用——日常使用不需要跑这个。

```bash
pnpm e2e:all
```

这条命令会自动切换原生模块的版本（开发用 Electron 版本 ↔ 测试用 Node 版本），串跑 4 个端到端测试套件，结束后自动切回。

> **前提**：需要先在本地跑起一个 Gitea 测试实例（参考 [`giteaDemo/README.md`](giteaDemo/README.md)），并把令牌设到环境变量 `KB_TOKEN`。

## 常见问题

### 启动后白屏 / 报"原生模块不匹配"

大多是 SQLite 的本地模块没编译成 Electron 用的版本。手动跑：

```bash
pnpm rebuild:native
```

然后重新 `pnpm dev`。

### 端到端测试跑不起来

也是同类问题——测试在 Node 上跑，开发在 Electron 上跑，原生模块版本不一样。`pnpm e2e:all` 内部会自动切换，如果中途失败、手动跑过其他命令导致状态乱了，重新跑：

```bash
pnpm rebuild:native
pnpm e2e:all
```

### 令牌存不进去 / 钥匙串报错

- **macOS**：第一次存令牌时系统会弹"钥匙串访问想要访问 xxx"——点"始终允许"。
- **Windows**：检查「控制面板 → 凭据管理器 → Windows 凭据」里有没有 `gitea-kanban` 条目。
- **Linux**：需要 `gnome-keyring` 或 `kwallet` 在后台运行。如果用 headless 环境（比如服务器、容器），钥匙串不可用——这种情况下请用图形界面的桌面 Linux。

### 令牌失效 / 想要换账号

到应用内「设置 → 接入 Gitea」里重新填一个新的令牌就行。新的令牌会覆盖旧的，不需要手动去钥匙串里删。

### 命令不存在 / 报错"command not found"

确认你已经全局安装了 `pnpm`（`pnpm -v` 应该输出 `10.x`）。如果用 `npm` 跑的，请改用 `pnpm`。

### "Node 版本不对"

仓库根有 `.nvmrc` 文件，写的是 `20`。如果你用 nvm，进入目录后 `nvm use` 会自动切到 20。

## 反馈 / 贡献

- 设计文档入口：[`docs/design/00-overview.md`](docs/design/00-overview.md)
- 前端设计：[`docs/design/03-frontend.md`](docs/design/03-frontend.md)
- 架构与决策记录：[`docs/design/02-architecture.md`](docs/design/02-architecture.md)、[`docs/design/adr/`](docs/design/adr/)
- 设计系统（颜色、字体、术语翻译表）：[`design-system/gitea-kanban/OVERRIDE.md`](design-system/gitea-kanban/OVERRIDE.md)
- 给所有 AI / 人类协作者的入口规范：[`AGENTS.md`](AGENTS.md)

提问题或建议时，建议附上：

- 你的操作系统 + 版本
- `pnpm -v` 和 `node -v` 的输出
- 复现步骤（越具体越好）
- 截图或报错文本

> 本仓库使用中文 commit message，每个交付物一个 commit，由维护者统一打 commit —— 贡献者不需要自己 commit。
