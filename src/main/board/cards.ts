/**
 * 看板卡片业务层（02-architecture.md §5.3.8）
 *
 * 职责：
 * - 7 个 IPC handler 调用的纯业务函数
 * - DB CRUD + 撤销栈 + WIP 限制检查
 * - 卡片 ↔ gitea_refs 关联（INSERT/UPSERT gitea_refs + INSERT card_links）
 *
 * 关键约束（任务 prompt §"关键约束"10 + 11）：
 * - WIP 限制：board.cards.move 必须在事务里检查目标列 cardCount < wipLimit
 *   （wipLimit=null = 无限，跳过检查）
 * - position 用浮点 + 后续 reconcile：create / move / reorder 全走 POSITION_STEP
 * - truncate 行为：v1 暂不实现 reconcile（依赖浮点避免精度碰撞）
 *
 * 业务约束（02 §5.3.8）：
 * - 危险操作（delete）**必须** UI 双确认
 * - linkedCards 来自 card_links JOIN gitea_refs（与 cache/commits 同款）
 *
 * 关联链路：
 *   card_links ──(gitea_ref_id=id)─ gitea_refs
 *   card_links ──(card_id=id)─ cards
 *   gitea_refs 唯一索引：(kind, owner, repo, ref_id)
 *   card_links 唯一索引：(card_id, gitea_ref_id, role)
 *
 *   创建关联：先 UPSERT gitea_refs（按 (kind, owner, repo, ref_id)）→ 拿 ref id → INSERT card_links
 *   → 拿 linkId 返回
 */

import { randomUUID } from 'node:crypto';
import { eq, and, asc, sql, max } from 'drizzle-orm';
import { getDb } from '../cache/sqlite.js';
import { cards } from '../cache/schema/cards.js';
import { cardLinks } from '../cache/schema/cardLinks.js';
import { giteaRefs } from '../cache/schema/giteaRefs.js';
import { boardColumns } from '../cache/schema/boardColumns.js';
import { IpcError, IpcErrorCode } from '@shared/errors';
import type {
  CardDto,
  CardLinkDto,
  CreateBoardCardArgs,
  UpdateBoardCardArgs,
  MoveBoardCardArgs,
  LinkBoardCardArgs,
} from '../ipc/schema.js';
import { recordUndo } from './undo.js';

// ============================================================
// ===== 内部 helper：resolve column =====
function resolveColumn(columnId: string): { boardId: string; projectId: string; wipLimit: number | null } {
  const db = getDb();
  const col = db.select().from(boardColumns).where(eq(boardColumns.id, columnId)).all()[0];
  if (!col) {
    throw new IpcError({
      code: IpcErrorCode.NOT_FOUND,
      message: '目标列不存在',
      hint: '请刷新看板后重试',
    });
  }
  return { boardId: col.boardId, projectId: '', wipLimit: col.wipLimit };
}

function resolveCard(cardId: string): { columnId: string; projectId: string } {
  const db = getDb();
  const card = db.select().from(cards).where(eq(cards.id, cardId)).all()[0];
  if (!card) {
    throw new IpcError({
      code: IpcErrorCode.NOT_FOUND,
      message: '卡片不存在',
      hint: '可能已被删除，请刷新看板',
    });
  }
  return { columnId: card.columnId, projectId: '' };
}

// ============================================================
// ===== 内部 helper：UPSERT gitea_refs + INSERT card_links =====
function upsertGiteaRef(args: {
  kind: 'commit' | 'pr' | 'branch' | 'issue';
  owner: string;
  repo: string;
  refId: string;
  cachedTitle?: string;
}): string {
  const db = getDb();
  const existing = db
    .select()
    .from(giteaRefs)
    .where(
      and(
        eq(giteaRefs.kind, args.kind),
        eq(giteaRefs.owner, args.owner),
        eq(giteaRefs.repo, args.repo),
        eq(giteaRefs.refId, args.refId),
      ),
    )
    .all()[0];

  if (existing) {
    // 刷新 cachedTitle（如提供）+ cachedAt
    const patch: Record<string, unknown> = { cachedAt: new Date() };
    if (args.cachedTitle !== undefined) patch.cachedTitle = args.cachedTitle;
    db.update(giteaRefs).set(patch).where(eq(giteaRefs.id, existing.id)).run();
    return existing.id;
  }

  const id = randomUUID();
  db.insert(giteaRefs)
    .values({
      id,
      kind: args.kind,
      owner: args.owner,
      repo: args.repo,
      refId: args.refId,
      cachedTitle: args.cachedTitle ?? null,
      cachedAt: new Date(),
    })
    .run();
  return id;
}

