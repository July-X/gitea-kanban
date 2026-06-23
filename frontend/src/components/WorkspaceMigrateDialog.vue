<script setup lang="ts">
/**
 * WorkspaceMigrateDialog —— 工作区切换时的仓库迁移对话框
 *
 * 设计：
 *   - 用户切换工作区路径后，如果旧路径下有本地仓库，弹出此对话框
 *   - 选项 1：迁移仓库到新路径（逐个复制，带进度条）
 *   - 选项 2：不迁移，打开旧目录让用户自行处理
 *   - 迁移过程中禁用所有按钮，显示进度
 *   - 迁移完成后显示结果摘要
 */
import { computed, ref, onUnmounted } from 'vue';
import { FolderOpen, Copy, CheckCircle, AlertCircle } from 'lucide-vue-next';
import {
  commitsGitgraphMigrateWorkspace,
  commitsGitgraphOpenDirectory,
  onWorkspaceMigrateProgress,
} from '@renderer/lib/ipc-client';
import { showToast } from '@renderer/lib/toast';

interface RepoInfo {
  name: string;
  fullPath: string;
  sizeBytes: number;
}

interface Props {
  open: boolean;
  repos: RepoInfo[];
  totalSizeBytes: number;
  oldPath: string;
  newPath: string;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'migrated', result: { migratedCount: number; failed: Record<string, string> }): void;
  (e: 'skip'): void;
}>();

// ===== 状态机：idle → migrating → done =====
type Phase = 'idle' | 'migrating' | 'done';
const phase = ref<Phase>('idle');

// 迁移进度
const progressCurrent = ref(0);
const progressTotal = ref(0);
const progressRepoName = ref('');
const progressPhase = ref<'copying' | 'done' | 'error'>('copying');

// 迁移结果
const migrateResult = ref<{ migratedCount: number; failed: Record<string, string> } | null>(null);

// 进度事件 off 函数
let offProgress: (() => void) | null = null;

/** 格式化文件大小 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** 进度百分比 */
const progressPercent = computed(() => {
  if (progressTotal.value === 0) return 0;
  return Math.round((progressCurrent.value / progressTotal.value) * 100);
});

/** 开始迁移 */
async function onMigrate(): Promise<void> {
  phase.value = 'migrating';
  progressCurrent.value = 0;
  progressTotal.value = props.repos.length;

  // 订阅进度事件
  offProgress = onWorkspaceMigrateProgress((payload) => {
    progressCurrent.value = payload.current;
    progressTotal.value = payload.total;
    progressRepoName.value = payload.repoName;
    progressPhase.value = payload.phase;
  });

  try {
    const result = await commitsGitgraphMigrateWorkspace({
      oldCwd: props.oldPath,
      newCwd: props.newPath,
      repoNames: props.repos.map((r) => r.name),
    });
    migrateResult.value = result;
    phase.value = 'done';

    if (result.migratedCount > 0) {
      showToast({
        type: 'success',
        message: `已迁移 ${result.migratedCount} 个仓库`,
        description:
          Object.keys(result.failed).length > 0
            ? `${Object.keys(result.failed).length} 个仓库迁移失败`
            : undefined,
      });
    }
    emit('migrated', result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast({ type: 'error', message: '迁移失败', description: msg });
    phase.value = 'done';
    migrateResult.value = { migratedCount: 0, failed: { _error: msg } };
  }
}

/** 不迁移，打开旧目录 */
async function onSkip(): Promise<void> {
  try {
    await commitsGitgraphOpenDirectory({ path: props.oldPath });
  } catch {
    // 打开失败不阻塞
  }
  emit('skip');
  close();
}

/** 关闭对话框 */
function close(): void {
  emit('update:open', false);
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault();
    if (phase.value !== 'migrating') close();
  }
}

onUnmounted(() => {
  offProgress?.();
});
</script>

