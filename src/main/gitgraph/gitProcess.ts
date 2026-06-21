/**
 * Git 二进制进程封装（main 端）
 *
 * 职责：跑 `git log --graph --date-order --decorate=full` 把字符流 + commit 元数据
 * 切成 GraphLine[]，传给前端 Gitea parser 解析。
 *
 * 为什么不走"基于 commit DAG 反推布局"：
 *   - Gitea 原版就是直接跑 `git log --graph` 然后 parser.go 解析
 *   - 反推式布局需要自己实现 `git log --graph --date-order` 的语义
 *     （按时间正序分配 lane + 跨列 merge edge 画斜线），会偏离 Gitea 原版
 *   - 用户拍板绑 git 二进制：直接 exec 子进程拿 raw 输出
 *
 * 与 Gitea graph.go 的等价性：
 *   - format 字符串完全一致：`%D|%H|%ad|%h|%s`
 *   - 命令参数完全一致：`log --graph --date-order --decorate=full -C -M --date=iso-strict`
 *   - 输出按 `\n` 切行；行首字形 + `DATA:` 分隔（与 graph.go bufio.Scanner 一致）
 *
 * 前置条件：
 *   - 本机 `git` 可执行文件在 PATH 里（Electron 用户也需要）
 *   - 仓库路径 = gitea 本地仓库路径（不是 gitea URL）
 *
 * 注：
 *   - 当前 v1.4 我们还没有"仓库本地路径"概念（gitea-kanban 通过 gitea REST API
 *     拉数据，不直连 git 仓库）；本模块为 v1.5 准备，本轮暂不接 IPC。
 *     IPC 接入时由 gitea API 拿 commit + parents 时间戳排序，按 Gitea 字符流
 *     协议手工生成字符流。
 *
 *     —— 不！我们刚刚拍了"绑 git 二进制"，所以等仓库本地路径落地后再接 IPC。
 */

import { spawn } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GraphLine, GraphLineCommit, GitRef } from '../../renderer/lib/gitgraph/types.js';

/** Gitea graph.go 的 format 串（与 Gitea 1:1 同步） */
const GRAPH_FORMAT = 'DATA:%D|%H|%ad|%h|%s';

/** Gitea graph.go 的 cmd args（与 graph.go:23-42 同步） */
const GRAPH_ARGS: readonly string[] = [
  'log',
  '--graph',
  '--date-order',
  '--decorate=full',
  '-C',
  '-M',
  '--date=iso-strict',
  `--pretty=format:${GRAPH_FORMAT}`,
] as const;

/**
 * runGraphLog —— 跑 git log --graph 并把输出切成 GraphLine[]
 *
 * 行格式（与 Gitea graph.go:66 一致）：
 *   {glyph prefix}DATA:{refs}|{sha}|{date}|{shortSha}|{subject}
 *
 * 行首非 DATA: 部分 = 字形字符串；DATA: 之后 = 管道分隔的 commit 元数据。
 *
 * @param cwd 仓库本地路径（**绝对路径**）
 * @param opts
 *   - branches: 要包含的分支（空 = 全部）
 *   - maxCount: 最大 commit 数（Gitea 走 setting.UI.GraphMaxCommitNum * page）
 *   - hidePRRefs: 是否排除 refs/pull/* （Gitea graph.go:25-27）
 *   - shaRefs: sha → GitRef[] 映射（由 listGiteaRefsBySha 提供；可选，ref 装饰由此覆盖）
 * @returns 按 row 升序排列的 GraphLine[]
 */
export interface RunGraphLogOpts {
  branches?: string[];
  maxCount?: number;
  hidePRRefs?: boolean;
  shaRefs?: Map<string, GitRef[]>;
}

