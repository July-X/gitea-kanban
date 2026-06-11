/**
 * board业务层通用 helper：通过 projectId拿到 (giteaUrl, username, owner, repo)
 *
 * 当前各 IPC handler（branches / commits / pulls / issues）都自带 resolveProject；
 *抽到 board/move-card.ts是因为 IPC handler 内是 private，board业务层需要自己 resolve
 */
import { eq } from 'drizzle-orm';
import { getDb } from '../cache/sqlite.js';
import { repoProjects } from '../cache/schema/repoProjects.js';
import { giteaAccounts } from '../cache/schema/giteaAccounts.js';
import { IpcError, IpcErrorCode } from '@shared/errors';

export function resolveProject(projectId: string): {
 giteaUrl: string;
 username: string;
 owner: string;
 repo: string;
} {
 const db = getDb();
 const row = db
 .select()
 .from(repoProjects)
 .where(eq(repoProjects.id, projectId))
 .all()[0];
 if (!row) {
 throw new IpcError({
 code: IpcErrorCode.NOT_FOUND,
 message: '项目不存在',
 hint: '请先在仓库列表中重新添加该仓库为项目',
 });
 }
 const acc = db
 .select()
 .from(giteaAccounts)
 .where(eq(giteaAccounts.id, row.giteaAccountId))
 .all()[0];
 if (!acc) {
 throw new IpcError({
 code: IpcErrorCode.NOT_FOUND,
 message: 'gitea账户不存在（项目孤儿）',
 hint: '请重新连接 gitea账户',
 });
 }
 return {
 giteaUrl: acc.giteaUrl,
 username: acc.username,
 owner: row.owner,
 repo: row.name,
 };
}
