# M6 prefs schema 拍板

> **时间**：2026-06-13
> **拍板**：方案 A —— prefs 复用 userId（设备级），**不**按 gitea account 切分
> **理由**：
> - 实际用 prefs 的 key 只有 2 个（`theme` / `navCollapsed`），切 gitea 账号让用户面对空配置体验差
> - theme / nav 折叠本质是"这台机器这一个人"的偏好，跟 gitea 账号无强关联
> - 避免 §7.1 schema 变更（不加列 / 不改 uniq / 不写 migration）
> - 维持 M5 v1 默认假设："同一台机器同一 app user 共享 prefs"
>
> **后续 plan 走向**：
> - 撤销 `plan_prefs_multiaccount.yaml` 的 Task 1（schema 变更），改为**注释对齐** task
> - prefs handler 行为**不**变（`LOCAL_USER_ID='local-user'` 保留）
> - 渲染端**零**改动（`userPrefsGet` / `userPrefsSet` 签名不变）
> - 留 M7+ 真要做 multi-account 时再启 B/C 方案

## 1. 当前实际 prefs 使用面

`grep` 结果（2026-06-13 验证）：

| 端点 | key | 用途 |
|---|---|---|
| `preferences.theme.get` / `.set` | `theme` | 暗/亮主题（dark/light）|
| `user.prefs.get` / `.set` | `navCollapsed` | NavRail 折叠状态 |

只有 2 个 key，且都是设备级偏好。

## 2. 三方案差异摘要

| | A 拍板（选） | B 加列 | C 删 userId |
|---|---|---|---|
| schema 变更 | ❌ | ✅ 加 nullable 列 + 改 uniq | ✅ 列重命名 + migration + 数据迁移 |
| 切 account theme 切走？ | ❌ | ✅（可选配） | ✅（必切） |
| 未连 gitea 可读写？ | ✅ | ✅ | ❌（破坏 M5） |
| 渲染端改动 | ❌ | ❌ | ❌ |
| 迁移成本 | 0 | drizzle migration 1 份 | migration + 数据迁移 |
| §7.1 拍板 | 无需 | **需拍** | **需拍** |

## 3. 拍板后落地点

3 处注释同步 "M6 拍板保留：prefs 跟 app user（设备级），不按 gitea account 切分"：

1. `src/main/ipc/user.ts:21-22` 头部注释
2. `src/main/cache/sqlite.ts:120-121 + 128-132` seedLocalUser 注释
3. `src/main/ipc/schema.ts:929` UserPrefsGetArgs 注释

**不**改：
- prefs 表 schema（prefs.ts:8-18）
- user.prefs.get/set IPC 签名（schema.ts:929-955）
- 渲染端任何 caller
- seedLocalUser 行为

## 4. 后续 (M7+ 真要做 multi-account 时)

如果产品定位改为"切 account 立即切走 theme"：
- 启 B 方案 plan（加 giteaAccountId nullable 列）
- 业务侧 `theme` key 强制要求 giteaAccountId 非 NULL
- `navCollapsed` 留 NULL（设备级）

不启 plan 时维持现状。
