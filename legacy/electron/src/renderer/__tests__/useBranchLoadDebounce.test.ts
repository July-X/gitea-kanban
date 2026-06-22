/**
 * useBranchLoadDebounce 单元测试（M9-task-1）
 *
 * 测试目标：
 * - schedule 1 次 → 250ms 后 loadFn 调 1 次
 * - 250ms 内连续 schedule 3 次 → loadFn 调 1 次（debounce 合并）
 * - 250ms 后再 schedule → 独立调（不合并跨周期）
 * - cancel → 250ms 后 loadFn 0 次
 * - flush → 立即调 loadFn 1 次，且清掉 pending timer
 * - delayMs 自定义参数（构造 default + 单次 override）
 *
 * 环境选择：node env + vi.useFakeTimers()（不挂载 Vue 组件，composable 纯 JS）
 * - happy-dom/jsdom 都未安装 → 不引入新依赖
 * - vi fake timers 是 vitest 推荐的 debounce 测试模式，确定性 + 零 polyfill
 * - @vue/test-utils 会强制挂载组件，composable 不需要响应式状态（无 ref/reactive）→ 跳过
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useBranchLoadDebounce } from '@renderer/composables/useBranchLoadDebounce';

describe('useBranchLoadDebounce（M9-task-1 分支切换防抖）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('schedule 1 次 → 250ms 后 loadFn 调 1 次', async () => {
    const loadFn = vi.fn().mockResolvedValue(undefined);
    const debounce = useBranchLoadDebounce(loadFn);

    debounce.schedule();
    expect(loadFn).not.toHaveBeenCalled();
    expect(debounce.hasPending()).toBe(true);

    await vi.advanceTimersByTimeAsync(250);
    expect(loadFn).toHaveBeenCalledTimes(1);
    expect(debounce.hasPending()).toBe(false);
  });

  it('250ms 内连续 schedule 3 次 → loadFn 调 1 次（debounce 合并）', async () => {
    const loadFn = vi.fn().mockResolvedValue(undefined);
    const debounce = useBranchLoadDebounce(loadFn);

    debounce.schedule();
    await vi.advanceTimersByTimeAsync(100);
    debounce.schedule();
    await vi.advanceTimersByTimeAsync(100);
    debounce.schedule();
    await vi.advanceTimersByTimeAsync(100);
    // 累计 300ms 但每次 schedule 重置 → 仍未触发
    expect(loadFn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(250);
    expect(loadFn).toHaveBeenCalledTimes(1);
  });

  it('250ms 后再 schedule → 独立触发（不合并跨周期）', async () => {
    const loadFn = vi.fn().mockResolvedValue(undefined);
    const debounce = useBranchLoadDebounce(loadFn);

    debounce.schedule();
    await vi.advanceTimersByTimeAsync(250);
    expect(loadFn).toHaveBeenCalledTimes(1);

    debounce.schedule();
    await vi.advanceTimersByTimeAsync(250);
    expect(loadFn).toHaveBeenCalledTimes(2);
  });

  it('cancel → 250ms 后 loadFn 0 次', async () => {
    const loadFn = vi.fn().mockResolvedValue(undefined);
    const debounce = useBranchLoadDebounce(loadFn);

    debounce.schedule();
    expect(debounce.hasPending()).toBe(true);

    debounce.cancel();
    expect(debounce.hasPending()).toBe(false);

    await vi.advanceTimersByTimeAsync(250);
    expect(loadFn).not.toHaveBeenCalled();
  });

  it('flush → 立即调 loadFn 1 次', async () => {
    const loadFn = vi.fn().mockResolvedValue(undefined);
    const debounce = useBranchLoadDebounce(loadFn);

    await debounce.flush();
    expect(loadFn).toHaveBeenCalledTimes(1);
    expect(debounce.hasPending()).toBe(false);
  });

  it('flush 取消 pending timer（避免 refresh() 触发 + 250ms 后又被触发）', async () => {
    const loadFn = vi.fn().mockResolvedValue(undefined);
    const debounce = useBranchLoadDebounce(loadFn);

    debounce.schedule();
    await debounce.flush();
    expect(loadFn).toHaveBeenCalledTimes(1);

    // 250ms 后 pending 不应该再触发（这是 refresh() 防双触发的关键路径）
    await vi.advanceTimersByTimeAsync(250);
    expect(loadFn).toHaveBeenCalledTimes(1);
  });

  it('自定义 defaultDelayMs（构造参数）', async () => {
    const loadFn = vi.fn().mockResolvedValue(undefined);
    const debounce = useBranchLoadDebounce(loadFn, 500);

    debounce.schedule();
    await vi.advanceTimersByTimeAsync(250);
    expect(loadFn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(250);
    expect(loadFn).toHaveBeenCalledTimes(1);
  });

  it('schedule 单次 delayMs 覆盖 defaultDelayMs', async () => {
    const loadFn = vi.fn().mockResolvedValue(undefined);
    const debounce = useBranchLoadDebounce(loadFn, 500);

    debounce.schedule(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(loadFn).toHaveBeenCalledTimes(1);
  });
});
