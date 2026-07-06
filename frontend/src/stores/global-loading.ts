/**
 * globalLoading store —— 全局加载态聚合
 *
 * 设计动机：
 *   - 原本每个 view 都有自己的 *.loading 态 + 局部"加载中…"占位
 *   - 现在改"全局 StatusBarPulse"模式：所有远端请求在底部状态栏显示心跳脉冲
 *   - 这个 store 把分散的 *.loading 收口成一个 `visible: boolean`，UI 只订阅一个
 *
 * 状态合并规则：
 *   - active: Set<LoadingNs> 多个 namespace 并发时合并
 *   - 任意一个 ns 是 true → visible = true
 *   - 全部 ns 是 false → visible = false（带 min-show 防快闪）
 *
 * 防抖设计：
 *   - min-show 400ms：避免"请求 200ms 完成"时脉冲已经显示但马上消失
 *
 * 与各 view 局部占位的关系：
 *   - 拍板"替换模式"：删 view 内部"加载中…"占位文字 + RefreshCw spin
 *   - AuthView 的提交按钮 loading 态保留（按钮本身的反馈，不在功能区，不在覆盖范围）
 *   - Toast / ConfirmDialog / ModalOverlay 不在覆盖范围
 */

import { defineStore } from 'pinia';
import { ref } from 'vue';

/** 受控的 loading namespace —— store action 用这个枚举来 register 自己 */
export type LoadingNs =
  | 'auth' // 鉴权 / 连接
  | 'board' // 看板列 + 卡片
  | 'repo' // 仓库列表
  | 'member' // 成员
  | 'branch' // 分支
  | 'pull' // 合并请求
  | 'myCard' // 我的卡片
  | 'merges' // 合并请求详情/评论
  | 'timeline'; // 时间轴

/** 最小展示时长（ms）—— 避免"快闪"，远端请求 < 400ms 也至少展示这么久 */
const MIN_SHOW_MS = 400;



export const useGlobalLoadingStore = defineStore('globalLoading', () => {
  // ===== state =====
  /** 当前活动的 namespace 集合 */
  const active = ref<Set<LoadingNs>>(new Set());
  /** 渲染端订阅的 visible（带 debounce） */
  const visible = ref<boolean>(false);

  // ===== 内部辅助 =====
  let showTimer: ReturnType<typeof setTimeout> | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let showStartAt = 0;

  /** 重新计算 visible
   *
   * 规则：
   *   - active 非空 → 立即 visible=true
   *   - active 空 + visible 已开 → 等到至少展示了 MIN_SHOW_MS 再 visible=false
   *   - active 空 + visible 未开 → 不动（保持 hidden）
   */
  function recompute(): void {
    if (active.value.size > 0) {
      // 取消待执行的 hide（如果还有）
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
      // 立即展示（异步 0ms 让 reactivity 一次性 batch）
      if (!visible.value && !showTimer) {
        showStartAt = Date.now();
        showTimer = setTimeout(() => {
          visible.value = true;
          showTimer = null;
        }, 0);
      }
    } else {
      // active 空了 → 取消 showTimer（如果还没真显示）
      if (showTimer) {
        clearTimeout(showTimer);
        showTimer = null;
      }
      // 已经在显示 → 等到 min-show 满足再 hidden（无 debounce）
      if (visible.value) {
        const elapsed = Date.now() - showStartAt;
        const wait = Math.max(0, MIN_SHOW_MS - elapsed);
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = setTimeout(() => {
          visible.value = false;
          hideTimer = null;
        }, wait);
      }
    }
  }

  // ===== actions =====

  /**
   * 标记 namespace 进入 loading 态
   * 调用方在 *.loading.value = true 之后调
   */
  function show(ns: LoadingNs): void {
    if (active.value.has(ns)) return;
    const next = new Set(active.value);
    next.add(ns);
    active.value = next;
    recompute();
  }

  /**
   * 标记 namespace 退出 loading 态
   * 调用方在 *.loading.value = false 之后调
   */
  function hide(ns: LoadingNs): void {
    if (!active.value.has(ns)) return;
    const next = new Set(active.value);
    next.delete(ns);
    active.value = next;
    recompute();
  }


  return {
    // state
    active,
    visible,
    // actions
    show,
    hide,
  };
});
