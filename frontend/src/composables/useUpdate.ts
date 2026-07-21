/**
 * useUpdate.ts —— 前端自动更新 composable
 *
 * v0.8.0 引入。管理 update 状态机，封装 CheckUpdate / DownloadUpdate / InstallUpdate /
 * OpenDownloadPage 4 个 Wails binding 的调用。
 *
 * 设计目标：
 *   - 状态机明确（idle / checking / upToDate / available / downloading / verifying /
 *     downloaded / installing / error），便于 UI 组件简单分支渲染
 *   - 订阅 Wails 进度事件 'updater:progress' → 自动映射到 status.received/total
 *   - 单一实例（singleton）共享给 UpdateBanner + SettingsView
 *   - 非阻塞（click handler 立即返回，async void 模式）符合 AGENTS §14.1 性能规范
 *
 * 零术语：UI 文案走"发现新版本" / "下载" / "重启以安装"，内部 manifest/signature/canary
 * 等概念不外泄。
 */

import { ref, computed, onUnmounted } from 'vue';
import type {
  UpdateInfo,
  UpdateDownloadResult,
  UpdateProgress,
} from '@renderer/types/dto';

// ---------- 类型 ----------

export type UpdateStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'upToDate'; current: string }
  | { kind: 'available'; info: UpdateInfo }
  | { kind: 'downloading'; info: UpdateInfo; received: number; total: number }
  | { kind: 'verifying'; info: UpdateInfo }
  | { kind: 'downloaded'; info: UpdateInfo }
  | { kind: 'installing' }
  | { kind: 'done' }
  | { kind: 'devBuild' }
  | { kind: 'error'; message: string };

// ---------- Singleton 状态 ----------

const status = ref<UpdateStatus>({ kind: 'idle' });
const eventUnsub: { current: (() => void) | null } = { current: null };

// ---------- 平台 API 适配 ----------

// Wails 生成的 bindings（路径：frontend/wailsjs/wailsjs/go/main/App）
interface WailsBindings {
  Version(): Promise<string>;
  CheckUpdate(): Promise<UpdateInfo | null>;
  DownloadUpdate(): Promise<UpdateDownloadResult | null>;
  InstallUpdate(): Promise<void>;
  OpenDownloadPage(): Promise<void>;
}

function getBindings(): WailsBindings | null {
  // 优先走 wailsjs 注入的 window.go.main.App
  const w = window as any;
  if (w?.go?.main?.App) {
    return w.go.main.App as WailsBindings;
  }
  // 回退走 shim（开发期 hot reload 时可能未注入）
  const api = (w as any).api;
  if (api?.updater) {
    return api.updater as WailsBindings;
  }
  return null;
}

function getRuntime() {
  const w = window as any;
  // Wails v2 runtime
  return w?.runtime;
}

// ---------- 进度事件订阅 ----------

function subscribeProgress(onProgress: (p: UpdateProgress) => void): () => void {
  const rt = getRuntime();
  if (!rt?.EventsOn) {
    return () => {};
  }
  rt.EventsOn('updater:progress', onProgress);
  return () => {
    try {
      rt.EventsOff?.('updater:progress');
    } catch (_e) {
      // 忽略：EventsOff 在某些 Wails 版本可能不存在
    }
  };
}

// ---------- Composable ----------

