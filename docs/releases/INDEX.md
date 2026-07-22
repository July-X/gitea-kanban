# gitea-kanban 版本发布索引

> **本文件是项目所有版本演进信息的统一入口**。AGENTS.md / CLAUDE.md 不再维护版本历史，统一在此查阅。

## 阅读路径

- 当前最新 release note：[v0.8.0.md](./v0.8.0.md)（自动更新全链路）
- 设计 plan：[v0.8.0-plan.md](./v0.8.0-plan.md)
- 历史归档：本目录 v0.4.0 ~ v0.7.21 全部 30 个 release note
- 早期重大重构（v2.0 / v2.4 / v2.5）：见 `docs/adr/0005` / `0006` / `0007`

## v0.8.x 时间线（应用自动更新 + CI 累积 fix）

| 版本 | 真实证据 | 摘要 | release note |
|---|---|---|---|
| **v0.8.0** | tag `eaa9159` + `docs/releases/v0.8.0.md` | 应用自动更新全链路：manifest 拉取 → ed25519 签名校验 → 断点续传下载 → Windows in-place apply / macOS 手动下载页兜底；只发 Windows + macOS 双平台，**明文排除 Linux / canary** | [v0.8.0.md](./v0.8.0.md) |
| **v0.8.1** | merge commit `154482b` "feat/v0.8.0 → master — v0.8.1 发版基线" | v0.8.0 功能合入 master 的基线版本，同时包含 release.yml / cmd/sign / LICENSE / README / Windows 测试 skip 等累积 fix | — |
| **v0.8.2** | tag `c05acdd` + fix commits `cfdebd9` + `9ceeab8` | release.yml publish job 修复（delete release 后同步删 tag）；release.yml 退回 v0.8.0-rc32 已验证配置（macOS build 稳定性）；还原 lock.go 到 v0.8.0 设计（darwin 编译 fix） | — |
| **v0.8.3** / **v0.8.4** | tag `31cde4a` (两个版本同 tag) | Revert "release.yml 加 -nsis 生成 NSIS installer" —— Windows 产物从 NSIS installer 退回 portable .exe | — |
| **v0.8.5** / **v0.8.6** | tag `4340c43` (两个版本同 tag) + commits `2a753ff` | NSIS installer 重新引入 + release.yml trigger 修复（`on:push:tags` 和 `branches/branches-ignore` 互斥导致 jobs 为空 → 删 branches-ignore） | — |
| **v0.8.7** | commit `1d5f215` | release.yml line 314 注释缩进修复：之前 0 spaces 被 YAML parser 当 top-level 解析，后续 step 缩进错位导致 block mapping parse error | — |
| **v0.8.8** | commit `0e73d0c` | Windows 发布链统一为 NSIS installer + README 补充 macOS/Windows 安装说明（release.yml + README.md + app/updater/manifest.go + app/updater/updater.go + scripts/release.sh） | [待补] |
| **v0.8.9** | commit `5a4a7ea` | 升级 Wails CLI v2.10.1→v2.12.0 + Windows build 拆独立 step + NSIS 诊断（release.yml + build.yml） | [待补] |
| **v0.8.10** | commit `406ce7a` | Windows build 显式安装 NSIS（`choco install nsis`），不再依赖 GitHub Actions runner 预装 NSIS | [待补] |
| **v0.8.11** | commit `5f098a5` | 修复 Windows installer 发布断链 + 升级 GitHub Actions 到 Node 24（release.yml + scripts/release.sh） | [待补] |
| **v0.8.12** | commit `ac451dd` | 全项目升级到 Go 1.26（build.yml + release.yml + AGENTS.md + CLAUDE.md + README.md） | [待补] |
| **v0.8.14** | commit `9f62253` | Windows git 子进程隐藏 console 窗口（Windows 安装包模式下不再闪黑框）：runner_windows.go + runner_other.go + sync_test.go | [待补] |
| **v0.8.15** | commit `ef1db7b` | Windows 快捷方式白色底框修复：快捷方式指定自定义图标 | [待补] |
| **v0.8.16** | commit `e7ed7b1` | Windows NSIS installer 启动失败修复：installDir 含空格导致 /D= 参数截断 | [待补] |
| **v0.8.17** | commit `dea6ed8` | PR 详情 timeline 评审事件对齐 + 引用事件统一 octicon-bookmark | [待补] |
| **v0.8.18** | commit `4f2a80c` | 设置页 Git 二进制 radio 单选 + gh 信息修复 + 移除 gh 独立卡片 | [v0.8.18.md](./v0.8.18.md) |
| **v0.8.19** | tag `06b7196` | PR 对话区 timeline icon 留白 + 头像渲染 + 暗色滚动条 + manualOnly 修复 | [v0.8.19.md](./v0.8.19.md) |
| **v0.8.20** | commit `3f02752` | 修复 darwin-amd64 用户下载更新 / manualOnly 误报（macos- → darwin- 归一化） | [v0.8.20.md](./v0.8.20.md) |
| **v0.8.21** | commit `79fad0e` | 安装版（macOS dmg）暗色滚动条白底修复（全局 color-scheme + 重复声明清理） | [v0.8.21.md](./v0.8.21.md) |
| **v0.8.22** | commit `待 push 后回填` | macOS 自动下载 dmg + 打开 Finder 引导安装（canSelfUpdate + applyMacOS 改造） | [v0.8.22.md](./v0.8.22.md) |

> ⚠️ **v0.8.13**：无 tag 记录，git 历史中无对应 commit。

## 历史版本（v0.4.0 ~ v0.7.21）索引