<template>
  <Teleport to="body">
    <div v-if="props.open" class="migrate-overlay" role="dialog" aria-modal="true" @keydown="onKeydown">
      <div class="migrate-dialog">
        <!-- 标题 -->
        <header class="migrate-dialog__header">
          <h2 class="migrate-dialog__title">发现已有本地仓库</h2>
        </header>

        <!-- idle 阶段：显示仓库列表 + 两个按钮 -->
        <template v-if="phase === 'idle'">
          <p class="migrate-dialog__desc">
            旧工作区 <code class="mono">{{ props.oldPath }}</code> 下有
            <strong>{{ props.repos.length }}</strong> 个本地仓库（共
            {{ formatSize(props.totalSizeBytes) }}），是否迁移到新工作区？
          </p>

          <div class="migrate-dialog__repo-list">
            <div v-for="repo in props.repos" :key="repo.name" class="migrate-dialog__repo-item">
              <span class="migrate-dialog__repo-name">{{ repo.name }}</span>
              <span class="migrate-dialog__repo-size">{{ formatSize(repo.sizeBytes) }}</span>
            </div>
          </div>

          <footer class="migrate-dialog__footer">
            <button type="button" class="migrate-dialog__btn migrate-dialog__btn--ghost" @click="onSkip">
              <FolderOpen :size="16" />
              不迁移，打开旧目录
            </button>
            <button type="button" class="migrate-dialog__btn migrate-dialog__btn--primary" @click="onMigrate">
              <Copy :size="16" />
              迁移到新工作区
            </button>
          </footer>
        </template>

        <!-- migrating 阶段：进度条 -->
        <template v-if="phase === 'migrating'">
          <p class="migrate-dialog__desc">正在迁移仓库到新工作区…</p>

          <div class="migrate-dialog__progress">
            <div class="migrate-dialog__progress-bar">
              <div
                class="migrate-dialog__progress-fill"
                :style="{ width: `${progressPercent}%` }"
              />
            </div>
            <div class="migrate-dialog__progress-info">
              <span class="migrate-dialog__progress-current">
                {{ progressCurrent }} / {{ progressTotal }}
              </span>
              <span class="migrate-dialog__progress-repo">{{ progressRepoName }}</span>
            </div>
          </div>

          <footer class="migrate-dialog__footer">
            <button type="button" class="migrate-dialog__btn migrate-dialog__btn--ghost" disabled>
              迁移中，请稍候…
            </button>
          </footer>
        </template>

        <!-- done 阶段：结果摘要 -->
        <template v-if="phase === 'done'">
          <div class="migrate-dialog__result">
            <div class="migrate-dialog__result-item migrate-dialog__result-item--success">
              <CheckCircle :size="18" />
              <span>成功迁移 {{ migrateResult?.migratedCount ?? 0 }} 个仓库</span>
            </div>
            <div
              v-if="migrateResult && Object.keys(migrateResult.failed).length > 0"
              class="migrate-dialog__result-item migrate-dialog__result-item--warn"
            >
              <AlertCircle :size="18" />
              <span>{{ Object.keys(migrateResult.failed).length }} 个仓库迁移失败</span>
            </div>
            <div
              v-if="migrateResult?.failed"
              class="migrate-dialog__failed-list"
            >
              <div
                v-for="(reason, name) in migrateResult.failed"
                :key="name"
                class="migrate-dialog__failed-item"
              >
                <code class="mono">{{ name }}</code
                ><span class="migrate-dialog__failed-reason">{{ reason }}</span>
              </div>
            </div>
          </div>

          <footer class="migrate-dialog__footer">
            <button type="button" class="migrate-dialog__btn migrate-dialog__btn--primary" @click="close">
              完成
            </button>
          </footer>
        </template>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.migrate-overlay {
  position: fixed;
  inset: 0;
  background: var(--color-bg-overlay);
  z-index: var(--z-modal-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  animation: fadeIn var(--t-base) var(--ease);
}

.migrate-dialog {
  background: var(--color-bg-elevated);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  padding: var(--space-5);
  min-width: 420px;
  max-width: 520px;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  animation: slideUp var(--t-base) var(--ease);
}

.migrate-dialog__header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.migrate-dialog__title {
  font-size: var(--font-lg);
  font-weight: 600;
  color: var(--color-text);
  margin: 0;
}

.migrate-dialog__desc {
  font-size: var(--font-md);
  color: var(--color-text-secondary);
  line-height: var(--line-relaxed);
  margin: 0;
}

.migrate-dialog__desc code {
  background: var(--color-bg);
  padding: 1px 6px;
  border-radius: 3px;
  font-size: var(--font-sm);
  word-break: break-all;
}

/* 仓库列表 */
.migrate-dialog__repo-list {
  max-height: 200px;
  overflow-y: auto;
  border: 1px solid var(--color-divider);
  border-radius: var(--radius-sm);
  /* v1.6.1 改 --color-bg-elevated（白），跟弹窗主面板同色
   * 旧值 --color-bg (#E8F1F5 浅苍蓝) 跟弹窗白底对比过强 */
  background: var(--color-bg-elevated);
}

.migrate-dialog__repo-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px var(--space-3);
  font-size: var(--font-sm);
  border-bottom: 1px solid var(--color-divider);
}