/** 拿某 card 全部 links（DTO 形态） */
function listCardLinks(cardId: string): CardLinkDto[] {
  const db = getDb();
  const rows = db
    .select({
      linkId: cardLinks.id,
      role: cardLinks.role,
      kind: giteaRefs.kind,
      owner: giteaRefs.owner,
      repo: giteaRefs.repo,
      refId: giteaRefs.refId,
      cachedTitle: giteaRefs.cachedTitle,
    })
    .from(cardLinks)
    .innerJoin(giteaRefs, eq(giteaRefs.id, cardLinks.giteaRefId))
    .where(eq(cardLinks.cardId, cardId))
    .all();
  return rows.map((r) => ({
    id: r.linkId,
    role: r.role as 'reference' | 'blocks' | 'relates-to',
    refKind: r.kind as 'commit' | 'pr' | 'branch' | 'issue',
    owner: r.owner,
    repo: r.repo,
    refId: r.refId,
    ...(r.cachedTitle ? { cachedTitle: r.cachedTitle } : {}),
  }));
}

/** card row → DTO */
function toCardDto(card: typeof cards.$inferSelect, links: CardLinkDto[]): CardDto {
  return {
    id: card.id,
    columnId: card.columnId,
    title: card.title,
    body: card.body ?? undefined,
    position: card.position,
    color: card.color ?? undefined,
    createdAt: (card.createdAt instanceof Date ? card.createdAt : new Date(card.createdAt)).toISOString(),
    updatedAt: (card.updatedAt instanceof Date ? card.updatedAt : new Date(card.updatedAt)).toISOString(),
    links,
  };
}

// ============================================================
// ===== list =====
export function listCards(args: { columnId: string }): CardDto[] {
  const db = getDb();
  // 校验 column 存在
  const col = db.select({ id: boardColumns.id }).from(boardColumns).where(eq(boardColumns.id, args.columnId)).all()[0];
  if (!col) {
    throw new IpcError({
      code: IpcErrorCode.NOT_FOUND,
      message: '列不存在',
    });
  }
  const cardRows = db
    .select()
    .from(cards)
    .where(eq(cards.columnId, args.columnId))
    .orderBy(asc(cards.position))
    .all();
  return cardRows.map((c) => toCardDto(c, listCardLinks(c.id)));
}