export async function runGraphLog(
  cwd: string,
  opts: RunGraphLogOpts = {},
): Promise<{ lines: GraphLine[]; truncated: boolean; range: { from: string; to: string } }> {
  const args = [...GRAPH_ARGS];
  if (opts.hidePRRefs) {
    args.push('--exclude=refs/pull/*');
  }
  // 解析策略（与 Gitea router/web/repo/commit.go:147-152 一致）：
  //
  // 1. 始终加 `--branches` —— 让 git 把所有 local branches 当 refs，merge edge 才能跨分支
  //    （否则 git log feature1 feature2 各自只 walk 自己的祖先，看不到 merge edge）
  // 2. 用户传入的 branch 名是裸名（"main" / "feature/foo"，来自 gitea REST API），
  //    git log 不能直接识别 → 自动加 "refs/heads/" 前缀
  // 3. 若 branch 名已是 "refs/heads/X" / "refs/remotes/X" / "refs/tags/X" 全名，不动
  args.push('--branches');
  const branches = opts.branches && opts.branches.length > 0 ? opts.branches : null;
  if (branches) {
    for (const b of branches) {
      // 全名（已含 ref 前缀）直接传
      if (b.startsWith('refs/')) {
        args.push(b);
      } else {
        // 裸名（gitea BranchDto.name）补 refs/heads/ 前缀
        args.push(`refs/heads/${b}`);
      }
    }
  } else {
    // 不传 branches 时，--branches 已包含所有 local branches；不再额外加 --tags
    // （避免混搭远端 tag 让用户困惑；Gitea 默认也只显示 heads）
  }
  if (opts.maxCount && opts.maxCount > 0) {
    args.push(`-n`, String(opts.maxCount));
  }

  const raw = await execGit(args, cwd);

  // 切行；每行：{glyph}DATA:...
  const rawLines = raw.split('\n').filter((l) => l.length > 0);
  const lines: GraphLine[] = [];

  // 时间范围（首末 commit 的 date）
  let minDate = '';
  let maxDate = '';

  for (let row = 0; row < rawLines.length; row++) {
    const raw = rawLines[row]!;
    const dataIdx = raw.indexOf('DATA:');
    if (dataIdx < 0) {
      // 整行无 DATA: → 纯字形（罕见；理论上不会出现在 commit 行）
      lines.push({ row, glyph: raw, commit: null });
      continue;
    }
    const glyph = raw.substring(0, dataIdx);
    const dataPart = raw.substring(dataIdx + 'DATA:'.length);

    // 解析 DATA: 段（Gitea NewCommit 逻辑：bytes.SplitN(line, []byte("|"), 5)）
    const parts = dataPart.split('|');
    if (parts.length < 5) continue; // 损坏行

    const [refsStr, sha, date, shortSha, ...subjectParts] = parts;
    const subject = (subjectParts ?? []).join('|');

    const refs = parseRefs(refsStr ?? '');
    const enrichedRefs = opts.shaRefs?.get(sha ?? '') ?? refs;

    lines.push({
      row,
      glyph,
      commit: {
        sha: sha ?? '',
        shortSha: shortSha ?? (sha ?? '').slice(0, 7),
        subject: subject ?? '',
        date: date ?? '',
        authorName: '', // git log --pretty=format 没 %an，要 %an|%ae 才拿得到；目前先空
        authorEmail: '',
        isMerge: false, // 需要 %P 才能算 isMerge；目前 false
        parents: [],
        refs: enrichedRefs,
      } satisfies GraphLineCommit,
    });

    if (date) {
      if (!minDate || date < minDate) minDate = date;
      if (date > maxDate) maxDate = date;
    }
  }

  return {
    lines,
    truncated: false, // 由调用方决定（看是否达到 maxCount）
    range: { from: minDate, to: maxDate },
  };
}

// ============================================================
// helper
// ============================================================

