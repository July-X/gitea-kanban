<script setup lang="ts">
/**
 * ColumnMenu —— 列设置弹窗（plan_25cc4562 Task D · BoardView 重构）
 *
 * 设计（v1.1 + v1.3 · Task B）：
 * - 改名 + 设 WIP 上限（合一个"保存"按钮，title/wip 各自独立 dirty 判断）
 * - 显示已绑 label 列表（chip 形式）+ 解绑 + "+ 绑定 gitea 标签"入口
 * - 删列按钮（独立操作 → 触发 confirm dialog）
 *
 * v1.4 增强（P0-2 列 = label UI 标注落地 · plan_25cc4562 Task C）：
 * - 加 `unmatchedCount: number` props（v1.4 默认 0；v1.5 接 autoInit 升级版后传真实值）
 * - "未归类" banner 区：v1.4 提示文案占位，v1.5 接两个 CTA（"再建几列" / "塞进待办"）
 * - 边界：v1.4 **不**碰 board store，**不**新增 IPC，**不**加 wireframe 里说的"批量建列向导"
 *   （向导涉及 cluster 逻辑，是 P0-2 wireframe 后续 v1.5 增量）
 *
 * 通信：props + emit（不直接调 store）
 *   - props.open          : 是否打开
 *   - props.column        : 当前列（v1 一次只编辑一列；null = 关闭态）
 *   - props.editingTitle  : 父组件维护的"输入中"列名（双向同步）
 *   - props.editingWipLimit : 父组件维护的"输入中"WIP 上限（字符串态，解析在父）
 *   - props.isWipInvalid  : 当前输入是否非法（父组件判定后传回）
 *   - props.isDirty       : 是否有字段变更（父组件判定后传回）
 *   - props.bindingLabel  : 正在绑 label 时的 loading 态
 *   - props.unmatchedCount: 当前仓库还有 N 个 gitea label 未归类（v1.4 默认 0）
 *   - emit('update:open')        : 关闭弹窗
 *   - emit('update:editingTitle') : 列名输入
 *   - emit('update:editingWipLimit') : WIP 输入
 *   - emit('save')               : 点保存（父组件处理 IPC）
 *   - emit('request-delete')     : 删列按钮
 *   - emit('unbind-label', id)   : 解绑 label
 *   - emit('open-bind-label')    : 打开"绑 label picker"
 *   - emit('open-batch-create')  : 打开"批量建列"向导（v1.5 增量，v1.4 占位）
 *   - emit('bind-unmatched-to-current') : 把未匹配 label 绑到当前列（v1.5 增量，v1.4 占位）
 */
import { Trash2, X } from 'lucide-vue-next';
import type { ColumnDto } from '@renderer/types/dto';

interface Props {
  open: boolean;
  column: ColumnDto | null;
  editingTitle: string;
  editingWipLimit: string;
  isWipInvalid: boolean;
  isDirty: boolean;
  bindingLabel: boolean;
  /**
   * v1.4 P0-2：当前仓库还有 N 个 gitea label 未归类
   *  - 可选 prop（v1.4 BoardView 不传，v1.5 接 board store 真实值后必传）
   *  - 默认 0：v1.4 兜底（不显示 banner）
   *  - 类型标记 `unmatchedCount?: number`（**不**标必填）→ Vue dev mode 不报 "Missing required prop"
   *  - 运行时 withDefaults 兜底：忘记传时拿 0，不影响 banner v-if 判断
   *  - v1.5 接 autoInitBreakdown 时，BoardView 从 board store 拿值显式传入
   */
  unmatchedCount?: number;
}

const props = withDefaults(defineProps<Props>(), {
  unmatchedCount: 0,
});

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'update:editingTitle', value: string): void;
  (e: 'update:editingWipLimit', value: string): void;
  (e: 'save'): void;
  (e: 'request-delete'): void;
  (e: 'unbind-label', labelId: number): void;
  (e: 'open-bind-label'): void;
  (e: 'open-batch-create'): void;
  (e: 'bind-unmatched-to-current'): void;
}>();

function close(): void {
  emit('update:open', false);
}
</script>

