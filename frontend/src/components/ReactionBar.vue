<script setup lang="ts">
/**
 * ReactionBar —— 评论表情反应条（v0.5.0 M2）
 *
 * 设计（AGENTS §6.3 零术语 + §8.3 错误提示人话）：
 *   - 展示评论的所有 reaction 分组（emoji + 计数 + 当前用户是否已点）
 *   - 每个 reaction 单条：可 toggle（已点变灰 / 未点可添加）
 *   - "+" 按钮 —— emoji 下拉托盘（受支持 8 种表情）
 *   - 服务端数据驱动：初始化 pullsCommentReactionsList 拉取
 *   - toggle 乐观更新：先改 UI 再发请求，失败回滚
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useAuthStore } from '@renderer/stores/auth';
import { usePullStore } from '@renderer/stores/pull';
import { showToast } from '@renderer/lib/toast';
import type { ReactionContent, ReactionDto, ReactionGroupDto } from '@renderer/types/dto';

// ===== 受支持的 8 种表情（对齐 Gitea / GitHub） =====
const REACTIONS: { content: ReactionContent; emoji: string; label: string }[] = [
  { content: '+1', emoji: '👍', label: '赞同' },
  { content: '-1', emoji: '👎', label: '反对' },
  { content: 'laugh', emoji: '😄', label: '笑脸' },
  { content: 'confused', emoji: '😕', label: '困惑' },
  { content: 'heart', emoji: '❤️', label: '喜爱' },
  { content: 'hooray', emoji: '🎉', label: '庆祝' },
  { content: 'eyes', emoji: '👀', label: '关注' },
  { content: 'rocket', emoji: '🚀', label: '火箭' },
];

const props = defineProps<{
  projectId: string;
  commentId: number;
  /** 是否允许操作（closed/merged 的 PR 不支持 reaction） */
  editable?: boolean;
}>();

const auth = useAuthStore();
const pull = usePullStore();

/** v0.7.26：reactions 改为从 store 读（reactive）
 *
 * 之前：local ref + 自己的 loadReactions 主动拉 + 乐观更新。
 * 跟 MergesView 的 addCommentReaction handler（不通过 ReactionBar 直接调 store action）
 * 流程不联动 → store action 调完 IPC 后 UI 不刷新。
 *
 * 现在：store 维护 reactionsByComment 缓存，store action 调完 IPC 后
 * fetchCommentReactions 重拉写回缓存，组件 computed 读 store 拿最新值。
 *
 * ReactionBar 仍保留 toggleReaction 用于"已有 reaction 单击 toggle"流程，
 * 但内部走 store.addCommentReaction / store.removeCommentReaction 走同一路径。
 */
const reactions = computed<ReactionDto[]>(
  () => pull.reactionsByComment.get(props.commentId) ?? [],
);
const loading = ref(false);
const showPicker = ref(false);
const toggling = ref(false);

const currentUsername = computed<string | null>(() => auth.currentUser?.login ?? null);

/** 按表情类型聚合
 *
 * 防御性处理 r.user 可能为 null/undefined 的情况（Gitea ReactionDTO.User 是指针，
 * 理论上始终非 nil，但 Wails JSON 序列化在网络异常或低版本 Gitea 下可能产出 null）。
 * 如果不防御，r.user.username 直接 TypeError → computed 崩溃 → 整条 ReactionBar 不显示。
 */
const groupedReactions = computed<ReactionGroupDto[]>(() => {
  const map = new Map<ReactionContent, ReactionGroupDto>();
  for (const c of REACTIONS) {
    map.set(c.content, {
      content: c.content,
      emoji: c.emoji,
      label: c.label,
      count: 0,
      usernames: [],
      viewerReacted: false,
    });
  }
  for (const r of reactions.value) {
    const g = map.get(r.content);
    if (!g) continue;
    const username = r?.user?.username ?? '';
    g.count++;
    g.usernames.push(username);
    if (currentUsername.value && username === currentUsername.value) {
      g.viewerReacted = true;
    }
  }
  // 只返回 count > 0 的 + viewer 已点的（保持 toggle 状态）
  return [...map.values()].filter((g) => g.count > 0);
});

/** 当前用户已点的 reaction content 集合 */
const viewerReactedContents = computed<Set<ReactionContent>>(() => {
  const set = new Set<ReactionContent>();
  for (const r of reactions.value) {
    const username = r?.user?.username ?? '';
    if (currentUsername.value && username === currentUsername.value) {
      set.add(r.content);
    }
  }
  return set;
});

async function loadReactions(): Promise<void> {
  // 防御：projectId 为空时直接跳过（activeProjectId 在 PR 列表加载完前可能为 null）
  if (!props.projectId || props.commentId <= 0) return;
  loading.value = true;
  try {
    // v0.7.26：走 store.fetchCommentReactions，写入 reactionsByComment 缓存
    // reactions computed 直接从 store 读，store 变化触发 UI 重渲染
    await pull.fetchCommentReactions(null, props.commentId);
  } catch {
    // 失败不报 toast（reaction 是 nice-to-have，不应打断主流程）
  } finally {
    loading.value = false;
  }
}

