# legacy/electron — 归档的 Electron 版本

> 本目录是 gitea-kanban 项目的**旧 Electron + TypeScript + Vue 3 实现**，已于 2026 年迁移到 Go + Wails 架构。
>
> **归档目的**：迁移期对照参考。新 Go 实现在根目录 `app/`（后端）+ `frontend/`（Vue 3 前端，从本目录 `src/renderer/` 迁移而来）。

## 目录内容

| 路径 | 说明 |
|---|---|
| `src/` | 旧源码（main / preload / renderer / shared） |
| `electron.vite.config.ts` | electron-vite 三端构建配置 |
| `electron-builder.yml` | electron-builder 打包配置 |
| `package.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml` | 旧依赖声明 |
| `tsconfig.json` / `tsconfig.node.json` | TS 配置 |
| `vitest.config.ts` | 测试配置 |
| `scripts/` | 工具脚本（check-no-jargon / e2e / seed 等） |
| `tests/` | 旧测试 |
| `out/` / `release/` / `coverage/` | 旧构建产物（gitignored） |

## 不再维护

本目录代码**不再构建、不再测试、不再维护**。新功能全部在根目录 Go + Wails 项目实现。

如需运行旧版本：`cd legacy/electron && pnpm install && pnpm dev`（仅参考用）。
