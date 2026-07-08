/**
 * 全局 Toast 状态 + 控制 API
 *
 * 设计：
 *   - 单例 ref（v1 不需要 toast 队列）
 *   - 拆到独立 .ts 文件,让 main.ts 可以 import（.vue SFC 用 <script setup> 时
 *     所有顶层变量只在组件实例上,无法被外部 import）
 *   - Toast.vue 用 import { toast, showToast, dismissToast } from './toast' 订阅
 *
 * v1.4 增强（P0-1 autoInit 透明化落地 · v1.4 智能化）：
 *   - ToastState 加 `actions?: ToastAction[]` 字段，Toast.vue 渲染成按钮
 *   - 按钮点击后调 onClick，可选传 `dismissAfter: false` 不关闭 toast
 *   - body 部分不再 @click 关闭（避免误触），只 × 按钮 + action 按钮关闭
 *   - 设计：actions 是**可选**扩展字段，老 caller 不传照常工作
 */
import { ref } from 'vue';
import { AlertCircle, AlertTriangle, CheckCircle2, Info, type LucideIcon } from 'lucide-vue-next';
import { logWarn, logError } from './frontend-log';

export type ToastType = 'success' | 'info' | 'warn' | 'error';

export interface ToastAction {
  /** 按钮文字（短，2-6 字） */
  label: string;
  /** 点击回调 */
  onClick: () => void | Promise<void>;
  /**
   * 是否在点击后自动关闭 toast
   * - true（默认）= 按钮点了就关（绝大多数场景）
   * - false = 点了不关（如"展开看详情"）
   */
  dismissAfter?: boolean;
  /**
   * 视觉变体
   * - 'primary'（默认）= 主色（用于"打开列设置"等主推操作）
   * - 'ghost' = 透明边框（用于"不再提示"等次要操作）
   */
  variant?: 'primary' | 'ghost';
}

export interface ToastState {
  type: ToastType;
  message: string;
  description?: string;
  duration: number;
  /** true = 不自动消失，必须用户点击关闭（用于错误提示） */
  persistent?: boolean;
  /** v1.4 新增：操作按钮（最多 2 个，第 3+ 被忽略） */
  actions?: ToastAction[];
}

export const toast = ref<ToastState | null>(null);

let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * showToast —— 全局提示
 *
 * duration：
 *   - 0 或 undefined = 用默认（success=3000ms，error=persistent）
 *   - 正数 = 多少毫秒后自动消失
 *   - 负数 = 不自动消失
 *
 * persistent（推荐用这个）：true = 必须用户点击关闭（用于错误/重要提示）
 *
 * 设计原则：错误**不**应自动消失（用户可能错过）
 *  - 业务错（"评审人不能是组织"、"无权限"）→ 用户需要知道**为什么失败 + 怎么修**
 *  - 系统错（网络断开、500）→ 用户需要**决定**重试时机
 * success 是 3s 自动消失（轻量提示，确认"做完了"）
 */
export function showToast(
  state: Omit<ToastState, 'duration'> & {
    duration?: number;
    persistent?: boolean;
    actions?: ToastAction[];
  },
): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const isPersistent = state.persistent === true;
  // error 类型默认 persistent（除非显式传 duration）
  const defaultDuration = isPersistent ? -1 : state.type === 'error' ? -1 : 3000;
  const duration = state.duration ?? defaultDuration;
  // v1.4：actions 最多 2 个（P0-1 wireframe 设计就是 2 个"打开列设置"+"不再提示"）
  const actions = state.actions?.slice(0, 2);
  toast.value = {
    type: state.type,
    message: state.message,
    ...(state.description !== undefined ? { description: state.description } : {}),
    duration,
    persistent: duration < 0,
    ...(actions && actions.length > 0 ? { actions } : {}),
  };
  if (toast.value.duration > 0) {
    timer = setTimeout(() => {
      toast.value = null;
    }, toast.value.duration);
  }

  // 写日志：warn / error 级别的 toast 都进文件日志，方便用户反馈问题排查
  //   - success / info 不写（克隆成功、列变更这些高频低价值提示会爆文件）
  //   - description 可能很长（包含 cause、httpStatus 等诊断信息）—— 写全文
  //   - source 标记 'toast' 方便 grep
  //   - logWarn / logError fire-and-forget，不阻塞 UI
  if (state.type === 'warn') {
    logWarn('toast', state.message, state.description);
  } else if (state.type === 'error') {
    logError('toast', state.message, state.description);
  }
}

export function dismissToast(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  toast.value = null;
}

export const TOAST_ICONS: Record<ToastType, LucideIcon> = {
  success: CheckCircle2,
  info: Info,
  warn: AlertTriangle,
  error: AlertCircle,
};
