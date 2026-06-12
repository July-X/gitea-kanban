/**
 * Unified diff 字符串解析（v1.1.3 · task #23 修正）
 *
 * 背景：gitea v1.x 服务端 `getSingleCommit` 只返 files[].{filename, status}
 * 2 个字段，**不**返 additions / deletions / patch / previous_filename / binary_file。
 * 但 gitea 同时提供 `/git/commits/{sha}.diff` 端点返 raw unified diff —— 包含
 * 完整 patch + hunk header + `new file mode` / `deleted file mode` 状态行。
 *
 * 这里把 raw diff 解析为 `CommitFileChangeDto[]`，**就地**完成：
 * 1. 状态判定（added / deleted / renamed / modified / binary）
 * 2. +行 / -行 计数（hunk header 的 B/D + hunk body 实际 +/- 行）
 * 3. 函数名提取（复用 diff-hunk.ts 的 extractFunctionsFromPatch）
 *
 * 输入：gitea 返的 diff 字符串（含 `diff --git ...` 起始的标准 unified diff）
 * 输出：CommitFileChangeDto[] —— 按文件中出现顺序排列
 */

import type { CommitFileChangeDto } from '../ipc/schema.js';
import { extractFunctionsFromPatch } from './diff-hunk.js';

/** 状态优先级：renamed > added > deleted > modified > binary > unknown */
type FileStatus = 'added' | 'deleted' | 'renamed' | 'modified' | 'binary' | 'unknown';

interface RawFileEntry {
  status: FileStatus;
  filename: string;
  previousFilename?: string;
  additions: number;
  deletions: number;
  binary: boolean;
  patch: string; // 包含 hunk 头和 +/-
}

/**
 * 解析 gitea `.diff` 端点返回的 unified diff 字符串
 * 拆分为多文件的 additions/deletions/patch 元数据
 */
export function parseUnifiedDiff(diff: string): RawFileEntry[] {
  if (!diff) return [];
  const out: RawFileEntry[] = [];

  // 按 `diff --git a/... b/...` 切分为多文件
  // regex 匹配每段起始（multiline）
  const fileHeaders = diff.split(/^diff --git /m);
  // 第一个 split 元素是空字符串（split 前的部分），跳过
  for (let i = 1; i < fileHeaders.length; i++) {
    const section = fileHeaders[i]!;
    const entry = parseOneFileSection(section);
    if (entry) out.push(entry);
  }
  return out;
}

function parseOneFileSection(section: string): RawFileEntry | null {
  // section 的第一行形如：a/notes/foo.md b/notes/foo.md
  // 重命名时可能跨多行包含 rename from / rename to
  const lines = section.split('\n');
  const firstLine = lines[0] ?? '';

  // 提取 b/... 路径（rename 情况下 b/ 是新名）
  const m = firstLine.match(/^a\/(.+?)\s+b\/(.+?)$/);
  if (!m) return null;
  let newPath = m[2]!;

  let status: FileStatus = 'modified';
  let previousFilename: string | undefined;
  let binary = false;
  let patchStartIdx = 0;

  // 扫描模式行（直到第一个 hunk 或 file mode 行）
  for (let i = 1; i < lines.length; i++) {
    const ln = lines[i]!;
    if (ln.startsWith('new file mode')) {
      status = 'added';
      patchStartIdx = i + 1;
    } else if (ln.startsWith('deleted file mode')) {
      status = 'deleted';
      patchStartIdx = i + 1;
    } else if (ln.startsWith('rename from ')) {
      status = 'renamed';
      previousFilename = ln.slice('rename from '.length);
      patchStartIdx = i + 1;
    } else if (ln.startsWith('rename to ')) {
      // rename to 行覆盖 newPath
      newPath = ln.slice('rename to '.length);
    } else if (ln.startsWith('Binary files ')) {
      status = 'binary';
      binary = true;
      // 二进制文件无 hunk；统计 0/0
      patchStartIdx = i + 1;
      break;
    } else if (ln.startsWith('@@')) {
      // 第一个 hunk header —— 之前所有模式行都扫过了
      patchStartIdx = i;
      break;
    }
    // 其它元数据行（index / --- a/ / +++ b/）跳过
  }

  // 抽取 patch（从此处到下一个文件 section 的开头 —— 但 split 已经切了，所以就是 section 末尾）
  const patch = lines.slice(patchStartIdx).join('\n');

  // 统计 +/- 行
  let additions = 0;
  let deletions = 0;
  if (!binary) {
    for (const ln of lines.slice(patchStartIdx)) {
      if (ln.startsWith('+') && !ln.startsWith('+++')) additions++;
      else if (ln.startsWith('-') && !ln.startsWith('---')) deletions++;
    }
  }

  return {
    status,
    filename: newPath,
    previousFilename,
    additions,
    deletions,
    binary,
    patch,
  };
}

/**
 * 把 parseUnifiedDiff 的结果 + gitea-js 的 getSingleCommit 返回的 files[]
 * 合并为 CommitFileChangeDto[]。
 *
 * 合并策略：以 diff parse 结果为准（additions/deletions/binary/functions 都来自 diff），
 * 补充 gitea-js files[].status 作为兜底（diff 没有 `mode` 行时 status='unknown'）。
 *
 * @param diffParse  parseUnifiedDiff 返回值
 * @param giteaFiles gitea-js getSingleCommit 返回的 files[].{filename, status}
 *                   —— 用 filename 反查匹配
 */
export function mergeToFileChangeDtos(
  diffParse: RawFileEntry[],
  giteaFiles: Array<{ filename?: string; status?: string }>,
): CommitFileChangeDto[] {
  // 用 filename → gitea status 索引
  const giteaStatusByName = new Map<string, string | undefined>();
  for (const f of giteaFiles) {
    if (f.filename) giteaStatusByName.set(f.filename, f.status);
  }

  return diffParse.map((entry) => {
    // 兜底：如果 diff 解析 status 未知，用 gitea status
    const fallbackStatus = giteaStatusByName.get(entry.filename);
    const status =
      entry.status !== 'unknown' ? entry.status : (fallbackStatus as FileStatus | undefined) ?? 'unknown';

    const functions = entry.binary ? undefined : extractFunctionsFromPatch(entry.patch);

    return {
      filename: entry.filename,
      status,
      additions: entry.additions,
      deletions: entry.deletions,
      changes: entry.additions + entry.deletions,
      ...(entry.previousFilename ? { previousFilename: entry.previousFilename } : {}),
      ...(entry.binary ? { binary: true } : {}),
      ...(functions && functions.length > 0 ? { functions } : {}),
    };
  });
}
