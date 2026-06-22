/**
 * useBoardActions —— BoardView 顶栏 + 列内创建 wrapper（selectProject / createIssue / undo / redo）
 *
 * 抽出动机：原 BoardView.vue 内 4 个 wrapper 函数共约 50 行，全部调 store + showToast；
 * 抽成 composable 后 BoardView 模板直接接 emit，handler 不再散落。
 *
 * 业务不变（与原 BoardView 实现 1:1）：
 * - selectProject：addProject（已加入过也走同一路径 / 不弹 toast）→ selectProject → router.replace
 *   → loadBoard
 * - createIssueInColumn：调 board.createIssue → 清空 draft → 弹 toast
 * - undoLastMove / redoLastMove：调 board.undoLastMove / redoLastMove → 弹 toast
 *
 * activeProjectId + newIssueDrafts 由 caller 持有（BoardView），本 composable 接住并 closure 引用，
 * 不重复 watch / onMounted，避免 lifecycle hook 重复注册。
 */
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '@renderer/stores/auth';
import { useRepoStore } from '@renderer/stores/repo';
import { useBoardStore } from '@renderer/stores/board';
import { showToast } from '@renderer/lib/toast';
import type { ColumnDto, RepoDto } from '@renderer/types/dto';
import type { ComputedRef } from 'vue';

export interface UseBoardActionsOptions {
  /** 列内新建议题 draft 字典（BoardView 持有，列内 v-model 直接绑） */
  newIssueDrafts: Record<string, string>;
  /** 当前 active project id（由 useBoardBootstrap 暴露，避免重复 watch） */
  activeProjectId: ComputedRef<string | null>;
}

export interface UseBoardActionsReturn {
  selectProject: (r: RepoDto) => Promise<void>;
  createIssueInColumn: (col: ColumnDto) => Promise<void>;
  undoLastMove: () => Promise<void>;
  redoLastMove: () => Promise<void>;
}

export function useBoardActions(options: UseBoardActionsOptions): UseBoardActionsReturn {
  const repo = useRepoStore();
  const auth = useAuthStore();
  const board = useBoardStore();
  const route = useRoute();
  const router = useRouter();

  async function selectProject(r: RepoDto): Promise<void> {
    let project;
    if (!r.isProject) {
      try {
        project = await repo.addProject({ owner: r.owner, name: r.name });
        showToast({ type: 'success', message: '已加入看板' });
      } catch {
        return;
      }
    } else {
      try {
        project = await repo.addProject({ owner: r.owner, name: r.name });
      } catch {
        return;
      }
    }
    if (project) {
      repo.selectProject(project);
      // v1.4 任务 #statusbar-persist:持久化本次选择
      // 静默失败 — selectProject 自身的 IPC 已成功,持久化是 bonus
      void repo.persistLastSelected(r, project, auth.currentGiteaUrl);
    }
    void router.replace({ query: { ...route.query, project: r.fullName } });
    try {
      await board.loadBoard(repo.currentProjectId ?? r.fullName);
    } catch {
      /* error 已存 board.error */
    }
  }
  async function createIssueInColumn(col: ColumnDto): Promise<void> {
    const id = options.activeProjectId.value;
    const title = (options.newIssueDrafts[col.id] ?? '').trim();
    if (!title || !id) return;
    try {
      // v1.4：refBranch 必填，旧路径无分支选择 → 传主分支名兜底
      await board.createIssue({ projectId: id, columnId: col.id, title, refBranch: 'main' });
      options.newIssueDrafts[col.id] = '';
      showToast({ type: 'success', message: '已创建议题' });
    } catch {
      /* error in board.error */
    }
  }
  async function undoLastMove(): Promise<void> {
    const id = options.activeProjectId.value;
    if (!id) return;
    try {
      await board.undoLastMove(id);
      showToast({ type: 'success', message: '已撤销换列' });
    } catch {
      /* error */
    }
  }
  async function redoLastMove(): Promise<void> {
    const id = options.activeProjectId.value;
    if (!id) return;
    try {
      await board.redoLastMove(id);
      showToast({ type: 'success', message: '已重做换列' });
    } catch {
      /* error */
    }
  }

  return {
    selectProject,
    createIssueInColumn,
    undoLastMove,
    redoLastMove,
  };
}