function execGit(args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`git ${args.join(' ')} failed (exit=${code}): ${stderr}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * 解析 `%D` 字段（Gitea graph.go `newRefsFromRefNames` 1:1）
 *
 * 输入：`tag: v1.0, HEAD -> main, origin/main`
 * 输出：[{ name: 'v1.0', refGroup: 'tags', shortName: 'v1.0' },
 *        { name: 'refs/heads/main', refGroup: 'heads', shortName: 'main' },
 *        { name: 'refs/remotes/origin/main', refGroup: 'remotes', shortName: 'origin/main' }]
 */
export function parseRefs(refsStr: string): GitRef[] {
  if (!refsStr || !refsStr.trim()) return [];
  const parts = refsStr
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const refs: GitRef[] = [];
  for (const part of parts) {
    if (part.startsWith('tag: ')) {
      refs.push({ name: `refs/tags/${part.slice(5)}`, refGroup: 'tags', shortName: part.slice(5) });
    } else if (part.startsWith('HEAD -> ')) {
      refs.push({
        name: `refs/heads/${part.slice(8)}`,
        refGroup: 'heads',
        shortName: part.slice(8),
      });
    } else if (part.startsWith('remotes/')) {
      refs.push({
        name: `refs/remotes/${part.slice(8)}`,
        refGroup: 'remotes',
        shortName: part.slice(8),
      });
    } else if (part.includes('/')) {
      // 其它含 / 的（如 origin/main）按 remotes 处理
      refs.push({ name: `refs/remotes/${part}`, refGroup: 'remotes', shortName: part });
    } else {
      refs.push({ name: `refs/heads/${part}`, refGroup: 'heads', shortName: part });
    }
  }
  return refs;
}

// ============================================================
// git clone 封装（v1.5 Git Graph 启用流程）
// ============================================================

/**
 * 推荐本地仓库路径
 *
 * 规则：${tmpdir()}/gitea-kanban/repos/${owner}__${repo}.git
 * 用 tmpdir 而不是 user home 是因为：
 *   - macOS sandbox 下 ~ 可能写不进（AGENTS §8.7.6）
 *   - tmpdir 永远可写
 */
export function suggestLocalRepoPath(owner: string, repo: string): string {
  const safeOwner = owner.replace(/[^A-Za-z0-9_.-]/g, '_');
  const safeRepo = repo.replace(/[^A-Za-z0-9_.-]/g, '_');
  return join(tmpdir(), 'gitea-kanban', 'repos', `${safeOwner}__${safeRepo}.git`);
}

/**
 * 检查路径是否已存在（裸仓库）
 */
export function repoPathExists(cwd: string): boolean {
  try {
    return existsSync(join(cwd, 'HEAD')) && existsSync(join(cwd, 'objects'));
  } catch {
    return false;
  }
}

/**
 * 确保父目录存在
 */
async function ensureParentDir(cwd: string): Promise<void> {
  const parent = cwd.split('/').slice(0, -1).join('/');
  await fs.mkdir(parent, { recursive: true });
}

/**
 * git clone 封装（带 token）
 *
 * 鉴权策略（v1.5）：
 *   - 把 token 临时塞进 URL: `https://oauth2:{token}@{host}/{owner}/{repo}.git`
 *   - 立即 `git remote set-url origin` 去掉 token，写干净的 URL
 *     → `.git/config` 不会留存 token（防止泄漏到磁盘）
 *   - 进程退出后 token 仅在 clone 命令子进程 argv 中瞬时存在
 *
 * @param args.giteaUrl 例 'https://gitea.example.com'（不带尾斜杠）
 * @param args.owner / repo
 * @param args.token gitea PAT（建议 oauth2 scope + read:repo）
 * @param args.cwd 本地目标路径（已存在则报错）
 * @param args.bare 是否裸仓库（默认 false）
 * @returns 实际 clone 的本地路径（== cwd）
 */
export interface CloneRepoOpts {
  giteaUrl: string;
  owner: string;
  repo: string;
  token: string;
  cwd: string;
  bare?: boolean;
}

export async function cloneRepo(opts: CloneRepoOpts): Promise<{ cwd: string; stdout: string }> {
  if (repoPathExists(opts.cwd)) {
    throw new Error(`路径已存在（看起来是 git 仓库）：${opts.cwd}`);
  }
  await ensureParentDir(opts.cwd);

  const cleanUrl = `${opts.giteaUrl.replace(/\/$/, '')}/${opts.owner}/${opts.repo}.git`;
  // 把 token 塞进 URL 用于 clone；clone 完立即清掉
  const urlWithToken = opts.token
    ? cleanUrl.replace('https://', `https://oauth2:${encodeURIComponent(opts.token)}@`)
    : cleanUrl;

  const args = ['clone'];
  if (opts.bare) args.push('--bare');
  args.push(urlWithToken, opts.cwd);

  const { stdout } = await execGitWithStderr(args, tmpdir());

  // 立即去掉 token：set-url 改成无 token 的 cleanUrl
  // 仅当之前 clone 用了 token 时需要
  if (opts.token) {
    try {
      await execGit(['remote', 'set-url', 'origin', cleanUrl], opts.cwd);
    } catch (e) {
      // 裸仓库没有 origin；忽略
      if (!opts.bare) {
        console.warn('[gitProcess] remote set-url failed:', e);
      }
    }
  }

  return { cwd: opts.cwd, stdout };
}

function execGitWithStderr(args: readonly string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`git ${args.join(' ')} failed (exit=${code}): ${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

// ============================================================
// pull (merge) —— git fetch + pull --rebase
// ============================================================

/**
 * git rev-list --count HEAD —— 拿本地 commit 数（不含 origin/HEAD）
 */
function gitRevListCount(cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('git', ['rev-list', '--count', 'HEAD'], { cwd, env: process.env });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.on('close', () => {
      const n = parseInt(out.trim(), 10);
      resolve(Number.isFinite(n) ? n : 0);
    });
    child.on('error', () => resolve(0));
  });
}

export interface PullRepoOpts {
  cwd: string;
}

/**
 * git fetch + pull --rebase
 *
 * 流程：
 *   1. 先统计本地 HEAD commit 数（beforeCount）
 *   2. git fetch origin（拉远端最新 refs）
 *   3. git pull --rebase（默认 branch 优先；无 rebase 冲突时 merge 自动 fallback）
 *   4. 再统计本地 HEAD commit 数（afterCount）→ addedCommits = after - before
 *
 * 设计选择 pull 而不是 fetch + manual merge：
 *   - 用户期望"刷新远端 commit"——pull 是最直接的操作
 *   - 冲突由用户处理（git pull 会自动 merge；rebase 失败会保留冲突状态）
 *   - 抛错场景：网络断 / 无 origin / rebase 冲突（抛 IpcError）
 */
export async function pullRepo(opts: PullRepoOpts): Promise<{
  beforeCount: number;
  afterCount: number;
  addedCommits: number;
  stdout: string;
}> {
  const beforeCount = await gitRevListCount(opts.cwd);

  // 1. fetch
  const fetchResult = await execGitWithStderr(['fetch', 'origin'], opts.cwd);

  // 2. pull --rebase（允许自动 merge fallback）
  let pullStdout = '';
  try {
    const r = await execGitWithStderr(['pull', '--rebase', '--autostash'], opts.cwd);
    pullStdout = r.stdout + '\n' + r.stderr;
  } catch (e) {
    // pull 失败（rebase 冲突 / 无 upstream）—— 把 fetch stdout 一起抛
    throw new Error(
      `git pull --rebase failed: ${(e as Error).message}\n---fetch---\n${fetchResult.stdout}`,
    );
  }

  const afterCount = await gitRevListCount(opts.cwd);
  return {
    beforeCount,
    afterCount,
    addedCommits: afterCount - beforeCount,
    stdout: fetchResult.stdout + '\n' + pullStdout,
  };
}
