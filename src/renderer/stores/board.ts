/**
 * board store —— 看板列 + 卡片
 *
 * 设计（AGENTS §5.2 + 03-frontend §4.5）：
 *   - 列从 board.columns.list 拉（按 projectId 拉所有列）
 *   - 卡片按列懒加载（board.cards.list 单列）
 *   - 拖拽：移动卡片用 board.cards.move；本地先乐观更新 + 失败回滚
 *   - **不**做跨 project 看板切换缓存（每次切 project 重新拉）
 */

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import {
  boardCardsCreate,
  boardCardsDelete,
  boardCardsList,
  boardCardsMove,
  boardColumnsList,
} from '@renderer/lib/ipc-client';
import type { UserFacingError } from '@renderer/lib/ipc-client';
import type { CardDto, ColumnDto, CreateBoardCardArgs, MoveBoardCardArgs } from '../../main/ipc/schema.js';

export const useBoardStore = defineStore('board', () => {
  // ===== state =====
  const columns = ref<ColumnDto[]>([]);
  const cardsByColumn = ref<Record<string, CardDto[]>>({});
  const loading = ref(false);
  const loadingCards = ref<Set<string>>(new Set());
  const error = ref<UserFacingError | null>(null);
  /** 记录上一次加载的 projectId，避免切 project 残留旧数据 */
  const currentProjectId = ref<string | null>(null);

  // ===== getters =====
  /** 所有卡片总数（跨列累加） */
  const totalCards = computed(() =>
    Object.values(cardsByColumn.value).reduce((sum, arr) => sum + arr.length, 0),
  );
  /** 取某列卡片（按 position 升序） */
  function cardsOf(columnId: string): CardDto[] {
    return cardsByColumn.value[columnId] ?? [];
  }
  /** 找某个卡片所在列 id */
  function findCardColumnId(cardId: string): string | null {
    for (const [colId, cards] of Object.entries(cardsByColumn.value)) {
      if (cards.some((c) => c.id === cardId)) return colId;
    }
    return null;
  }

  // ===== actions =====

  /**
   * 加载某 project 的所有列 + 拉每列的卡片
   */
  async function loadBoard(projectId: string): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const cols = (await boardColumnsList({ projectId })) as ColumnDto[];
      columns.value = cols;
      cardsByColumn.value = {};
      currentProjectId.value = projectId;
      // 并行拉每列卡片（受 main 端 gitea API 速率限制，量小没事）
      const byCol: Record<string, CardDto[]> = {};
      await Promise.all(
        cols.map(async (col) => {
          const cards = (await boardCardsList({ columnId: col.id })) as CardDto[];
          byCol[col.id] = cards;
        }),
      );
      cardsByColumn.value = byCol;
    } catch (e) {
      error.value = e as UserFacingError;
      throw e;
    } finally {
      loading.value = false;
    }
  }

  /**
   * 单独刷新某列的卡片（删除/移动/新建后调）
   */
  async function refreshColumn(columnId: string): Promise<void> {
    loadingCards.value.add(columnId);
    try {
      const cards = (await boardCardsList({ columnId })) as CardDto[];
      cardsByColumn.value = { ...cardsByColumn.value, [columnId]: cards };
    } catch (e) {
      error.value = e as UserFacingError;
      throw e;
    } finally {
      loadingCards.value.delete(columnId);
    }
  }

  /**
   * 新建卡片
   */
  async function createCard(args: Omit<CreateBoardCardArgs, 'position'> & { position?: number }): Promise<CardDto> {
    error.value = null;
    try {
      const card = (await boardCardsCreate({
        columnId: args.columnId,
        title: args.title,
        ...(args.body !== undefined ? { body: args.body } : {}),
        position: args.position ?? (cardsOf(args.columnId).length),
        ...(args.color !== undefined ? { color: args.color } : {}),
        ...(args.links !== undefined ? { links: args.links } : {}),
      })) as CardDto;
      // 追加到本地（不动其他列）
      const existing = cardsByColumn.value[card.columnId] ?? [];
      cardsByColumn.value = { ...cardsByColumn.value, [card.columnId]: [...existing, card] };
      return card;
    } catch (e) {
      error.value = e as UserFacingError;
      throw e;
    }
  }

  /**
   * 移动卡片（**乐观更新** + 失败回滚）
   */
  async function moveCard(args: MoveBoardCardArgs): Promise<void> {
    const fromColumnId = findCardColumnId(args.cardId);
    if (!fromColumnId) {
      throw {
        code: 'not_found',
        messageText: '找不到内容：卡片已不存在',
        hint: '请刷新看板',
        recoverable: false,
      } satisfies UserFacingError;
    }
    const card = cardsByColumn.value[fromColumnId]!.find((c) => c.id === args.cardId);
    if (!card) {
      throw {
        code: 'not_found',
        messageText: '找不到内容：卡片已不存在',
        hint: '请刷新看板',
        recoverable: false,
      } satisfies UserFacingError;
    }
    // 乐观更新：先在本地移动
    const fromList = (cardsByColumn.value[fromColumnId] ?? []).filter((c) => c.id !== args.cardId);
    const toList = [...(cardsByColumn.value[args.toColumnId] ?? [])];
    const movedCard: CardDto = { ...card, columnId: args.toColumnId, position: args.toPosition };
    toList.splice(args.toPosition, 0, movedCard);
    cardsByColumn.value = {
      ...cardsByColumn.value,
      [fromColumnId]: fromList,
      [args.toColumnId]: toList,
    };
    // 调 main 端
    try {
      await boardCardsMove(args);
    } catch (e) {
      // 失败回滚
      cardsByColumn.value = {
        ...cardsByColumn.value,
        [fromColumnId]: [...(cardsByColumn.value[fromColumnId] ?? []), card],
        [args.toColumnId]: (cardsByColumn.value[args.toColumnId] ?? []).filter((c) => c.id !== args.cardId),
      };
      error.value = e as UserFacingError;
      throw e;
    }
  }

  /**
   * 删除卡片（**危险操作**——UI 必须二次确认后再调）
   */
  async function deleteCard(cardId: string): Promise<void> {
    const fromColumnId = findCardColumnId(cardId);
    if (!fromColumnId) return; // 已经被删了
    const card = cardsByColumn.value[fromColumnId]!.find((c) => c.id === cardId);
    // 乐观移除
    const before = cardsByColumn.value[fromColumnId] ?? [];
    cardsByColumn.value = {
      ...cardsByColumn.value,
      [fromColumnId]: before.filter((c) => c.id !== cardId),
    };
    try {
      await boardCardsDelete({ cardId });
    } catch (e) {
      // 回滚
      cardsByColumn.value = {
        ...cardsByColumn.value,
        [fromColumnId]: [...(cardsByColumn.value[fromColumnId] ?? []), card!].filter(
          (c): c is CardDto => Boolean(c),
        ),
      };
      error.value = e as UserFacingError;
      throw e;
    }
  }

  function clearError(): void {
    error.value = null;
  }

  return {
    // state
    columns,
    cardsByColumn,
    loading,
    loadingCards,
    error,
    currentProjectId,
    // getters
    totalCards,
    cardsOf,
    findCardColumnId,
    // actions
    loadBoard,
    refreshColumn,
    createCard,
    moveCard,
    deleteCard,
    clearError,
  };
});
