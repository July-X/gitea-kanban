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
export function showToast(state: Omit<ToastState, 'duration'> & { duration?: number; persistent?: boolean }): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const isPersistent = state.persistent === true;
  // error 类型默认 persistent（除非显式传 duration）
  const defaultDuration = isPersistent ? -1 : (state.type === 'error' ? -1 : 3000);
  const duration = state.duration ?? defaultDuration;
  toast.value = {
    type: state.type,
    message: state.message,
    ...(state.description !== undefined ? { description: state.description } : {}),
    duration,
    persistent: duration < 0,
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
