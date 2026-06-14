/**
 * Gitea 缓存层 schema（ADR-0003 Phase 3 业务表剥离后）
 *
 * 业务表（users / giteaAccounts / giteaUser / repoProjects / boardColumns /
 * columnLabelMapping / starredBranches / prefs）已**全部**迁到 localStore。
 * 剩下的 Gitea 缓存层（cache-aside 模式）仍在 SQLite（Phase 3b 单独切到
 * 文件 JSON 缓存）。
 *
 * 当前 schema：
 * - cacheEntries —— 通用资源级缓存（repos / branches / commits / pulls / timeline）
 *
 * 边界（任务 prompt §严格边界）：
 * - **不**碰 IPC 契约
 * - **不**碰 src/renderer/**
 * - **不**改 Gitea 集成
 */
export * from './cacheEntries.js';