/** Toggle 单个表情
 *
 * v0.7.26：走 store action（统一入口，addCommentReaction / removeCommentReaction
 * 内部会调完 IPC 后 fetchCommentReactions 重拉 store 缓存）
 */
async function toggleReaction(content: ReactionContent): Promise<void> {
  if (toggling.value || !props.editable) return;
  const hasReacted = viewerReactedContents.value.has(content);

  toggling.value = true;
  try {
    if (hasReacted) {
      await pull.removeCommentReaction(null, props.commentId, content);
    } else {
      await pull.addCommentReaction(null, props.commentId, content);
    }
    showPicker.value = false;
  } catch {
    showToast({ type: 'error', message: '操作失败，请重试' });
  } finally {
    toggling.value = false;
  }
}

function onPickerClickOutside(e: MouseEvent): void {
  const target = e.target as HTMLElement;
  if (!target.closest('.reaction-bar')) {
    showPicker.value = false;
  }
}

onMounted(() => {
  void loadReactions();
  document.addEventListener('click', onPickerClickOutside);
});

onUnmounted(() => {
  document.removeEventListener('click', onPickerClickOutside);
});

// projectId / commentId 变化时重新加载（切换仓库或 PR 时组件可能被复用）
watch(
  () => [props.projectId, props.commentId],
  () => { void loadReactions(); },
);
</script>

<template>
  <div class="reaction-bar">
    <!-- 已有的 reaction 列表 -->
    <button
      v-for="g in groupedReactions"
      :key="g.content"
      type="button"
      class="reaction-bar__chip"
      :class="{ 'reaction-bar__chip--active': g.viewerReacted }"
      :disabled="toggling || !editable"
      :title="`${g.label}：${g.usernames.join('、')}`"
      @click.stop="toggleReaction(g.content)"
    >
      <span class="reaction-bar__emoji">{{ g.emoji }}</span>
      <span class="reaction-bar__count">{{ g.count }}</span>
    </button>

    <!-- 添加反应按钮 -->
    <div v-if="editable" class="reaction-bar__picker-wrap">
      <button
        type="button"
        class="reaction-bar__add"
        :class="{ 'reaction-bar__add--open': showPicker }"
        title="添加表情"
        @click.stop="showPicker = !showPicker"
      >
        <span aria-hidden="true">＋</span>
      </button>
      <div v-if="showPicker" class="reaction-bar__dropdown" @click.stop>
        <button
          v-for="r in REACTIONS"
          :key="r.content"
          type="button"
          class="reaction-bar__option"
          :title="r.label"
          @click.stop="toggleReaction(r.content)"
        >
          <span class="reaction-bar__option-emoji">{{ r.emoji }}</span>
          <span class="reaction-bar__option-label">{{ r.label }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.reaction-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
  margin-top: 4px;
}

.reaction-bar__chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 6px;
  height: 22px;
  border: 1px solid var(--color-border);
  border-radius: 11px;
  background: var(--color-bg-subtle);
  font-size: var(--font-xs);
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}

.reaction-bar__chip:hover:not(:disabled) {
  background: var(--color-bg-hover);
  border-color: var(--color-primary-softer);
}

.reaction-bar__chip--active {
  background: var(--color-primary-softer);
  border-color: var(--color-primary);
}

.reaction-bar__chip:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.reaction-bar__emoji {
  font-size: 12px;
  line-height: 1;
}

.reaction-bar__count {
  font-size: var(--font-xs);
  color: var(--color-text);
  min-width: 8px;
  text-align: center;
}

.reaction-bar__picker-wrap {
  position: relative;
}

.reaction-bar__add {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: 1px dashed var(--color-border);
  border-radius: 11px;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 14px;
  cursor: pointer;
  transition: all 0.15s;
}

.reaction-bar__add:hover {
  border-color: var(--color-primary);
  color: var(--color-primary);
  background: var(--color-primary-softer);
}

.reaction-bar__dropdown {
  position: absolute;
  bottom: calc(100% + 4px);
  left: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  z-index: 10;
  min-width: 120px;
}

.reaction-bar__option {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border: none;
  background: transparent;
  cursor: pointer;
  border-radius: var(--radius-xs);
  transition: background 0.1s;
}

.reaction-bar__option:hover {
  background: var(--color-bg-hover);
}

.reaction-bar__option-emoji {
  font-size: 14px;
  line-height: 1;
  width: 18px;
  text-align: center;
}

.reaction-bar__option-label {
  font-size: var(--font-xs);
  color: var(--color-text);
}
</style>