.migrate-dialog__repo-item:last-child {
  border-bottom: none;
}

.migrate-dialog__repo-name {
  color: var(--color-text);
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: var(--font-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

.migrate-dialog__repo-size {
  color: var(--color-text-muted);
  font-size: var(--font-xs);
  flex-shrink: 0;
  margin-left: var(--space-2);
}

/* 进度条 */
.migrate-dialog__progress {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.migrate-dialog__progress-bar {
  height: 8px;
  background: var(--color-bg);
  border-radius: 4px;
  overflow: hidden;
  border: 1px solid var(--color-divider);
}

.migrate-dialog__progress-fill {
  height: 100%;
  background: var(--color-primary);
  border-radius: 4px;
  transition: width 200ms var(--ease);
}

.migrate-dialog__progress-info {
  display: flex;
  justify-content: space-between;
  font-size: var(--font-xs);
  color: var(--color-text-muted);
}

.migrate-dialog__progress-current {
  font-weight: 600;
  color: var(--color-text);
}

.migrate-dialog__progress-repo {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 200px;
}

/* 结果 */
.migrate-dialog__result {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.migrate-dialog__result-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-md);
  font-weight: 500;
}

.migrate-dialog__result-item--success {
  color: var(--color-success, #7db233);
}

.migrate-dialog__result-item--warn {
  color: var(--color-warning, #f0ad4e);
}

.migrate-dialog__failed-list {
  max-height: 150px;
  overflow-y: auto;
  padding: var(--space-2) var(--space-3);
  /* v1.6.1 改 --color-bg-elevated（白），跟弹窗主面板同色
   * 旧值 --color-bg (#E8F1F5 浅苍蓝) 跟弹窗白底对比过强 */
  background: var(--color-bg-elevated);
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-divider);
}

.migrate-dialog__failed-item {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  font-size: var(--font-xs);
  padding: 3px 0;
}

.migrate-dialog__failed-item code {
  flex-shrink: 0;
  color: var(--color-text);
}

.migrate-dialog__failed-reason {
  color: var(--color-text-muted);
}

/* 按钮 */
.migrate-dialog__footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

.migrate-dialog__btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 8px 16px;
  border-radius: var(--radius-sm);
  font-size: var(--font-md);
  font-weight: 500;
  cursor: pointer;
  min-width: 80px;
  transition:
    background var(--t-fast) var(--ease),
    transform var(--t-fast) var(--ease);
}

.migrate-dialog__btn--ghost {
  background: transparent;
  color: var(--color-text-secondary);
  border: 1px solid var(--color-divider);
}

.migrate-dialog__btn--ghost:hover:not(:disabled) {
  background: var(--color-bg-hover);
  color: var(--color-text);
}

.migrate-dialog__btn--primary {
  background: var(--color-primary);
  color: var(--color-text-inverse);
  border: none;
  /* v1.6 去 v1.1 主色外环 glow · 走单层柔和阴影 */
  box-shadow: var(--shadow-sm);
}

.migrate-dialog__btn--primary:hover:not(:disabled) {
  background: var(--color-primary-hover);
}

.migrate-dialog__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.mono {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes slideUp {
  from { transform: translateY(8px); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}
</style>
