/**
 * gitea refs API 包装层（基于 gitea-js）
 *
 * 用途：gitgraph 视图需要知道每个 commit 被哪些分支 / tag 指向，
 * 从而在 commit 行渲染 ref 标签（复刻 Gitea 原生 `--decorate=full` 的 %D 效果）。
 *
 * Gitea 官方 gitgraph 走 `git log --decorate=full` 的 `%D` 直接拿到 ref 装饰；
 * 我们走 REST API 没有 decorate，所以调 `GET /repos/{owner}/{repo}/git/refs`
 * （gitea-js `repoListAllGitRefs`）拿全量 refs，再按 object.sha 反查绑定到 commit。
 *
 * ref 名解析规则（对齐 Gitea modules/git/ref.go RefName.RefGroup / ShortName）：
 * - `refs/heads/<name>`   → group=heads,   short=<name>
 * - `refs/tags/<name>`    → group=tags,    short=<name>
 * - `refs/remotes/<name>` → group=remotes, short=<name>
 * - `refs/pull/<n>/head`  → group=pull,    short=<n>
 * - 其它                   → group=空,      short=原名
 */

import { getGiteaClient, unwrapGitea } from './client.js';

/**
 * Git ref 轻量 DTO —— 仅给 refs API 反查 commit 用，git graph 渲染时取 refGroup + shortName
 * 类型定义就地内联（原 ../gitgraph/models.js 在 v1.4 gitgraph 重构中已删；
 * renderer 端 src/renderer/lib/gitgraph/models.ts 有完整版镜像）
 */
export interface GitRef {
  name: string;
  refGroup: 'heads' | 'tags' | 'remotes' | 'pull';
  shortName: string;
}

/** ref 全名 → { refGroup, shortName }（对齐 Gitea RefName.RefGroup / ShortName） */
export function parseRefName(ref: string): { refGroup: GitRef['refGroup']; shortName: string } {
  if (ref.startsWith('refs/heads/')) {
    return { refGroup: 'heads', shortName: ref.slice('refs/heads/'.length) };
  }
  if (ref.startsWith('refs/tags/')) {
    return { refGroup: 'tags', shortName: ref.slice('refs/tags/'.length) };
  }
  if (ref.startsWith('refs/remotes/')) {
    return { refGroup: 'remotes', shortName: ref.slice('refs/remotes/'.length) };
  }
  // refs/pull/<n>/head → pull
  const pullMatch = ref.match(/^refs\/pull\/(\d+)\/head$/);
  if (pullMatch) {
    return { refGroup: 'pull', shortName: pullMatch[1]! };
  }
  return { refGroup: 'heads', shortName: ref };
}

/**
 * 拉仓库全量 git refs（heads + tags + remotes + pull）
 *
 * gitea `GET /repos/{owner}/{repo}/git/refs` 默认返回全量 ref；
 * 没有分页参数时 gitea 会分页，这里拉够用即可（默认 50，前端 gitgraph 上限 200 commit）。
 *
 * @returns sha → GitRef[] 映射（一个 commit 可能被多个 ref 指向）
 */
export async function listGiteaRefsBySha(args: {
  giteaUrl: string;
  username: string;
  owner: string;
  repo: string;
}): Promise<Map<string, GitRef[]>> {
  const { api } = await getGiteaClient(args.giteaUrl, args.username);

  // 注意：gitea-js `repoListAllGitRefs` 签名只接受 RequestParams（不含 query），
  // gitea `/git/refs` 端点默认返回全量 refs（仓库 refs 通常几十个，够用）。
  const res = await api.repos.repoListAllGitRefs(args.owner, args.repo);
  const raws = unwrapGitea(res, `/repos/${args.owner}/${args.repo}/git/refs 列表失败`);

  // sha → GitRef[]
  const shaRefs = new Map<string, GitRef[]>();
  for (const r of raws) {
    const fullName = r.ref ?? '';
    if (!fullName) continue;
    const sha = r.object?.sha ?? '';
    if (!sha) continue;
    const { refGroup, shortName } = parseRefName(fullName);
    const entry: GitRef = { name: fullName, refGroup, shortName };
    const arr = shaRefs.get(sha);
    if (arr) arr.push(entry);
    else shaRefs.set(sha, [entry]);
  }

  return shaRefs;
}