// ============================================================
// ===== create =====
export function createCard(args: CreateBoardCardArgs): CardDto {
  const db = getDb();
  // 校验 column 存在
  const col = db.select().from(boardColumns).where(eq(boardColumns.id, args.columnId)).all()[0];
  if (!col) {
    throw new IpcError({
      code: IpcErrorCode.NOT_FOUND,
      message: '目标列不存在',
    });
  }

  const id = randomUUID();
  const now = new Date();

  db.transaction((tx) => {
    // 1. 插 card
    tx.insert(cards)
      .values({
        id,
        columnId: args.columnId,
        title: args.title,
        body: args.body ?? null,
        position: args.position,
        color: args.color ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    // 2. 同步插 card_links（如提供）
    if (args.links && args.links.length > 0) {
      for (const link of args.links) {
        // UPSERT gitea_refs（用 tx 保持一致）
        const refId = (() => {
          const existing = tx
            .select()
            .from(giteaRefs)
            .where(
              and(
                eq(giteaRefs.kind, link.refKind),
                eq(giteaRefs.owner, link.owner),
                eq(giteaRefs.repo, link.repo),
                eq(giteaRefs.refId, link.refId),
              ),
            )
            .all()[0];
          if (existing) {
            const patch: Record<string, unknown> = { cachedAt: now };
            if (link.cachedTitle !== undefined) patch.cachedTitle = link.cachedTitle;
            tx.update(giteaRefs).set(patch).where(eq(giteaRefs.id, existing.id)).run();
            return existing.id;
          }
          const newId = randomUUID();
          tx.insert(giteaRefs)
            .values({
              id: newId,
              kind: link.refKind,
              owner: link.owner,
              repo: link.repo,
              refId: link.refId,
              cachedTitle: link.cachedTitle ?? null,
              cachedAt: now,
            })
            .run();
          return newId;
        })();

        // INSERT card_links（违反 uniq 会抛——重复 link 应在调用方去重）
        tx.insert(cardLinks)
          .values({
            id: randomUUID(),
            cardId: id,
            giteaRefId: refId,
            role: link.role,
            createdAt: now,
          })
          .run();
      }
    }
  });

  // 写撤销栈
  recordUndo({
    op: 'card.create',
    payload: {
      cardId: id,
      before: {},
      after: { columnId: args.columnId, title: args.title, position: args.position, color: args.color ?? null, links: args.links ?? [] },
    },
  });

  // 返回 DTO
  const inserted = db.select().from(cards).where(eq(cards.id, id)).all()[0]!;
  return toCardDto(inserted, listCardLinks(id));
}

// ============================================================
// ===== update =====
export function updateCard(args: UpdateBoardCardArgs): CardDto {
  const db = getDb();
  const existing = db.select().from(cards).where(eq(cards.id, args.cardId)).all()[0];
  if (!existing) {
    throw new IpcError({
      code: IpcErrorCode.NOT_FOUND,
      message: '卡片不存在',
    });
  }
  const before = {
    title: existing.title,
    body: existing.body,
    color: existing.color,
  };
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (args.patch.title !== undefined) patch.title = args.patch.title;
  if (args.patch.body !== undefined) patch.body = args.patch.body;
  if (args.patch.color !== undefined) patch.color = args.patch.color;
  db.update(cards).set(patch).where(eq(cards.id, args.cardId)).run();

  recordUndo({
    op: 'card.update',
    payload: { cardId: args.cardId, before, after: args.patch },
  });

  const refreshed = db.select().from(cards).where(eq(cards.id, args.cardId)).all()[0]!;
  return toCardDto(refreshed, listCardLinks(args.cardId));
}

// ============================================================
// ===== move（**WIP 限制** + 同列 / 跨列）=====
export function moveCard(args: MoveBoardCardArgs): CardDto {
  const db = getDb();

  // 1. 校验：源卡片存在
  const card = db.select().from(cards).where(eq(cards.id, args.cardId)).all()[0];
  if (!card) {
    throw new IpcError({
      code: IpcErrorCode.NOT_FOUND,
      message: '卡片不存在',
    });
  }
  const fromColumnId = card.columnId;
  const toColumnId = args.toColumnId;

  // 2. 校验：目标列存在
  const targetCol = db.select().from(boardColumns).where(eq(boardColumns.id, toColumnId)).all()[0];
  if (!targetCol) {
    throw new IpcError({
      code: IpcErrorCode.NOT_FOUND,
      message: '目标列不存在',
    });
  }

  // 3. WIP 限制检查：仅**跨列**移动时检查（同列重排不计）
  if (fromColumnId !== toColumnId && targetCol.wipLimit !== null) {
    const targetCount = db
      .select({ c: sql<number>`COUNT(${cards.id})`.as('c') })
      .from(cards)
      .where(eq(cards.columnId, toColumnId))
      .all()[0]?.c;
    if (Number(targetCount ?? 0) >= targetCol.wipLimit) {
      throw new IpcError({
        code: IpcErrorCode.CONFLICT,
        message: `目标列已达 WIP 上限（${targetCol.wipLimit} 张）`,
        hint: '请先移走一些卡片，或调整列的 WIP 上限',
        cause: `current=${targetCount ?? 0}, wipLimit=${targetCol.wipLimit}`,
      });
    }
  }

  const before = { columnId: card.columnId, position: card.position };
  const newPosition = args.toPosition;

  db.update(cards)
    .set({ columnId: toColumnId, position: newPosition, updatedAt: new Date() })
    .where(eq(cards.id, args.cardId))
    .run();

  recordUndo({
    op: 'card.move',
    payload: { cardId: args.cardId, before, after: { columnId: toColumnId, position: newPosition } },
  });

  const refreshed = db.select().from(cards).where(eq(cards.id, args.cardId)).all()[0]!;
  return toCardDto(refreshed, listCardLinks(args.cardId));
}

// ============================================================
// ===== delete（**危险操作**）=====
export function deleteCard(args: { cardId: string }): void {
  const db = getDb();
  const existing = db.select().from(cards).where(eq(cards.id, args.cardId)).all()[0];
  if (!existing) {
    throw new IpcError({
      code: IpcErrorCode.NOT_FOUND,
      message: '卡片不存在',
    });
  }
  const beforeLinks = listCardLinks(args.cardId);

  // 事务：先查完整 before → DELETE（card_links 级联删）→ 保留 gitea_refs（其它卡可能还引用）
  db.transaction((tx) => {
    tx.delete(cards).where(eq(cards.id, args.cardId)).run();
  });

  recordUndo({
    op: 'card.delete',
    payload: {
      cardId: args.cardId,
      before: { ...existing, links: beforeLinks },
      after: {},
    },
  });
}

// ============================================================
// ===== link =====
export function linkCard(args: LinkBoardCardArgs): CardLinkDto {
  const db = getDb();
  // 校验 card 存在
  const card = db.select({ id: cards.id }).from(cards).where(eq(cards.id, args.cardId)).all()[0];
  if (!card) {
    throw new IpcError({
      code: IpcErrorCode.NOT_FOUND,
      message: '卡片不存在',
    });
  }

  // UPSERT gitea_refs
  const refId = upsertGiteaRef({
    kind: args.link.refKind,
    owner: args.link.owner,
    repo: args.link.repo,
    refId: args.link.refId,
    ...(args.link.cachedTitle !== undefined ? { cachedTitle: args.link.cachedTitle } : {}),
  });

  // INSERT card_links（uniq 冲突 → CONFLICT）
  const linkId = randomUUID();
  const now = new Date();
  try {
    db.insert(cardLinks)
      .values({
        id: linkId,
        cardId: args.cardId,
        giteaRefId: refId,
        role: args.link.role,
        createdAt: now,
      })
      .run();
  } catch (e) {
    throw new IpcError({
      code: IpcErrorCode.CONFLICT,
      message: '该关联已存在（同 card / ref / role）',
      hint: '请勿重复关联',
      cause: e instanceof Error ? e.message : String(e),
    });
  }

  recordUndo({
    op: 'card.link',
    payload: { linkId, cardId: args.cardId, before: {}, after: { giteaRefId: refId, ...args.link } },
  });

  return {
    id: linkId,
    refKind: args.link.refKind,
    owner: args.link.owner,
    repo: args.link.repo,
    refId: args.link.refId,
    ...(args.link.cachedTitle ? { cachedTitle: args.link.cachedTitle } : {}),
    role: args.link.role,
  };
}

// ============================================================
// ===== unlink =====
export function unlinkCard(args: { linkId: string }): void {
  const db = getDb();
  const existing = db.select().from(cardLinks).where(eq(cardLinks.id, args.linkId)).all()[0];
  if (!existing) {
    throw new IpcError({
      code: IpcErrorCode.NOT_FOUND,
      message: '关联不存在',
    });
  }

  db.delete(cardLinks).where(eq(cardLinks.id, args.linkId)).run();

  recordUndo({
    op: 'card.unlink',
    payload: { linkId: args.linkId, cardId: existing.cardId, before: { ...existing } },
  });
}

// 抑制 unused 警告
void max;
void resolveCard;
void resolveColumn;