export function useUpdate() {
  /**
   * 检查更新（异步，不抛异常给 UI）
   */
  async function check(): Promise<void> {
    status.value = { kind: 'checking' };
    const b = getBindings();
    if (!b) {
      status.value = { kind: 'error', message: '更新模块未初始化' };
      return;
    }
    try {
      const info = await b.CheckUpdate();
      if (!info) {
        status.value = { kind: 'error', message: '检查更新失败' };
        return;
      }
      if (info.devBuild) {
        status.value = { kind: 'devBuild' };
        return;
      }
      if (info.err) {
        // 网络错误静默降级（不打扰用户）
        status.value = { kind: 'upToDate', current: info.current };
        return;
      }
      if (!info.available) {
        status.value = { kind: 'upToDate', current: info.current };
        return;
      }
      status.value = { kind: 'available', info };
    } catch (e: any) {
      status.value = { kind: 'error', message: e?.message ?? '检查更新失败' };
    }
  }

  /**
   * 下载更新
   */
  async function download(): Promise<void> {
    const cur = status.value;
    if (cur.kind !== 'available' && cur.kind !== 'downloading') {
      return;
    }
    const info = cur.info;
    const b = getBindings();
    if (!b) {
      status.value = { kind: 'error', message: '更新模块未初始化' };
      return;
    }

    status.value = { kind: 'downloading', info, received: 0, total: info.assetSize ?? 0 };

    // 订阅进度事件
    const unsub = subscribeProgress((p: UpdateProgress) => {
      const cur2 = status.value;
      if (cur2.kind === 'downloading' || cur2.kind === 'verifying') {
        if (p.phase === 'verifying') {
          status.value = { kind: 'verifying', info };
        } else if (p.phase === 'error') {
          status.value = { kind: 'error', message: p.err ?? '下载失败' };
        } else if (cur2.kind === 'downloading') {
          status.value = {
            kind: 'downloading',
            info,
            received: p.received,
            total: p.total || cur2.total,
          };
        }
      }
    });

    try {
      const result = await b.DownloadUpdate();
      unsub();
      if (!result) {
        status.value = { kind: 'error', message: '下载失败' };
        return;
      }
      status.value = { kind: 'downloaded', info };
    } catch (e: any) {
      unsub();
      const msg = String(e?.message ?? e ?? '');
      // 手动更新路径的预期错误
      if (msg.includes('manual update only') || msg.includes('macOS')) {
        status.value = { kind: 'available', info: { ...info, manualOnly: true } };
        return;
      }
      status.value = { kind: 'error', message: msg || '下载失败' };
    }
  }

  /**
   * 安装更新（macOS 未签名 build 应走 OpenDownloadPage 而非 Install）
   */
  async function install(): Promise<void> {
    const cur = status.value;
    if (cur.kind !== 'downloaded') {
      return;
    }
    const b = getBindings();
    if (!b) {
      status.value = { kind: 'error', message: '更新模块未初始化' };
      return;
    }
    status.value = { kind: 'installing' };
    try {
      await b.InstallUpdate();
      // 多数情况下 applyWindows 末尾 os.Exit(0)，走不到这里
      status.value = { kind: 'done' };
    } catch (e: any) {
      const msg = String(e?.message ?? e ?? '');
      if (msg.includes('manual update only')) {
        // macOS 未签名 build：fallback 到 OpenDownloadPage
        await openDownloadPage();
        return;
      }
      status.value = { kind: 'error', message: msg || '安装失败' };
    }
  }

  /**
   * 打开浏览器到 release 页（macOS 未签名 build 的主要路径）
   */
  async function openDownloadPage(): Promise<void> {
    const b = getBindings();
    if (!b) {
      status.value = { kind: 'error', message: '更新模块未初始化' };
      return;
    }
    try {
      await b.OpenDownloadPage();
    } catch (e: any) {
      status.value = { kind: 'error', message: e?.message ?? '打开页面失败' };
    }
  }

  /**
   * 关闭 banner（用户点"稍后提醒"）
   */
  function dismiss(): void {
    if (
      status.value.kind === 'available' ||
      status.value.kind === 'downloaded'
    ) {
      const info = status.value.info;
      status.value = { kind: 'upToDate', current: info.current };
    }
  }

  // 自动订阅 / 卸载
  if (!eventUnsub.current) {
    eventUnsub.current = subscribeProgress(() => {
      /* global handler 也保留一份（避免某些场景下 useUpdate 实例多次创建）*/
    });
  }
  onUnmounted(() => {
    if (eventUnsub.current) {
      eventUnsub.current();
      eventUnsub.current = null;
    }
  });

  return {
    status: computed(() => status.value),
    check,
    download,
    install,
    openDownloadPage,
    dismiss,
  };
}

// ---------- helpers ----------

/**
 * 格式化字节数（B / KB / MB / GB）。
 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
