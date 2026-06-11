/**
 * gitea issue API包装层（基于 gitea-js）
 *
 * 契约：docs/adr/0002-board-data-source-reset.md §"IPC端点"
 *
 * endpoint清单：
 * - GET /repos/{owner}/{repo}/issues?state=&labels=&page=&limit= → list
 * - GET /repos/{owner}/{repo}/issues/{index} → get
 * - POST /repos/{owner}/{repo}/issues → create
 * - PATCH /repos/{owner}/{repo}/issues/{index} → edit
 * - PUT /repos/{owner}/{repo}/issues/{index}/labels → addLabel（添加一组 labels）
 * - DELETE /repos/{owner}/{repo}/issues/{index}/labels/{id} → removeLabel
 * - GET /repos/{owner}/{repo}/issues/{index}/comments → listComments
 * - POST /repos/{owner}/{repo}/issues/{index}/comments → createComment
 *
 * 设计：
 * - 卡片 = gitea issue（ADR-0002 reset 后不再有本地 cards 表）
 * - 列 ↔卡片关联 = 列绑的 gitea label
 * - list 可按 labels过滤（gitea端逗号分隔多 label）
 *
 * 历史（ADR-0002 2026-06-11）：
 * - gitea1.26 community 没有 projects API（ADR-0002）→卡片源改用 gitea issues
 * - 引入 gitea-js1.23.0替换 openapi-fetch
 */

import type { Comment, Issue, Label } from 'gitea-js';
import { getGiteaClient, unwrapGitea } from './client.js';
import type { IssueCardDto, IssueState, IssueCommentDto } from '../ipc/schema.js';

/** gitea-js Issue → 业务 DTO。gitea-js 字段全 optional（swagger 习惯），全 fallback。 */
function toIssueDto(r: Issue): IssueCardDto {
  // gitea-js Issue 用 number 字段（仓库内递增的 issue/PR 编号），不用 id
  // 兼容：若 number 缺失（不应该），fallback 到 id
  const number = r.number ?? r.id ?? 0;
  return {
    id: number,
    index: number,
    title: r.title ?? '',
    body: r.body ?? '',
    state: (r.state ?? 'open') as 'open' | 'closed',
    createdAt: r.created_at ?? new Date(0).toISOString(),
    updatedAt: r.updated_at ?? new Date(0).toISOString(),
    author: {
      username: r.user?.login ?? '<unknown>',
      ...(r.user?.full_name ? { fullName: r.user.full_name } : {}),
      ...(r.user?.avatar_url ? { avatarUrl: r.user.avatar_url } : {}),
    },
    labels: (r.labels ?? []).map((l) => labelToDto(l)),
    // true 当 gitea response 包含非空 pull_request（gitea 把 PR 也列在 /issues）
    isPullRequest: r.pull_request != null,
  };
}

/** gitea-js Label → 业务 Label DTO */
function labelToDto(l: Label): { id: number; name: string; color: string; description?: string } {
  return {
    id: l.id ?? 0,
    name: l.name ?? '',
    color: l.color ?? '#000000',
    ...(l.description ? { description: l.description } : {}),
  };
}

/**
 * 拉仓库 issue列表（看板用，按 columnId过滤时用 labels维度）
 *
 * @param labelIds 逗号分隔的 label id列表（gitea端 OR关系：fetch issues that have any of these labels）
 * 业务侧调用：列绑了哪些 label → 列出带这些 label 的 issue
 */
export async function listGiteaIssues(args: {
  giteaUrl: string;
  username: string;
  owner: string;
  repo: string;
  state?: IssueState;
  labelIds?: string[]; // 列绑的 label id列表
  q?: string;
  page?: number;
  limit?: number;
}): Promise<{ items: IssueCardDto[]; hasMore: boolean }> {
  const page = args.page ?? 1;
  const limit = args.limit ?? 50;
  const { api } = await getGiteaClient(args.giteaUrl, args.username);

  const res = await api.repos.issueListIssues(args.owner, args.repo, {
    ...(args.state !== undefined ? { state: args.state } : {}),
    ...(args.labelIds && args.labelIds.length > 0 ? { labels: args.labelIds.join(',') } : {}),
    ...(args.q !== undefined ? { q: args.q } : {}),
    type: 'issues', //排除 PR（gitea /issues 也会列 PR；看板只看纯 issue）
    page,
    limit,
  });
  const raws = unwrapGitea(res, `/repos/${args.owner}/${args.repo}/issues列表失败`);

  const items = raws.map(toIssueDto);
  return { items, hasMore: raws.length === limit };
}

