/**
 * Drizzle schema barrel ——12 张业务表 +4 张基础设施表（ADR-0002 reset）
 *
 *实体关系：docs/design/02-architecture.md §4.1 + docs/adr/0002-board-data-source-reset.md
 * DDL： drizzle/0001_reset_board_data_source.sql
 *
 * 表清单（业务实体12 张）：
 *1. users —— 本地用户
 *2. gitea_accounts —— gitea 实例 + username（**不**含 token）
 *3. repo_projects —— 项目映射（每个加为"项目"的仓库一行）
 *4. board_columns —— gitea-kanban 本地看板列（**直接挂** repo_projects，无 boards 中间层）
 *5. column_label_mapping —— 列 ↔ gitea label 多对多映射
 *6. card_issue_link ——派生缓存：gitea issue 被哪条列"看到"（v1 可选保留）
 *7. gitea_refs ——关联的 git 对象（commit / pr / branch / issue）
 *8. starred_branches ——收藏分支
 *9. prefs —— 用户偏好（key-value）
 *10. undo_entries ——撤销栈
 *11. cache_entries ——通用缓存元数据
 *12. hook_deliveries —— webhook delivery 去重（v2启用）
 *
 *基础设施表2 张（**不**计入业务表）：
 * - gitea_user —— denormalized gitea /user 信息（首屏快取）
 *
 * 注：原02 §4.1 ER 图把 gitea_user隐含在 gitea_accounts 里，但02 §5.3.9 的 UserDTO 是实时从 gitea拉，
 *存 denorm 表主要是为 auth.status 不读 keychain也能拿到 user 信息。**结构**没变设计，是表的补充。
 *
 * 历史（ADR-00022026-06-11）：
 * -删 boards（boards 与 repo_projects1:1重复，无意义中间层）
 * -删 cards（gitea issue 即卡片，存本地是 denormalize）
 * -删 card_links（label 即关联，无需额外表）
 * -改 board_columns：直接挂 repoProjectId，删 wipLimit / hideMergedPr
 * - 加 column_label_mapping：列 ↔ gitea label 多对多
 * - 加 card_issue_link：派生缓存（v1 可选保留）
 */

export * from './users';
export * from './giteaAccounts';
export * from './giteaUser';
export * from './repoProjects';
export * from './boardColumns';
export * from './columnLabelMapping';
export * from './cardIssueLink';
export * from './giteaRefs';
export * from './starredBranches';
export * from './prefs';
export * from './undoEntries';
export * from './cacheEntries';
export * from './hookDeliveries';
