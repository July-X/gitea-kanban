/**
 * 全局 Toast 状态 + 控制 API
 *
 * 设计：
 *   - 单例 ref（v1 不需要 toast 队列）
 *   - 拆到独立 .ts 文件,让 main.ts 可以 import（.vue SFC 用 <script setup> 时
 *     所有顶层变量只在组件实例上,无法被外部 import）
 *   - Toast.vue 用 import { toast, showToast, dismissToast } from './toast' 订阅
 */
import { ref } from 'vue';
import { AlertCircle, AlertTriangle, CheckCircle2, Info, type LucideIcon } from 'lucide-vue-next';

export type ToastType = 'success' | 'info' | 'warn' | 'error';

export interface ToastState {
  type: ToastType;
  message: string;
  description?: string;
  duration: number;
  /** true = 不自动消失，必须用户点击关闭（用于错误提示） */
  persistent?: boolean;
}

export const toast = ref<ToastState | null>(null);

let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * showToast —— 全局提示
 *
 * duration：
 *   - 0 或 undefined = 用默认 3000ms
 *   - 正数 = 多少毫秒后自动消失
 *   - 负数 = 不自动消失
 *
 * persistent（推荐用这个）：true = 必须用户点击关闭（用于错误/重要提示）
 */
export function showToast(state: Omit<ToastState, 'duration'> & { duration?: number; persistent?: boolean }): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const isPersistent = state.persistent === true;
  toast.value = {
    type: state.type,
    message: state.message,
    ...(state.description !== undefined ? { description: state.description } : {}),
    duration: state.duration ?? (isPersistent ? -1 : 3000),
    persistent: isPersistent,
  };
  if (toast.value.duration > 0) {
    timer = setTimeout(() => {
      toast.value = null;
    }, toast.value.duration);
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
