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
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useAuthStore } from '@renderer/stores/auth';
import { showToast } from '@renderer/lib/toast';
import {
  pullsCommentReactionAdd,
  pullsCommentReactionRemove,
  pullsCommentReactionsList,
} from '@renderer/lib/ipc-client';
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

const reactions = ref<ReactionDto[]>([]);
const loading = ref(false);
const showPicker = ref(false);
const toggling = ref(false);

const currentUsername = computed<string | null>(() => auth.currentUser?.login ?? null);

/** 按表情类型聚合 */
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
    g.count++;
    g.usernames.push(r.user.username);
    if (currentUsername.value && r.user.username === currentUsername.value) {
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
    if (currentUsername.value && r.user.username === currentUsername.value) {
      set.add(r.content);
    }
  }
  return set;
});

async function loadReactions(): Promise<void> {
  loading.value = true;
  try {
    const list = await pullsCommentReactionsList({
      projectId: props.projectId,
      commentId: props.commentId,
    });
    reactions.value = (list ?? []) as ReactionDto[];
  } catch {
    // 失败不报 toast（reaction 是 nice-to-have，不应打断主流程）
  } finally {
    loading.value = false;
  }
}

/** Toggle 单个表情 */
async function toggleReaction(content: ReactionContent): Promise<void> {
  if (toggling.value || !props.editable) return;
  const hasReacted = viewerReactedContents.value.has(content);

  // 乐观更新
  const snapshot = [...reactions.value];
  if (hasReacted) {
    reactions.value = reactions.value.filter(
      (r) => !(r.content === content && r.user.username === currentUsername.value),
    );
  } else {
    reactions.value = [
      ...reactions.value,
      {
        id: -1, // 临时 id；拉取后会被覆盖
        content,
        user: { username: currentUsername.value ?? '' },
      },
    ];
  }

  toggling.value = true;
  try {
    if (hasReacted) {
      await pullsCommentReactionRemove({
        projectId: props.projectId,
        commentId: props.commentId,
        content,
      });
    } else {
      const added = await pullsCommentReactionAdd({
        projectId: props.projectId,
        commentId: props.commentId,
        content,
      });
      // 用服务端返回的权威 reaction 替换临时项
      reactions.value = reactions.value.map((r) =>
        r.id === -1 && r.content === content ? (added as ReactionDto) : r,
      );
    }
    showPicker.value = false;
  } catch {
    // 回滚
    reactions.value = snapshot;
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
