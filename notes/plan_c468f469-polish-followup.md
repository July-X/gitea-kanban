# plan_c468f469 M3 polish followup

> M3 阶段 owner-takeover 收口后留给用户拍板的 polish 项。所有静态层（type-check / build / no-jargon / 跨边界契约 / 鉴权铁律 / sandbox CJS）全绿，但**应用实际可启动性 + UI 视觉 + 离线降级实测** 没在 owner-takeover 范围（owner 无 display 跑不了 Electron 窗口）。

## 已 PASS 项（owner 实测 2026-06-11 17:00）

- [x] `pnpm type-check` 0 error
- [x] `pnpm build` OK · main 137 kB · preload 5.50 kB · renderer 正常
- [x] `pnpm check:no-jargon` 0 命中
- [x] sandbox CJS 铁律（§8.10）：`out/preload/index.cjs` 存在 · `index.mjs` 不存在 · 0 zod require
- [x] pino redact 写死（§8.2）
- [x] auth.connect 唯一接收 token（§8.2）
- [x] gitea-js ^1.23.0 替换 openapi-fetch
- [x] 旧 `board.cards.*` 端点 reset 干净（0 端点命中）
- [x] 32 IPC 端点 namespace 完整：auth×3 + repos×3 + branches×5 + commits×3 + pulls×4 + board.columns×7 + issues×9 + labels×2
- [x] 12 业务表 + 4 基础设施表 schema 与 ADR-0002 对齐

## 用户验证项（不在 owner-takeover 范围）

- [ ] **`pnpm dev` 起来主进程 + 渲染进程无错**（请用户在终端跑一次，截 dev 启动日志）
- [ ] **看板视图能看到 m4java-test 仓库下 3 列（待办/进行中/已完成）+ 5 张 issue 卡片**（按灌的演示数据，列数 2/2/1）
- [ ] **点击 issue 卡片弹详情面板**（title / body / labels / assignee）
- [ ] **拖拽 issue 从"待办"列到"进行中"列** → 弹 ConfirmDialog 写明"完成" → 确认 → gitea 端该 issue label 实际变化
- [ ] **拖到"已完成"列时** 弹二次确认写明"该 issue 在 gitea 会自动关闭"（v1 真实关 gitea issue）
- [ ] **时间轴视图**：空状态文案走零术语（"去看板页创建项目"）
- [ ] **设置视图**：polling interval 1~30min 切换 → 状态栏轮询重启
- [ ] **StatusBar**：左上连接状态 + 仓库 + 刷新；右下用户 avatar + 退出

## 离线降级（AGENTS §8.5）

- [ ] **关掉本机 gitea 服务**（`docker stop gitea`）→ 状态栏显著提示"离线 / 缓存模式" + 看板仍显示上次缓存数据
- [ ] **写操作离线时按钮禁用 + 说明原因**

## 跨平台打包（AGENTS §2.4）

- [ ] **macOS dmg 双击安装可启动**（CI mac runner 或本机测）
- [ ] **Windows nsis exe 跑通**（如要扩平台）
- [ ] **Linux AppImage 跑通**（如要扩平台）

## 团队可决 vs 用户拍板

| 项 | owner 可决 | 用户拍板 |
|---|---|---|
| dev 启动报错排查 | ✓ | |
| UI 视觉细节（间距 / 颜色微调） | | ✓（设计 review） |
| 离线降级 UI 状态栏文案 | ✓ | |
| 打包目标平台增减 | | ✓（AGENTS §7.1 #9） |
| M4 阶段是否开（e2e 自动化 + 跨平台） | | ✓（里程碑拆解，AGENTS §7.1 #6） |
| 真实 gitea 仓库联调（不只 m4java-test） | | ✓（测试范围） |
