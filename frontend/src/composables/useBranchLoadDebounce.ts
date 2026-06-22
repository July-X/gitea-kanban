/**
 * useBranchLoadDebounce —— 分支切换防抖 composable
 *
 * 用途：用户快速点击多个 branch chip 时，避免每次都立即触发 `loadTimeline` IPC。
 * 把多次 schedule 调用合并为最后一次 + delayMs 之后的一次 loadFn。
 *
 * API 形态对照 TimelineView.vue 的旧实现（line 126-160）：
 * - `schedule(delayMs?)`  ⇔  原 `scheduleLoadTimeline(delayMs?)`
 * - `flush()`              ⇔  原 `loadTimeline()` 直接调用（绕过防抖 + 取消 pending）
 * - `cancel()`             ⇔  原 `if (loadTimelineTimer) clearTimeout(...)` 块
 * - `hasPending()`         ⇔  原 `loadTimelineTimer !== null` 的判定
 *
 * 行为不变性：
 * - schedule 重置 timer + 延迟 delayMs 调 loadFn
 * - flush 立即调 loadFn，并清掉任何 pending timer（与原 loadTimeline line 133-136 等价）
 * - cancel 仅清 timer，**不**调 loadFn（与 toggleBranch 空集合分支等价）
 *
 * 设计动机：纯 JS + setTimeout，不依赖 Vue ref/reactive，因此**不**需要挂载组件即可单测。
 *
 * 不做的事：
 * - **不**暴露 loadFn 引用（保持封装）
 * - **不**记 lastArgs（commit 单参调度不需要）
 */
export interface BranchLoadDebounce {
  /** 调度一次防抖调用（覆盖之前 pending 的，默认 250ms） */
  schedule: (delayMs?: number) => void;
  /** 立即调 loadFn 并清掉 pending timer —— 用于 refresh() / 主动拉取场景 */
  flush: () => Promise<void>;
  /** 取消 pending 调用 —— 不调 loadFn（toggleBranch 空集合分支用） */
  cancel: () => void;
  /** 当前是否有 pending timer（toggleBranch 判空前会查） */
  hasPending: () => boolean;
}

export function useBranchLoadDebounce(
  loadFn: () => Promise<void>,
  defaultDelayMs = 250,
): BranchLoadDebounce {
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  return {
    schedule(delayMs?: number): void {
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        void loadFn();
      }, delayMs ?? defaultDelayMs);
    },
    async flush(): Promise<void> {
      clearTimer();
      await loadFn();
    },
    cancel(): void {
      clearTimer();
    },
    hasPending(): boolean {
      return timer !== null;
    },
  };
}
