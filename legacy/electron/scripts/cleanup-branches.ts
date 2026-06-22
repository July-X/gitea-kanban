/**
 * cleanup-branches.ts —— 一次性脚本：清理 m4java-test 仓库的 pr-/cx-/conflict- 测试分支
 *
 * 来源：这些分支是 seed-conflict-prs.mjs / seed-pr-fixtures.mjs 等测试脚本创建的
 *
 * 用法：
 *   pnpm tsx scripts/cleanup-branches.ts            # 实际删除
 *   DRY_RUN=1 pnpm tsx scripts/cleanup-branches.ts  # 只预览
 *
 * 自动流程（零交互）：
 *   1. 从 state.json 读 m4java-test 项目和关联账户的 giteaUrl/username
 *   2. 从 macOS keychain（@napi-rs/keyring）读 token
 *   3. 拉分支列表，按 pr-/cx-/conflict- 分组，每组保留最新一个
 *   4. DELETE 其余分支（DRY_RUN=1 时只打印不删）
 *
 * 保护：
 *   - 不动 default 分支（master/main 等）
 *   - 只针对 m4java-test 项目
 */

import { readFileSync } from 'node:fs';
import { resolve as resolvePath, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { AsyncEntry } from '@napi-rs/keyring';

interface GiteaUserInfo {
  giteaUserId: number;
  login: string;
  fullName?: string;
  email?: string;
  avatarUrl?: string;
  updatedAt: number;
}

interface GiteaAccount {
  id: string;
  giteaUrl: string;
  username: string;
  userInfo: GiteaUserInfo | null;
}

interface RepoProject {
  id: string;
  giteaAccountId: string;
  owner: string;
  name: string;
  defaultBranch: string | null;
}

interface LocalState {
  accounts: GiteaAccount[];
  projects: RepoProject[];
}

const KEYCHAIN_SERVICE_PREFIX = 'gitea-kanban@';

function resolveStatePath(): string {
  const dataDir = process.env['GITEA_KANBAN_DATA_DIR'] ?? `${homedir()}/.gitea-kanban`;
  if (!isAbsolute(dataDir)) throw new Error(`data dir must be absolute: ${dataDir}`);
  return resolvePath(dataDir, 'state.json');
}

function loadState(): LocalState {
  return JSON.parse(readFileSync(resolveStatePath(), 'utf-8')) as LocalState;
}

async function getTokenFromKeychain(giteaUrl: string, username: string): Promise<string> {
  const entry = new AsyncEntry(`${KEYCHAIN_SERVICE_PREFIX}${giteaUrl}`, username);
  try {
    const pw = await entry.getPassword();
    if (pw) return pw;
  } catch {
    // keychain 不可用或没找到 → 尝试 dev fallback
  }
  // dev fallback：${userData}/dev-tokens/<encoded>__<user>.json
  // dev mode 下 App 写到 /tmp/gitea-kanban-dev/dev-tokens/（AGENTS §8.2）
  const userDataDir = process.env['GITEA_KANBAN_USER_DATA_DIR'] ?? '/tmp/gitea-kanban-dev';
  const encoded = giteaUrl.replace(/[:/.]/g, '_');
  const file = resolvePath(userDataDir, 'dev-tokens', `${encoded}__${username}.json`);
  try {
    const j = JSON.parse(readFileSync(file, 'utf-8')) as { token: string };
    if (j.token) return j.token;
  } catch {
    // ignore
  }
  throw new Error(`keychain 和 dev fallback 都找不到 ${giteaUrl}/${username} 的 token（试过 ${file}）`);
}

interface GiteaBranch {
  name: string;
  commit: { id: string; timestamp: string };
  protected: boolean;
}

async function listBranches(token: string, giteaUrl: string, owner: string, repo: string): Promise<GiteaBranch[]> {
  const all: GiteaBranch[] = [];
  let page = 1;
  while (true) {
    const res = await fetch(`${giteaUrl}/api/v1/repos/${owner}/${repo}/branches?limit=50&page=${page}`, {
      headers: { Authorization: `token ${token}`, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`list branches failed: ${res.status} ${await res.text()}`);
    const items = (await res.json()) as GiteaBranch[];
    all.push(...items);
    if (items.length < 50) break;
    page++;
  }
  return all;
}

async function deleteBranch(token: string, giteaUrl: string, owner: string, repo: string, name: string): Promise<number> {
  const res = await fetch(`${giteaUrl}/api/v1/repos/${owner}/${repo}/branches/${encodeURIComponent(name)}`, {
    method: 'DELETE',
    headers: { Authorization: `token ${token}`, Accept: 'application/json' },
  });
  return res.status;
}

function groupByPrefix(branches: GiteaBranch[], prefixes: string[], defaultBranch: string | null): Map<string, GiteaBranch[]> {
  const groups = new Map<string, GiteaBranch[]>();
  for (const b of branches) {
    if (defaultBranch && b.name === defaultBranch) continue;
    const prefix = prefixes.find((p) => b.name.startsWith(p));
    if (!prefix) continue;
    const arr = groups.get(prefix) ?? [];
    arr.push(b);
    groups.set(prefix, arr);
  }
  for (const arr of groups.values()) {
    arr.sort((a, b) => a.commit.timestamp.localeCompare(b.commit.timestamp));
  }
  return groups;
}

async function main(): Promise<void> {
  const dryRun = process.env['DRY_RUN'] === '1';
  const prefixes = (process.env['PREFIXES'] ?? 'pr-,cx-,conflict-').split(',').filter(Boolean);

  const state = loadState();
  // 找关联到现存 account 的 m4java-test project（跳过孤儿 project）
  const candidates = state.projects.filter((p) => p.name === 'm4java-test');
  if (candidates.length === 0) {
    console.error('state.json 里没找到 m4java-test 项目');
    process.exit(1);
  }
  let project: RepoProject | undefined;
  let account: GiteaAccount | undefined;
  for (const p of candidates) {
    const a = state.accounts.find((acc) => acc.id === p.giteaAccountId);
    if (a) {
      project = p;
      account = a;
      break;
    }
  }
  if (!project || !account) {
    console.error('m4java-test 项目都关联到不存在的 account');
    process.exit(1);
  }
  if (candidates.length > 1) {
    console.log(`注意: 发现 ${candidates.length} 个 m4java-test project，使用关联到现存 account 的那个`);
  }

  console.log(`仓库: ${account.giteaUrl}/${project.owner}/${project.name}`);
  console.log(`账户: ${account.username}`);
  console.log(`前缀: ${prefixes.join(', ')}`);
  console.log(`模式: ${dryRun ? 'DRY-RUN（只预览不删）' : '实际删除'}`);

  console.log('\n从 keychain 读 token...');
  const token = await getTokenFromKeychain(account.giteaUrl, account.username);
  console.log('  ✓ token 已读取');

  console.log('\n拉取分支列表...');
  const branches = await listBranches(token, account.giteaUrl, project.owner, project.name);
  console.log(`  共 ${branches.length} 个分支`);

  const groups = groupByPrefix(branches, prefixes, project.defaultBranch);
  if (groups.size === 0) {
    console.log(`\n没有匹配 ${prefixes.join('|')} 前缀的分支，退出`);
    return;
  }

  const toDelete: GiteaBranch[] = [];
  const toKeep: GiteaBranch[] = [];
  for (const [prefix, arr] of groups) {
    const keep = arr[0]!;
    const remove = arr.slice(1);
    toKeep.push(keep);
    toDelete.push(...remove);
    console.log(`\n[${prefix}] ${arr.length} -> 1`);
    console.log(`  保留: ${keep.name} (${keep.commit.timestamp})`);
    for (const b of remove) {
      console.log(`  删除: ${b.name} (${b.commit.timestamp})`);
    }
  }

  console.log(`\n总结: 保留 ${toKeep.length}, 删除 ${toDelete.length}`);

  if (toDelete.length === 0) {
    console.log('没有要删除的分支');
    return;
  }

  if (dryRun) {
    console.log('\n[DRY-RUN] 设置 DRY_RUN=0 实际删除');
    return;
  }

  console.log('\n开始删除...');
  let ok = 0;
  let fail = 0;
  for (const b of toDelete) {
    try {
      const status = await deleteBranch(token, account.giteaUrl, project.owner, project.name, b.name);
      if (status === 204) {
        ok++;
        console.log(`  ✓ ${b.name}`);
      } else {
        fail++;
        console.log(`  ✗ ${b.name} (HTTP ${status})`);
      }
    } catch (e) {
      fail++;
      console.log(`  ✗ ${b.name} (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  console.log(`\n完成: 成功 ${ok}, 失败 ${fail}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});