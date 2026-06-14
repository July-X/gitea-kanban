/**
 * card-from-issues：列拉 gitea issue派生 IssueCardDTO（ADR-0002 §"业务"）
 *
 *职责：
 * - 实现 issues.list IPC handler
 * - 按 (columnId)过滤时：拿列绑的 gitea labels → 列 issues.list({ labels }) → 返回
 *
 * 设计（ADR-0002 §"业务约束"）：
 * -看板列绑 label 后，看板视图拉 issue = 列绑的 label ids 任一命中
 * - gitea `/issues?labels=1,2,3` 是 OR关系（fetch issues that have any of these labels）
 * - 一 issue命中多列绑的 label 时，v1只展示在"第一个命中列"（业务上 issue 是单列归属的，但 gitea端 OR查询会返所有命中）
 *
 *边界：
 * - **不**写本地 cards表（ADR-0002 reset）
 * - **不**直接调 gitea（走 src/main/gitea/issues.ts）
 */

import type { ListIssuesArgs, ListIssuesResp, IssueCardDto } from '../ipc/schema.js';
import { resolveProject } from './resolveProject.js';
import { listGiteaIssues } from '../gitea/issues.js';
import { getLocalStore } from '../local/state.js';
import { findColumnByIdWithStore } from '../local/columns.js';
import { listLabelMapsByColumnWithStore } from '../local/label-maps.js';

/**
 * 按入参过滤后拉 issue 列表
 *
 * 关键逻辑：
 * - columnId 给定 → 拿 column_label_mapping 绑的 label ids → gitea 按 labels 过滤
 * - columnId 未给 → 不按 label 过滤（仅按 state / q）
 * - 返回结果含 isPullRequest 标记（看板只展示 isPullRequest=false）
 *
 * ADR-0003 Phase 2：columnLabelMapping 改读 localStore
 */
export async function listIssuesFromGitea(args: ListIssuesArgs): Promise<ListIssuesResp> {
  const proj = resolveProject(args.projectId);

  let labelIds: number[] | undefined = args.labelIds;

  if (args.columnId !== undefined) {
    // 1. 拿列绑的 labels
    const state = getLocalStore().get();
    const col = findColumnByIdWithStore(state, args.columnId);
    if (!col) {
      // 列不存在 → 返空列表
      return { items: [], hasMore: false };
    }
    if (col.projectId !== args.projectId) {
      // 列不属于该 project → 返空
      return { items: [], hasMore: false };
    }

    const mappings = listLabelMapsByColumnWithStore(state, args.columnId);

    if (mappings.length === 0) {
      // 列没绑 label → 返空（前端提示"请先绑 label"）
      return { items: [], hasMore: false };
    }

    labelIds = mappings.map((m) => Number(m.giteaLabelId));
  }

 //2.调 gitea list issues
 const result = await listGiteaIssues({
 giteaUrl: proj.giteaUrl,
 username: proj.username,
 owner: proj.owner,
 repo: proj.repo,
 ...(args.state !== undefined ? { state: args.state } : {}),
 ...(labelIds !== undefined && labelIds.length >0 ? { labelIds: labelIds.map(String) } : {}),
 ...(args.q !== undefined ? { q: args.q } : {}),
 // a3 补：透传 assignee 到 gitea /issues?assigned_by=<username>（"我的卡片"用）
 //   不传 = 走 gitea 包装层原行为（不过滤 assignee，向后兼容）
 ...(args.assignee !== undefined && args.assignee.length > 0
 ? { assignee: args.assignee }
 : {}),
 page: args.page,
 limit: args.limit,
 });

 //3.过滤掉 PR（看板只看纯 issue；gitea /issues会把 PR也列出来）
 const items: IssueCardDto[] = result.items.filter((it) => !it.isPullRequest);

 return {
 items,
 hasMore: result.hasMore,
 };
}