/** 拉单个 issue */
export async function getGiteaIssue(args: {
  giteaUrl: string;
  username: string;
  owner: string;
  repo: string;
  index: number;
}): Promise<IssueCardDto> {
  const { api } = await getGiteaClient(args.giteaUrl, args.username);

  const res = await api.repos.issueGetIssue(args.owner, args.repo, args.index);
  const raw = unwrapGitea(res, `获取 issue #${args.index}失败`);
  return toIssueDto(raw);
}

/**
 * 创建 issue（gitea返回新 issue）
 *
 * body参数对应 gitea CreateIssueOption：{ title, body?, labels?: number[] }
 * gitea-js要求 body字段是 CreateIssueOption类型（不传就 undefined）
 */
export async function createGiteaIssue(args: {
  giteaUrl: string;
  username: string;
  owner: string;
  repo: string;
  title: string;
  body?: string;
  labelIds?: number[];
}): Promise<IssueCardDto> {
  const { api } = await getGiteaClient(args.giteaUrl, args.username);

  const res = await api.repos.issueCreateIssue(args.owner, args.repo, {
    title: args.title,
    ...(args.body !== undefined ? { body: args.body } : {}),
    ...(args.labelIds && args.labelIds.length > 0 ? { labels: args.labelIds } : {}),
  });
  const raw = unwrapGitea(res, `创建 issue失败`);
  return toIssueDto(raw);
}

/** 编辑 issue（title / body / state） */
export async function editGiteaIssue(args: {
  giteaUrl: string;
  username: string;
  owner: string;
  repo: string;
  index: number;
  title?: string;
  body?: string;
  state?: 'open' | 'closed';
}): Promise<IssueCardDto> {
  const { api } = await getGiteaClient(args.giteaUrl, args.username);

  const res = await api.repos.issueEditIssue(args.owner, args.repo, args.index, {
    ...(args.title !== undefined ? { title: args.title } : {}),
    ...(args.body !== undefined ? { body: args.body } : {}),
    ...(args.state !== undefined ? { state: args.state } : {}),
  });
  const raw = unwrapGitea(res, `编辑 issue #${args.index}失败`);
  return toIssueDto(raw);
}

/**
 * 给 issue添加一个 label（看板拖拽换列用 ——加目标列 label）
 *
 * gitea endpoint: PUT /repos/{owner}/{repo}/issues/{index}/labels
 * body: { labels: number[] } ——一次可加多个
 * 返回：更新后的 Label[]
 */
export async function addGiteaIssueLabel(args: {
  giteaUrl: string;
  username: string;
  owner: string;
  repo: string;
  index: number;
  labelId: number;
}): Promise<void> {
  const { api } = await getGiteaClient(args.giteaUrl, args.username);

  const res = await api.repos.issueAddLabel(args.owner, args.repo, args.index, {
    labels: [args.labelId],
  });
  unwrapGitea(res, `添加 label失败`);
}

/**
 * 给 issue移除一个 label（看板拖拽换列用 ——移原列 label）
 *
 * gitea endpoint: DELETE /repos/{owner}/{repo}/issues/{index}/labels/{id}
 */
export async function removeGiteaIssueLabel(args: {
  giteaUrl: string;
  username: string;
  owner: string;
  repo: string;
  index: number;
  labelId: number;
}): Promise<void> {
  const { api } = await getGiteaClient(args.giteaUrl, args.username);

  const res = await api.repos.issueRemoveLabel(args.owner, args.repo, args.index, args.labelId);
  unwrapGitea(res, `移除 label失败`);
}

/** 列 issue 评论 */
export async function listGiteaIssueComments(args: {
  giteaUrl: string;
  username: string;
  owner: string;
  repo: string;
  index: number;
}): Promise<IssueCommentDto[]> {
  const { api } = await getGiteaClient(args.giteaUrl, args.username);

  const res = await api.repos.issueGetComments(args.owner, args.repo, args.index);
  const raws = unwrapGitea(res, `列 issue #${args.index}评论失败`);

  return raws.map((c: Comment) => commentToDto(c));
}

/** 创建 issue评论 */
export async function createGiteaIssueComment(args: {
  giteaUrl: string;
  username: string;
  owner: string;
  repo: string;
  index: number;
  body: string;
}): Promise<IssueCommentDto> {
  const { api } = await getGiteaClient(args.giteaUrl, args.username);

  const res = await api.repos.issueCreateComment(args.owner, args.repo, args.index, {
    body: args.body,
  });
  const raw = unwrapGitea(res, `创建评论失败`);
  return commentToDto(raw);
}

function commentToDto(c: Comment): IssueCommentDto {
  return {
    id: c.id ?? 0,
    body: c.body ?? '',
    author: {
      username: c.user?.login ?? '<unknown>',
      ...(c.user?.avatar_url ? { avatarUrl: c.user.avatar_url } : {}),
    },
    createdAt: c.created_at ?? new Date(0).toISOString(),
    updatedAt: c.updated_at ?? new Date(0).toISOString(),
  };
}
