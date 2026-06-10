/**
 * Drizzle schema barrel —— 13 张表
 *
 * 实体关系：docs/design/02-architecture.md §4.1 ER 图
 * DDL：       docs/design/02-architecture.md §4.2
 *
 * 表清单（13 张）：
 *   1.  users                 —— 本地用户
 *   2.  gitea_accounts        —— gitea 实例 + username（**不**含 token）
 *   3.  gitea_user            —— denormalized gitea /user 信息（首屏快取）
 *   4.  repo_projects         —— 项目映射（每个加为"项目"的仓库一行）
 *   5.  boards                —— 1:1 with repo_project
 *   6.  board_columns         —— 看板列
 *   7.  cards                 —— 卡片
 *   8.  card_links            —— 卡片 ↔ git 引用 多对多
 *   9.  gitea_refs            —— 关联的 git 对象（commit / pr / branch / issue）
 *   10. starred_branches      —— 收藏分支
 *   11. prefs                 —— 用户偏好（key-value）
 *   12. undo_entries          —— 撤销栈
 *   13. cache_entries         —— 通用缓存元数据
 *   14. hook_deliveries       —— webhook delivery 去重（v2 启用）
 *
 * 注：14 张是连"gitea_user"那张 denormalized 表都算上；原 02 §4.1 ER 图把 gitea_user
 * 隐含在 gitea_accounts 里，但 02 §5.3.9 的 UserDTO 是实时从 gitea 拉，存 denorm 表
 * 主要是为 auth.status 不读 keychain 也能拿到 user 信息。**结构**没变设计，是表的补充。
 */

export * from './users';
export * from './giteaAccounts';
export * from './giteaUser';
export * from './repoProjects';
export * from './boards';
export * from './boardColumns';
export * from './cards';
export * from './cardLinks';
export * from './giteaRefs';
export * from './starredBranches';
export * from './prefs';
export * from './undoEntries';
export * from './cacheEntries';
export * from './hookDeliveries';
