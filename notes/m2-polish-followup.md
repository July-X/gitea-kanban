# M2 polish followup（2026-06-11）

vue3-app-shell 审核 PASS，但 verifier 提了 3 条 polish 建议。**不在 v1 任务边界内**，留底给后续 plan 拍板（AGENTS §7.1 #10 需先报用户）。

| 建议 | 现状 | 影响 | 拍板建议 |
|---|---|---|---|
| 1. `pnpm check:no-jargon` 升级支持 .vue 文件扫描 | 脚本只扫 .ts/.html，.vue SFC 文本未参与零术语检查 | 0（开发测得过） | 后续 M2.1 polish 任务 |
| 2. `ConfirmDialog` confirmKeyword 在 BoardView 启用 | modal 级二次确认已写，但 keyword 强保护未挂上 | 0（M1 强语义层有 keychain 阻断） | 后续 M2.1 polish |
| 3. `/` 重定向到 `/board` vs spec `/auth` | 现 `/` → `/board`，spec 是 `/auth` | 0（功能等价：未连接用户被守卫覆盖） | 后续 M2.1 polish（spec 对齐） |

## 决策点
后续 plan 启动前先问用户：
- 是否要做这 3 条 polish（影响 1-2 小时）
- 还是直接进 v1 验收（m2 即可认为 done）
