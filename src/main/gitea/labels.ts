/**
 * gitea label API包装层（基于 gitea-js）
 *
 *契约：docs/adr/0002-board-data-source-reset.md §"IPC端点"
 *
 * endpoint清单：
 * - GET /repos/{owner}/{repo}/labels?page=&limit= → list
 * - POST /repos/{owner}/{repo}/labels → create
 *
 * 设计：
 * -看板列绑 gitea label 来"看到" issue（ADR-0002）
 * - labels.list 是看板列第一次绑 label 的 source of truth
 * - v1不做 labels.delete（gitea端删 label 是危险操作，UI跳 gitea）
 *
 *历史（ADR-00022026-06-11）：
 * - gitea1.26 没 projects API →看板 ↔ label映射关系替代 boards
 * -引入 gitea-js1.23.0
 */

import type { Label } from 'gitea-js';
import { getGiteaClient, unwrapGitea } from './client.js';
import type { LabelDto } from '../ipc/schema.js';

/** gitea-js Label → DTO。gitea-js 字段全 optional，fallback 处理。 */
function toLabelDto(r: Label): LabelDto {
 return {
 id: r.id ?? 0,
 name: r.name ?? '',
 color: r.color ?? '#000000',
 ...(r.description ? { description: r.description } : {}),
 };
}

/**列仓库 labels */
export async function listGiteaLabels(args: {
 giteaUrl: string;
 username: string;
 owner: string;
 repo: string;
 page?: number;
 limit?: number;
}): Promise<{ items: LabelDto[]; hasMore: boolean }> {
 const page = args.page ??1;
 const limit = args.limit ??50;
 const { api } = await getGiteaClient(args.giteaUrl, args.username);

 const res = await api.repos.issueListLabels(args.owner, args.repo, { page, limit });
 const raws = unwrapGitea(res, `/repos/${args.owner}/${args.repo}/labels列表失败`);

 const items = raws.map(toLabelDto);
 return { items, hasMore: raws.length === limit };
}

/**创建仓库 label */
export async function createGiteaLabel(args: {
 giteaUrl: string;
 username: string;
 owner: string;
 repo: string;
 name: string;
 color: string;
 description?: string;
}): Promise<LabelDto> {
 const { api } = await getGiteaClient(args.giteaUrl, args.username);

 const res = await api.repos.issueCreateLabel(args.owner, args.repo, {
 name: args.name,
 color: args.color,
 ...(args.description !== undefined ? { description: args.description } : {}),
 });
 const raw = unwrapGitea(res, `创建 label失败`);
 return toLabelDto(raw);
}
