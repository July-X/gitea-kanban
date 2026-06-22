/**
 * last-updated —— 全局"最近一次成功 IPC 时间" ref
 *
 * 用途（v1.4 polish · offline cache 透明化）：
 * - 离线时 StatusBar 显示"缓存来自 N 分钟前"，让用户知道当前数据有多旧
 * - 在线时 StatusBar 可显示"刚刚 / N 分钟前更新"作为活性指示
 *
 * 为什么放在 lib/ 而不是 store/：
 * - IpcClient（也在 lib/）需要 import 它来在每次成功 IPC 后更新
 * - 如果放在 store/，ipc-client.ts → store/ 会有循环依赖嫌疑
 * - lib/ 是底层基础设施层，store/ 业务层依赖 lib/ 反向不成立
 *
 * 设计：
 * - module-level 单例 ref，整个 renderer 共享
 * - `markUpdated()` 是 setter，封装内部 setter 以避免外部直接写
 *
 * 不做的事：
 * - **不**持久化（重启重置；用户启动期先看到"无更新"直到第一次 IPC）
 * - **不**做节流（每次 IPC 都更新，频率在用户感知之内）
 */
import { ref, type Ref } from 'vue';

/** 最近一次成功 IPC 的 epoch ms（null = 从未成功过） */
export const lastUpdatedAt: Ref<number | null> = ref(null);

/** 在 IpcClient.invoke / invokeNested 成功后调（封装边界一次） */
export function markUpdated(): void {
  lastUpdatedAt.value = Date.now();
}

/**
 * 格式化"最后更新"为人类可读文本
 *
 * 规则：
 * - null → ''（还没数据）
 * - < 1 分钟 → "刚刚"
 * - < 60 分钟 → "N 分钟前"
 * - < 24 小时 → "N 小时前"
 * - ≥ 24 小时 → "N 天前"
 *
 * @param fromMs 通常是 Date.now()，但传参便于测试
 * @param updatedAt epoch ms（默认读 lastUpdatedAt.value）
 */
export function formatLastUpdated(
  fromMs: number = Date.now(),
  updatedAt: number | null = lastUpdatedAt.value,
): string {
  if (updatedAt === null) return '';
  const elapsedMs = fromMs - updatedAt;
  if (elapsedMs < 60_000) return '刚刚';
  const mins = Math.floor(elapsedMs / 60_000);
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}
