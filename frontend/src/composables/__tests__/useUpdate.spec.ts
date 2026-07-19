import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useUpdate, formatBytes } from '@renderer/composables/useUpdate';
import { ref, nextTick } from 'vue';
import type { UpdateInfo } from '@renderer/types/dto';

// Mock Wails bindings
function setupMockBindings(overrides: Partial<{
  CheckUpdate: () => Promise<UpdateInfo | null>;
  DownloadUpdate: () => Promise<any>;
  InstallUpdate: () => Promise<void>;
  OpenDownloadPage: () => Promise<void>;
}> = {}) {
  const mock = {
    Version: vi.fn(async () => 'v0.8.0'),
    CheckUpdate: overrides.CheckUpdate ?? vi.fn(async () => ({
      available: false,
      current: 'v0.8.0',
      latest: 'v0.8.0',
      channel: 'stable',
      canSelfUpdate: false,
      downloaded: false,
    })),
    DownloadUpdate: overrides.DownloadUpdate ?? vi.fn(async () => null),
    InstallUpdate: overrides.InstallUpdate ?? vi.fn(async () => undefined),
    OpenDownloadPage: overrides.OpenDownloadPage ?? vi.fn(async () => undefined),
  };
  (window as any).go = { main: { App: mock } };
  (window as any).runtime = { EventsOn: vi.fn(), EventsOff: vi.fn() };
  return mock;
}

describe('useUpdate composable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete (window as any).go;
    delete (window as any).runtime;
  });

  it('check() transitions to upToDate when no update available', async () => {
    setupMockBindings({
      CheckUpdate: vi.fn(async () => ({
        available: false,
        current: 'v0.8.0',
        latest: 'v0.8.0',
        channel: 'stable',
        canSelfUpdate: false,
        downloaded: false,
      })),
    });
    const { check, status } = useUpdate();
    await check();
    expect(status.value.kind).toBe('upToDate');
    expect((status.value as any).current).toBe('v0.8.0');
  });

  it('check() transitions to available when newer version', async () => {
    setupMockBindings({
      CheckUpdate: vi.fn(async () => ({
        available: true,
        current: 'v0.7.0',
        latest: 'v0.8.0',
        notes: 'release',
        channel: 'stable',
        canSelfUpdate: true,
        manualOnly: false,
        downloaded: false,
        downloadUrl: 'https://example.com/asset',
        assetSize: 1234,
      })),
    });
    const { check, status } = useUpdate();
    await check();
    expect(status.value.kind).toBe('available');
    expect((status.value as any).info.latest).toBe('v0.8.0');
  });

  it('check() transitions to error when bindings missing', async () => {
    // 不调 setupMockBindings → window.go 为 undefined
    const { check, status } = useUpdate();
    await check();
    expect(status.value.kind).toBe('error');
    expect((status.value as any).message).toContain('更新模块未初始化');
  });

  it('check() silent downgrade on err field (网络错误不打扰)', async () => {
    setupMockBindings({
      CheckUpdate: vi.fn(async () => ({
        available: false,
        current: 'v0.8.0',
        latest: '',
        channel: 'stable',
        canSelfUpdate: false,
        downloaded: false,
        err: 'network timeout',
      })),
    });
    const { check, status } = useUpdate();
    await check();
    expect(status.value.kind).toBe('upToDate');
  });

  it('dismiss() transitions available/downloaded → upToDate', async () => {
    setupMockBindings({
      CheckUpdate: vi.fn(async () => ({
        available: true,
        current: 'v0.7.0',
        latest: 'v0.8.0',
        channel: 'stable',
        canSelfUpdate: true,
        downloaded: false,
      })),
    });
    const { check, dismiss, status } = useUpdate();
    await check();
    expect(status.value.kind).toBe('available');
    dismiss();
    expect(status.value.kind).toBe('upToDate');
    expect((status.value as any).current).toBe('v0.7.0');
  });

  it('download() falls back to manual on macOS unsigned build', async () => {
    setupMockBindings({
      CheckUpdate: vi.fn(async () => ({
        available: true,
        current: 'v0.7.0',
        latest: 'v0.8.0',
        channel: 'stable',
        canSelfUpdate: false,
        manualOnly: false,
        downloaded: false,
      })),
      DownloadUpdate: vi.fn(async () => {
        throw new Error('update:manual update only: macOS build 未签名');
      }),
    });
    const { check, download, status } = useUpdate();
    await check();
    expect(status.value.kind).toBe('available');
    await download();
    // 应 fallback 到 manual 模式
    expect(status.value.kind).toBe('available');
    expect((status.value as any).info.manualOnly).toBe(true);
  });
});

describe('formatBytes', () => {
  it('formats bytes correctly', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB');
  });

  it('handles decimal places', () => {
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 * 1024 * 5.5)).toBe('5.5 MB');
  });
});
