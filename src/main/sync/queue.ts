/**
 * 同步队列 —— queue.jsonl 序列化
 *
 * ADR-0003 Phase 3 同步队列设计：
 * - 文件位置：${GITEA_KANBAN_DATA_DIR}/queue.jsonl
 * - 格式：每行一条 JSONL entry（{id, op, args, queuedAt, attempt, status, lastError?, failedAt?}）
 * - **append-only**：enqueue 追加行，done 标记软删除（改 status + 写 [DONE] 行）
 * - **崩后恢复**：启动期 scan 整个文件，重建内存 pending/failed 列表
 * - **大小控制**：30 天前 done / 1000 条以上 failed → 启动期 GC
 *
 * 边界（Phase 3 简化）：
 * - **不**做并发锁（v1 单实例）
 * - **不**做加密（token / keychain 已在 AGENTS §8.1 保护）
 * - **不**做 schema 校验（Zod 在 IPC 边界 + dispatch 入口）
 * - **不**支持 multi-op 事务（v1 单 op 原子）
 *
 * 错误处理：
 * - 文件 I/O 错：抛（启动期 / 关键写路径不能 fail-soft）
 * - JSON 解析错（坏 entry）：log warn 跳过
 */

import { existsSync, mkdirSync } from 'node:fs';
import { readFile, appendFile, writeFile, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pino } from 'pino';

/**
 * 内部独立 pino 实例
 * 同 src/main/local/store.ts 的做法：log.ts 顶层 import electron.app，
 * vitest 在 Node 下会炸（app is undefined）。sync 模块纯 JS，测试环境跑必须解耦。
 */
const log = pino({ name: 'sync-queue', level: process.env['LOG_LEVEL'] ?? 'info' });

export type QueueEntryStatus = 'pending' | 'in-flight' | 'failed' | 'done' | 'abandoned';

export interface QueueEntry {
  id: string;
  op: string;
  args: unknown;
  queuedAt: number; // epoch ms
  attempt: number;
  status: QueueEntryStatus;
  lastError?: string;
  failedAt?: number;
  doneAt?: number;
}

const QUEUE_FILENAME = 'queue.jsonl';
const GC_DONE_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
const GC_FAILED_LIMIT = 1000; // 超过这个数的旧 failed entry 删

/**
 * 工具：拼出 queue.jsonl 完整路径
 *
 * 路径策略：与 localStore state.json 同源（与 sqlite.ts resolveDbPath / prefs-mirror.ts resolveStatePath 保持一致）
 * - 优先 ${GITEA_KANBAN_DATA_DIR}/queue.jsonl
 * - 兜底 ~/.gitea-kanban/queue.jsonl
 */
export function resolveQueuePath(): string {
  const dataDir = process.env['GITEA_KANBAN_DATA_DIR']
    ?? join(process.env['HOME'] ?? '/tmp', '.gitea-kanban');
  return join(dataDir, QUEUE_FILENAME);
}

/**
 * 加载整个 queue.jsonl 到内存
 *
 * 启动期调一次；崩后从磁盘恢复
 *
 * @returns QueueEntry[] 按 queuedAt 升序
 */
export async function loadQueue(): Promise<QueueEntry[]> {
  const file = resolveQueuePath();
  if (!existsSync(file)) return [];
  const raw = await readFile(file, 'utf8').catch((err) => {
    log.error({ err: err instanceof Error ? err.message : String(err), file }, 'loadQueue: readFile failed');
    return '';
  });
  if (!raw) return [];

  const byId = new Map<string, QueueEntry>();
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    try {
      const e = JSON.parse(line) as QueueEntry;
      // 崩恢复：上次崩在 in-flight → 重置为 pending 让 SyncRunner 重试
      if (e.status === 'in-flight') {
        e.status = 'pending';
      }
      // 同一 id 可能有多行（enqueue 1 条 + markDone 1 条 ...）；append-only 文件顺序
      // 保证最新在后 → Map.set 覆盖即得最新版
      byId.set(e.id, e);
    } catch (err) {
      log.warn(
        { line: i + 1, err: err instanceof Error ? err.message : String(err) },
        'loadQueue: skip malformed line',
      );
    }
  }
  const entries = [...byId.values()].sort((a, b) => a.queuedAt - b.queuedAt);
  log.info({ file, total: entries.length }, 'loadQueue: loaded');
  return entries;
}