<template>
  <Teleport to="body">
    <div v-if="props.open" class="modal-overlay" @click.self="close">
      <div
        class="modal"
        role="dialog"
        aria-modal="true"
        :aria-label="'设置列 ' + (props.column ? props.column.title : '')"
      >
        <header class="modal__header">
          <h2 class="modal__title">设置列</h2>
          <button type="button" class="modal__close" :aria-label="'关闭'" @click="close">
            <X :size="16" :stroke-width="2" />
          </button>
        </header>
        <div class="modal__body">
          <label class="modal__label" for="edit-col-title">列名</label>
          <input
            id="edit-col-title"
            :value="props.editingTitle"
            type="text"
            class="modal__input"
            maxlength="32"
            @input="(e) => emit('update:editingTitle', (e.target as HTMLInputElement).value)"
            @keydown.enter="emit('save')"
          />
          <!-- v1.3（plan_25cc4562 · Task B）：WIP 上限输入
            *  - 留空 = 无限
            *  - 正整数 = 上限；超限只警告不拦截
            *  - 0 / 负数 / 浮点 → 输入框红色 + 保存按钮 disabled（避免无效值落到后端） -->
          <label class="modal__label" for="edit-col-wip-limit">WIP 上限</label>
          <input
            id="edit-col-wip-limit"
            :value="props.editingWipLimit"
            type="text"
            inputmode="numeric"
            class="modal__input"
            :class="{ 'modal__input--invalid': props.isWipInvalid }"
            placeholder="留空 = 无限"
            maxlength="6"
            @input="(e) => emit('update:editingWipLimit', (e.target as HTMLInputElement).value)"
            @keydown.enter="emit('save')"
          />
          <p class="modal__hint muted">
            <template v-if="props.isWipInvalid">
              请输入正整数（≥1），或留空表示无限
            </template>
            <template v-else>
              建议同时进行中的议题数；超限会标红提醒，但允许继续添加
            </template>
          </p>
          <div class="modal__sub">
            <p class="modal__sub-title">已绑定的标签</p>
            <div
              v-if="props.column && props.column.labels && props.column.labels.length"
              class="modal__chip-list"
            >
              <span
                v-for="lab in props.column.labels"
                :key="lab.id"
                class="modal__chip"
                :style="{ '--label-color': lab.color || '#888' }"
              >
                <span class="modal__chip-dot" />
                <span class="modal__chip-name">{{ lab.name }}</span>
                <button
                  type="button"
                  class="modal__chip-rm"
                  :title="'解绑 ' + lab.name"
                  :aria-label="'解绑标签 ' + lab.name"
                  @click="emit('unbind-label', lab.id)"
                >
                  ×
                </button>
              </span>
            </div>
            <p v-else class="muted modal__empty">还没绑标签</p>
            <button
              type="button"
              class="modal__btn modal__btn--ghost modal__btn--block"
              @click="emit('open-bind-label')"
            >
              + 绑定 gitea 标签
            </button>
          </div>
          <!--
            v1.4 P0-2：未归类 gitea label 提示
            - 触发条件：unmatchedCount > 0
            - v1.4：仅占位 banner，CTA 按钮 disabled（v1.5 接 board store 真实值后再开放）
            - v1.5：CTA 1 = "再建几列"（走向导），CTA 2 = "塞进待办"（一键绑当前列）
            - 设计原因：让 user 在列设置里"看见"还有 label 没归类，**不**藏在 toast 里（toast 会被关）
          -->
          <div v-if="props.unmatchedCount > 0" class="modal__unmatched">
            <p class="modal__unmatched-title">
              ⚠ 仓库还有 {{ props.unmatchedCount }} 个 gitea 标签没归类
            </p>
            <div class="modal__unmatched-actions">
              <button
                type="button"
                class="modal__btn modal__btn--primary"
                disabled
                :title="'v1.5 增量：批量建列向导'"
                @click="emit('open-batch-create')"
              >
                再建几列
              </button>
              <button
                type="button"
                class="modal__btn modal__btn--ghost"
                disabled
                :title="'v1.5 增量：把未匹配 label 绑到当前列'"
                @click="emit('bind-unmatched-to-current')"
              >
                塞进当前列
              </button>
            </div>
            <p class="modal__unmatched-hint muted">
              v1.5 接入 autoInit 升级版后开放（详见 P0-1 wireframe 场景 3）
            </p>
          </div>
        </div>
        <footer class="modal__footer">
          <button
            type="button"
            class="modal__btn modal__btn--danger"
            :aria-label="'删除此列 ' + (props.column ? props.column.title : '')"
            @click="emit('request-delete')"
          >
            <Trash2 :size="14" :stroke-width="2" />
            <span>删除此列</span>
          </button>
          <div class="modal__footer-right">
            <button type="button" class="modal__btn modal__btn--ghost" @click="close">取消</button>
            <button
              type="button"
              class="modal__btn modal__btn--primary"
              :disabled="props.isWipInvalid || !props.isDirty || !props.editingTitle.trim()"
              @click="emit('save')"
            >
              保存
            </button>
          </div>
        </footer>
      </div>
    </div>
  </Teleport>
</template>