| 版本 | 主题 | release note |
|---|---|---|
| **v0.7.21** | macOS .app 启动期 gh 探测：PATH 补全 + `ResolveGhPath()` | [v0.7.21.md](./v0.7.21.md) |
| **v0.7.20** | Mac 安装版 gh CLI 未安装错误码（`gh_not_installed`）+ 安装引导 toast | [v0.7.20.md](./v0.7.20.md) |
| **v0.7.19** | label 方向判断改用 body 字段 + push event 渲染对齐 Gitea web | [v0.7.19.md](./v0.7.19.md) |
| **v0.7.18** | TimelineItem DTO 字段名 camelCase + merge 事件真正搬主行 | [v0.7.18.md](./v0.7.18.md) |
| **v0.7.17** | pr-detail__event-content 内部尽量 1 行显示完 | [v0.7.17.md](./v0.7.17.md) |
| **v0.7.16** | merge 事件整段 `white-space: nowrap` 强制 1 行渲染 | [v0.7.16.md](./v0.7.16.md) |
| **v0.7.15** | merge 事件对齐 Gitea web "合并提交 X 到 Y"（去"了"字） | [v0.7.15.md](./v0.7.15.md) |
| **v0.7.14** | label 事件 chip 移到主行 | [v0.7.14.md](./v0.7.14.md) |
| **v0.7.13** | assignees verb 文案对齐 Gitea web（"指派给自己"） | [v0.7.13.md](./v0.7.13.md) |
| **v0.7.12** | assignees / delete_branch 渲染对齐 Gitea web（去 inline 块） | [v0.7.12.md](./v0.7.12.md) |
| **v0.7.11** | 指派自指派判断 + delete_branch verb 对齐 | [v0.7.11.md](./v0.7.11.md) |
| **v0.7.10** | PR 对话区 UI 微调（去 conv-header / 字号放大） | [v0.7.10.md](./v0.7.10.md) |
| **v0.7.9** | PR header 显示真实分支名（label 字段） | [v0.7.9.md](./v0.7.9.md) |
| **v0.7.8** | push/merge 事件详情 根因修复（GitHub 端 commitIds 解析） | [v0.7.8.md](./v0.7.8.md) |
| **v0.7.7** | push 事件 commit 列表 + merge 事件 commit 链接 | [v0.7.7.md](./v0.7.7.md) |
| **v0.7.6** | 4 个 user 反馈问题修复 + label 全背景色 | [v0.7.6.md](./v0.7.6.md) |
| **v0.7.5** | 系统事件 UX 文案 + 时间格式对齐 Gitea web | [v0.7.5.md](./v0.7.5.md) |
| **v0.7.4** | Timeline 细节补全（DisplayName / 评论于 / 表情按钮 / ...菜单） | [v0.7.4.md](./v0.7.4.md) |
| **v0.7.3** | Timeline 视觉对齐 Gitea web（紧凑单行 + 左侧贯穿竖线） | [v0.7.3.md](./v0.7.3.md) |
| **v0.7.2** | 视觉 1:1 对齐 Gitea web（5 档颜色 + lucide icon + 7 类系统事件详情） | [v0.7.2.md](./v0.7.2.md) |
| **v0.7.1** | v0.7.0 收尾：PR 对话区对齐 Gitea web + Timeline 数据源切换 + typecheck 全清 | [v0.7.1.md](./v0.7.1.md) |
| **v0.7.0** | GitHub PR 属性编辑器数据补全（5 方法 + 跨平台 build CI） | [v0.7.0.md](./v0.7.0.md) |
| **v0.6.0** | app.go 9 文件拆分 + MergesView 三 Tab + PR 属性编辑器 + 提交签名验证 + GitHub PR 闭环 | （v0.6.0-plan 已在 docs/） |
| **v0.5.3 / v0.5.0** | PR 评论模块 M1-M4（PullFileComments.vue + 三 Tab + 对话流） | [v0.5.0.md](./v0.5.0.md) |
| **v0.4.0** | Git Graph UI 收敛 + StatusBar 顺序 + git 二进制内嵌（macos + windows） | [v0.4.0.md](./v0.4.0.md) |

## v0.3.x 及更早（Git Graph 重构 + v2 时代）

- **v3.0–v3.14**（2026-06-26~30）：Git Graph 严格 1:1 复刻 vscode-git-graph，丢弃 v2.x 历史包袱（关键 commit `71a43f3`）
- **v2.6**（2026-06-25）：StatusBar 仓库行同步进度条（go-git sideband → EventsEmit → 前端 UI）
- **v2.5**（2026-06-22）：workspace 按账号分层（旧布局自动迁移到 `_pre_v25_workspace`）
- **v2.4**（2026-06-22）：迁移完成后真实用户桌面跑暴露 6 类问题修复
- **v2.0**（2026-06-22）：Electron+TypeScript+Vue → Go+Wails+Vue 3；单平台 Gitea → 多平台 Gitea+GitHub

> 早期版本详细说明见 [docs/design/07-v24-iteration.md](./design/07-v24-iteration.md) + ADR-0005 / 0006 / 0007。

## 历史文档警示（已 deprecated 的早期文档）

- `docs/adr/0001-keychain.md` — SUPERSEDED by ADR-0005
- `docs/adr/0003-local-store-electron-store.md` — SUPERSEDED by ADR-0005
- `docs/design/02-architecture.md` — DEPRECATED（基于 Electron IPC，v2 改为 Wails bindings）
- `docs/design/03-frontend.md` — DEPRECATED
- `docs/design/00-overview.md` / `01-research.md` / `04-review-report.md` / `05-repair-decisions.md` / `checklist.md` — v1 设计阶段历史档案
- `docs/onboarding/pm-first-run.md` / `docs/review/*.md` — v1 时代 review 文档
- `CHANGELOG.md` — 严重过期，停留在 v1.3.1（重写待办）