/**
 * 追加一条 entry（enqueue）
 *
 * 写盘策略：直接 appendFile（不 fsync）—— append-only 文件系统上是原子追加；
 * 崩在最坏情况丢最新 1 条（可接受，pending 列表是软状态）
 */
export async function enqueueEntry(args: { op: string; payload: unknown }): Promise<QueueEntry> {
  const entry: QueueEntry = {
    id: `q-${randomUUID()}`,
    op: args.op,
    args: args.payload,
    queuedAt: Date.now(),
    attempt: 0,
    status: 'pending',
  };
  await appendToFile(entry);
  log.debug({ id: entry.id, op: entry.op }, 'queue: enqueued');
  return entry;
}

/**
 * 追加一条"完成"行（软删，保留审计）
 */
export async function markEntryDone(id: string): Promise<void> {
  const file = resolveQueuePath();
  const update: Pick<QueueEntry, 'status' | 'doneAt'> = {
    status: 'done',
    doneAt: Date.now(),
  };
  await appendToFile({ id, ...update } as unknown as QueueEntry);
  log.debug({ id, file }, 'queue: marked done');
}

/**
 * 追加一条"失败"行
 */
export async function markEntryFailed(id: string, err: string): Promise<void> {
  const update: Partial<QueueEntry> = {
    status: 'failed',
    lastError: err,
    failedAt: Date.now(),
  };
  await appendToFile({ id, ...update } as unknown as QueueEntry);
  log.warn({ id, err }, 'queue: marked failed');
}

/**
 * 追加一条"放弃"行（用户主动放弃）
 */
export async function markEntryAbandoned(id: string): Promise<void> {
  const update: Partial<QueueEntry> = {
    status: 'abandoned',
  };
  await appendToFile({ id, ...update } as unknown as QueueEntry);
  log.info({ id }, 'queue: marked abandoned');
}

/**
 * 内部：appendFile 一行
 */
async function appendToFile(entry: QueueEntry): Promise<void> {
  const file = resolveQueuePath();
  if (!existsSync(dirname(file))) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  }
  // 序列化为一行 JSON（无 pretty-print）
  const line = JSON.stringify(entry) + '\n';
  await appendFile(file, line, { mode: 0o600 });
}

/**
 * GC：清理 30 天前 done / 超过 GC_FAILED_LIMIT 的旧 failed
 *
 * 启动期调一次；或 SyncRunner 周期性调
 *
 * 实现：读全文 → 过滤 → 写回（原子 rename）
 */
export async function gcQueue(): Promise<{ removed: number; remaining: number }> {
  const file = resolveQueuePath();
  if (!existsSync(file)) return { removed: 0, remaining: 0 };

  const all = await loadQueue();
  const cutoff = Date.now() - GC_DONE_AGE_MS;

  // 按 status 分类
  const done: QueueEntry[] = [];
  const failed: QueueEntry[] = [];
  const live: QueueEntry[] = [];
  for (const e of all) {
    if (e.status === 'done' && (e.doneAt ?? 0) < cutoff) {
      done.push(e);
    } else if (e.status === 'failed') {
      failed.push(e);
    } else {
      live.push(e);
    }
  }

  // failed 超过 GC_FAILED_LIMIT → 删最旧的
  if (failed.length > GC_FAILED_LIMIT) {
    failed.sort((a, b) => (a.failedAt ?? 0) - (b.failedAt ?? 0));
    const excess = failed.length - GC_FAILED_LIMIT;
    done.push(...failed.splice(0, excess));
  }

  const toRemove = new Set(done.map((e) => `${e.id}|${e.queuedAt}|${e.status}`));
  const remaining = all.filter((e) => !toRemove.has(`${e.id}|${e.queuedAt}|${e.status}`));

  if (toRemove.size === 0) {
    return { removed: 0, remaining: all.length };
  }

  // 原子写回：写 tmp + rename
  const tmp = `${file}.gc.${process.pid}.${Date.now()}`;
  const lines = remaining.map((e) => JSON.stringify(e)).join('\n') + (remaining.length ? '\n' : '');
  await writeFile(tmp, lines, { mode: 0o600 });
  await rename(tmp, file);
  log.info({ removed: toRemove.size, remaining: remaining.length }, 'queue: gc done');
  return { removed: toRemove.size, remaining: remaining.length };
}
