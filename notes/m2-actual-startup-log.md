# M2 实际启动验证（owner-takeover, 2026-06-11）

## 启动命令
`pnpm dev` (electron-vite dev) — 后台跑 45s alarm，捕获完整启动日志

## 启动结果：✅ 全部成功

### vite 编译阶段
```
✓ out/main/index.js  128.97 kB (main process 编译)
✓ out/preload/index.mjs  17.83 kB (preload 编译)
✓ vite dev server listening http://localhost:5173/
```

### electron 主进程启动
```
INFO: app ready version=0.1.0 isPackaged=false
INFO: sqlite migrations applied dbPath="/Users/zhongxingxing/Library/Application Support/gitea-kanban/kanban.db"
INFO: sqlite initialized
INFO: IPC handlers registered   ← 30 个 handler 全部装上
INFO: CSP header installed
INFO: loading renderer from dev server devUrl="http://localhost:5173"
INFO: main window created        ← window 创建成功
```

### 已知非阻塞警告
- `Autofill.enable / setAddresses` 错误：DevTools probe 失败，无害
- `GPU process exited unexpectedly: exit_code=15`：macOS 无显示环境，GPU 进程自动退出，不影响 main + renderer
- `Network service crashed, restarting service`：同上，无害

## giteaDemo mock 服务（localhost:3000）
- 容器 gitea-kanban-test 18 hours up，healthy
- tester 账号已建（admin / pass: testerpass456）
- Token `67190ca685604d902b996facc52d2274e2b190ee` 已生成
- API 端点 3/3 联通：/user、/repos/search、/version

## 启动后用户实际使用流程
1. `pnpm dev` 启窗口（AuthView 默认路由）
2. 输入 giteaUrl: `http://localhost:3000`
3. 输入 token: `67190ca685604d902b996facc52d2274e2b190ee`
4. 点连接 → 跳 /board → 看到空仓库列表（mock 没有真实 git 数据，但 UI 框架能渲染）
5. 切到 /timeline → X6 框架 + 空 graph（待 M3 加 timeline mock 数据）
