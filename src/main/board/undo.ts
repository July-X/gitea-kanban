/**
 * 撤销栈（undo_entries 表）写入 helper
 *
 * 契约：02-architecture.md §4.2 (undo_entries) + §5.3.9 (user.undo/redo)
 *
 * 背景与边界：
 * - 撤销栈是 v1 看板"危险操作"+"日常写操作"都需要的"应用内栈"（02 §2.7.5 撤销友好）
 * - 实际"撤销 LIFO 弹出 + 反向操作"由 user.undo IPC 实现（02 §5.3.9）
 *   —— 但 user.undo IPC schema **不在** 本 task 范围（任务 prompt §"撤销栈 (user.undo)"）
 * - 本文件**只**负责"被各 IPC handler 调，把 op+payload 写进 undo_entries"
 *
 * v1 临时决策（worker 拍板，需要 task 4 / orchestrator 二次 review）：
 * - 02 §5.3.9 的 user.undo **不**接收 userId 入参 —— 意味着 v1 存在"默认用户"概念
 * - 但 `users` 表 v1 没有公开 IPC（auth.status 只读 gitea_accounts，**不**维护 users 行）
 * - 解法：本文件**懒 seed** 一个固定 userId 的默认用户；所有 undo_entries 都写到这个 user
 * - 这个 user**不**是真实 gitea 登录用户（auth.status 走 keychain），是"本机"v1 占位
 * - 后续 task 4 实现 user.undo IPC 时，由 orchestrator 决定：
 *   - 方案 A：维持默认用户，user.undo 按默认 userId LIFO 弹
 *   - 方案 B：把 auth.connect 改造为"sync seed users 行"，user.undo 按 gitea 登录用户
 *   - 方案 C：把 user.undo 入参加 userId 参数
 * - 任一方案都**不**影响本文件的 `recordUndo(op, payload)` 函数签名
 *
 * 业务约束（02 §5.3.7 + §5.3.8）：
 * - 所有卡片 / 列的写操作都必须在事务结束前 recordUndo
 * - 失败的写操作**不**写 undo_entries
 * - payload 是 JSON 字符串（schema 要求 text 列）
 * - 写操作本身不返回 undoEntryId 给前端（user.undo 弹出时再查）
 *
 * 栈容量：
 * - 02 §2.7.5 拍板"最近 20 步"——recordUndo 写完后**触发**裁剪，超出 20 删最早的
 * - 不开窗裁剪（防 LIFO 顺序错乱），按 userId + createdAt DESC 排序保留最新 20 条
 */

import { randomUUID } from 'node:crypto';
import { eq, and, desc, sql } from 'drizzle-orm';
import { getDb } from '../cache/sqlite.js';
import { undoEntries } from '../cache/schema/undoEntries.js';
import { users } from '../cache/schema/users.js';
import { logger } from '../logger.js';

/** v1 默认用户 ID（固定 UUID，懒 seed，跨 session 稳定） */
const DEFAULT_USER_ID = '00000000-0000-4000-8000-000000000000';
const DEFAULT_USER_DISPLAY_NAME = 'local-user';
/** 02 §2.7.5 拍板"最近 20 步" */
const UNDO_STACK_MAX = 20;

/** 写操作对应的 op 标识（02 §4.2 undoEntries.op 注释 + 任务 prompt §board.*） */
export type UndoOp =
  | 'col.create'
  | 'col.update'
  | 'col.reorder'
  | 'col.delete'
  | 'card.create'
  | 'card.update'
  | 'card.move'
  | 'card.delete'
  | 'card.link'
  | 'card.unlink';

/** undo 栈 payload（按 op 类型分支） */
export type UndoPayload =
  | { columnId: string; before: Record<string, unknown>; after: Record<string, unknown> }
  | { cardId: string; before: Record<string, unknown>; after: Record<string, unknown> }
  | { projectId: string; beforeOrder: string[]; afterOrder: string[] }
  | { linkId: string; cardId: string; before: Record<string, unknown> }
  | Record<string, unknown>;

/** 内部：lazy seed 默认用户（idempotent） */
let defaultUserSeeded = false;
function ensureDefaultUser(): string {
  const db = getDb();
  if (!defaultUserSeeded) {
    const existing = db.select().from(users).where(eq(users.id, DEFAULT_USER_ID)).all()[0];
    if (!existing) {
      db.insert(users)
        .values({
          id: DEFAULT_USER_ID,
          displayName: DEFAULT_USER_DISPLAY_NAME,
          createdAt: new Date(),
        })
        .run();
    }
    defaultUserSeeded = true;
  }
  return DEFAULT_USER_ID;
}

/**
 * 写一条 undo_entries 记录
 *
 * 用法（IPC handler 内）：
 *   const result = db.transaction((tx) => {
 *     tx.update(cards).set(...).where(...).run();
 *     recordUndoInTx(tx, 'card.move', { cardId, before, after });
 *   });
 *
 * 当前实现是"非事务"版本（每个 IPC handler 自己开事务）——
 * 写操作已经在 Drizzle 事务里完成时，**不能**再开一个新事务嵌套（SQLite 不支持）；
 * 所以本函数**不**自动包事务，由 caller 决定。
 */
export function recordUndo(args: { op: UndoOp; payload: UndoPayload }): void {
  const userId = ensureDefaultUser();
  const db = getDb();
  const now = new Date();

  db.insert(undoEntries)
    .values({
      id: randomUUID(),
      userId,
      op: args.op,
      payload: JSON.stringify(args.payload),
      createdAt: now,
    })
    .run();

  if (logger.isLevelEnabled('debug')) {
    logger.debug({ op: args.op, userId }, 'undo entry recorded');
  }

  // 裁剪栈：保留最近 20 条
  pruneUndoStack(userId);
}

/**
 * 裁剪 undo_entries 栈，保留最近 UNDO_STACK_MAX 条
 *
 * 用 raw SQL 一次性删（drizzle 的 inArray 也能干但更啰嗦）：
 *   DELETE FROM undo_entries
 *   WHERE user_id = ?
 *     AND id NOT IN (
 *       SELECT id FROM undo_entries
 *       WHERE user_id = ?
 *       ORDER BY created_at DESC
 *       LIMIT ?
 *     )
 */
function pruneUndoStack(userId: string): void {
  const db = getDb();
  // 拿保留集合的 id
  const keepIds = db
    .select({ id: undoEntries.id })
    .from(undoEntries)
    .where(eq(undoEntries.userId, userId))
    .orderBy(desc(undoEntries.createdAt))
    .limit(UNDO_STACK_MAX)
    .all()
    .map((r) => r.id);

  if (keepIds.length <= UNDO_STACK_MAX) {
    // 删多余（不在 keepIds 里的）
    db.delete(undoEntries)
      .where(and(eq(undoEntries.userId, userId), sql`${undoEntries.id} NOT IN (${sql.join(keepIds.map((id) => sql`${id}`), sql`, `)})`))
      .run();
  }
}

/**
 * 内部：test 用 —— 重置 defaultUserSeeded 标志（每个 test 独立 DB 都要重置）
 */
export function _resetDefaultUserSeededForTest(): void {
  defaultUserSeeded = false;
}
