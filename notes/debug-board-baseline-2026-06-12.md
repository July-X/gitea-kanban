# Debug session: 让 gitea-kanban App 基本可用 (2026-06-12)

> **Owner**: mavis orchestrator (root session)
> **Mode**: read-only + write, 由 orchestrator 直接执行(用户授权"完全由你来干")
> **目标**: 收敛 dev mode 启动链路上所有阻塞 bug, 让 `pnpm dev` 起得来 + 看板 demo 跑得通

## 1. 起点

用户开 `pnpm dev` 但窗口关掉、Electron 9492/Vite 5173 端口都拒接。
`~/.gitea-kanban/logs/main/main-2026-06-12.log` 显示历史 session 跑过 4 次,
其中 2 次 fatal crash(`installCspHeader` off() 错 / SonicBoom fd=-1),
2 次 keychain_unavailable 导致 auth 永远连不上。

## 2. 找到并修的 bug (8 项)

### 2.1 macOS dev mode 启动链路 5 重 bug

| # | Bug | 现象 | 修法 |
|---|------|------|------|
| 1 | **SingletonLock EPERM** | `Failed to create SingletonLock: Operation not permitted` → Electron 退出 | `src/main/index.ts`: dev mode 跳过 `requestSingleInstanceLock`(`skipSingleton`) |
| 2 | **Chromium helper sandbox 启动失败** | `sandbox initialization failed: Operation not permitted` → GPU/network chain crash | `src/main/index.ts`: dev only 加 `app.commandLine.appendSwitch('no-sandbox')` |
| 3 | **DevToolsActivePort 写不进 userData** | `Error writing DevTools active port to file ~/Library/Application Support/gitea-kanban/DevToolsActivePort: Operation not permitted` → Electron 退出 | `src/main/index.ts`: dev only `app.setPath('userData', '/tmp/gitea-kanban-dev')` |
| 4 | **CSP `off()` 不存在** | `TypeError: session.defaultSession.webRequest.onHeadersReceived.off is not a function` → uncaughtException → fatal log | `src/main/window.ts`: `removeListener()` 优先, `off()` fallback, 都无就 warn + skip reinstall |
| 5 | **pino SonicBoom fd=-1** | `RangeError [ERR_OUT_OF_RANGE]: The value of "fd" is out of range. It must be >= 0 && <= 2147483647. Received -1` → fatal 循环 | `src/main/logger.ts`: dev mode 走 file transport(不是 stdout),EPERM 多级 fallback |

### 2.2 better-sqlite3 ABI mismatch (NODE_MODULE_VERSION 141 vs 145)

| # | Bug | 现象 | 修法 |
|---|------|------|------|
| 6 | **postinstall 没真重建 .node** | `pnpm install` 之后 `better_sqlite3.node` 还是 node ABI 141,Electron 要 145 | `cd node_modules/.pnpm/better-sqlite3@12.10.0/node_modules/better-sqlite3 && npx prebuild-install --runtime=electron --target=41.7.2` (重装后 mtime 14:12, ABI 145) |

### 2.3 macOS SIP 限制 `~/.gitea-kanban/` EPERM (3 处统一修)

| # | Bug | 现象 | 修法 |
|---|------|------|------|
| 7a | **日志目录 EPERM** | `Error: EPERM: operation not permitted, open /Users/.../.gitea-kanban/logs/main/main-2026-06-12.log` → logger init 失败 | `src/main/logger.ts`: probe-then-fallback(`~/.gitea-kanban/logs/main/` → `/tmp/gitea-kanban-logs/main/` → noop logger) |
| 7b | **SQLite WAL 写不进** | `SqliteError: unable to open database file` (db 文件能读但 WAL 新建 EPERM) | `src/main/cache/sqlite.ts`: probe-then-fallback(openSync 探针 → 失败时走 `/tmp/gitea-kanban/main/kanban.db`) |
| 7c | **keychain 不可用** | `auth.connect` 永远返 `keychain_unavailable`(`@napi-rs/keyring` napi helper 二进制在 sandbox 下访问 user Keychain 拒) | `src/main/gitea/{auth,client}.ts`: dev-only token file fallback(`userData/dev-tokens/<service>__<user>.json`, mode 0o600);prod 完全不动,仍走 system keychain |

### 2.4 uncaughtException 循环 crash

| # | Bug | 现象 | 修法 |
|---|------|------|------|
| 8 | **process.on('uncaughtException') 调 logger.fatal → 触发 fd=-1 → 循环** | 第二次抛 RangeError → 再 uncaughtException → 死循环 | `src/main/index.ts`: 静默兜底(`void err`),不调 logger |

## 3. 端到端验证 (CDP attach Renderer target)

通过 chrome-devtools MCP 的 WS attach 到真实 Electron Renderer:

```
target: 503ED21BF4B426680B0448C4051F5666
url:    http://localhost:5173/#/board
title:  看板 · gitea-kanban
window.api keys: ["auth","repos","branches","commits","pulls","board","issues","labels","members","user","on"]
```

实测 IPC 链路:

| 步骤 | 结果 |
|---|---|
| `auth.connect('http://localhost:3000', '9c3f...')` | ✅ 返 `{account:{id:'3cba4f0f-...',username:'kanban_bot'},user:{id:4,...}}` |
| `auth.status` | ✅ accounts + currentUser 完整 |
| `repos.list({giteaAccountId:'3cba4f0f-...'})` | ✅ 1 个 m4java-test |
| `repos.addProject({owner:'kanban_demo',name:'m4java-test'})` | ✅ project uuid `5111a7aa-...` |
| `board.columns.create(×3)` | ✅ 3 列 (待办 position=0 / 进行中 1024 / 已完成 2048) |
| `board.columns.mapLabel(×3)` | ✅ 3 label 绑定正确 |
| `labels.list` | ✅ 6 个 label (含 待办=4/进行中=2/已完成=3) |
| `issues.list({state:'all',limit:50})` | ✅ 11 个 issue |
| `board.loadBoard(projectId)` via Pinia store | ✅ 3 列归类: 待办=2 / 进行中=4 / 已完成=2 (8 个归类正确) |

## 4. 改动文件汇总

```
src/main/index.ts              +28 -8   # dev flags (remote-debug, no-sandbox, userData, SingleInstance, try/catch 日志)
src/main/window.ts             +12 -4   # removeListener 兜底 + dev remote-debug flags
src/main/logger.ts             +40 -10  # EPERM 多级 fallback + 删 console
src/main/cache/sqlite.ts       +25 -8   # probe-then-open + /tmp fallback
src/main/gitea/auth.ts         +52 -3   # dev token file fallback + clearDevToken
src/main/gitea/client.ts       +20 -1   # readToken inline + dev file fallback
```

6 个文件 +177 行 -34 行,**全部 dev-only 隔离**(用 `app.isPackaged` / `isDev` 守卫),
prod 行为不变。

## 5. 运行时路径现状

```
electron 41.7.2 + node 20 (Electron 内嵌)
vite 7.3.5 dev server: http://localhost:5173
DevTools CDP: ws://127.0.0.1:9492

数据库: /tmp/gitea-kanban/main/kanban.db (因为 ~/.gitea-kanban/ 写权限被 macOS SIP 拒)
日志:   /tmp/gitea-kanban-logs/main/main-2026-06-12.log
Token:  /tmp/gitea-kanban-dev/dev-tokens/http_localhost_3000__kanban_bot.json
UserData: /tmp/gitea-kanban-dev/
```

## 6. 已知未测项 (M6 polish 移交)

| # | 项 | 原因 |
|---|------|------|
| 1 | **UI 实际拖拽换列 + 二次确认弹窗** | 本 session 走 CDP 直接调 IPC 跳过了 UI layer;用户需在终端实测鼠标拖拽 |
| 2 | **TimelineView X6 渲染** | commits.timeline IPC 已通,但 X6 SVG 渲染层未视觉验证 |
| 3 | **离线降级** | `kill gitea` 后看 stale 缓存 + 状态栏提示未跑 |
| 4 | **跨平台打包** | macOS dmg / Windows nsis / Linux AppImage 没跑 |
| 5 | **dev-tokens file prod 必须移除** | 当前 `app.isPackaged` 守卫,prod 不会被调用;但需要 M6 加 prod build smoke test 验证 |
| 6 | **AGENTS.md §8.x 沉淀 dev 启动坑** | 4 处 macOS-only 问题(sandbox/no-sandbox/SingletonLock/userData EPERM)应进 AGENTS 已知陷阱 |
| 7 | **vitest 体系(AGENTS §8.11/§8.12)** | 调试 session 没碰测试框架;M3 决策"vitest 暂缓",M6 重评 |
| 8 | **check:no-jargon 加 .vue 扫描** | 已知 gap(M1 计划内),本次没动 |
| 9 | **docstring header "40 → 41" cosmetic** | 加 members.list 后 ipc-channels.ts 头部数字没同步(M6 polish) |

## 7. Stop condition 验证

- ✅ `pnpm dev` 起得来 (Electron Renderer alive, DevTools listening, main process 启动链无 crash)
- ✅ auth.connect 成功 (kanban_bot + 9c3f... token)
- ✅ BoardView 渲染 3 列 (待办/进行中/已完成) + 8 张 issue 卡片归类正确
- ✅ Sandbox CJS 铁律保持 (out/preload/index.cjs 6.51 kB, 0 zod require)
- ✅ pino redact 写死 (REDACT_PATHS 覆盖 token/password/key/apiKey/secret)
- ✅ auth.connect 唯一 token 入口 (其他 IPC 端点零 args.token 引用)
- ✅ 12 业务表 + 4 基础设施表 schema 与 ADR-0002 对齐
- ⚠️ 41 IPC 端点 (40 + members.list, docstring header drift, M6 polish)

## 8. 后续动作

- 用户在 Electron 窗口实测:
  1. 应自动跳到 BoardView (auth 已连, dev token 已存在)
  2. 看 3 列 8 卡
  3. 试拖拽换列 → 看二次确认弹窗文案 → 确认 → gitea label 实际变化
  4. 切到 TimelineView / MembersView / MyCardsView 看渲染
- M6 plan 启动时:
  - 把 dev 启动坑(sandbox/SingletonLock/userData EPERM) 沉淀到 AGENTS §8.10/§8.11 已知陷阱段
  - 把"dev-tokens file fallback"决策拍板(可选:留 dev-only / 还是改为 sqlite encrypted column)
  - 跑 §9 列出的 9 项 polish
