/**
 * SyncRunner —— 同步队列后台 worker
 *
 * ADR-0003 Phase 3：
 * - 启动期从 queue.jsonl 恢复 pending/failed 列表
 * - 周期轮询（30s）+ 网络事件驱动（在线时立即跑）
 * - 每条 entry 调 registered op 的 execute（offlineApply 不会在这里用）
 * - 成功 → markEntryDone
 * - 失败 → 累加 attempt，超过 MAX_ATTEMPTS 标 abandoned
 *
 * 边界：
 * - **不**做并发锁（v1 单实例，cron-style 轮询足够）
 * - **不**做优先级（v1 FIFO 足够）
 * - **不**做依赖图（op 独立）
 *
 * 错误处理：
 * - 启动期 crash：loadQueue 抛 → log + 启动失败（必须显式处理 queue 损坏）
 * - 运行时单条 op 失败：标 failed，continue 下一条（**不**让单条 op 失败阻塞队列）
 * - 运行时 op 未注册：标 abandoned（registry 在重启期可能清空）
 */

import { IpcError, IpcErrorCode } from '@shared/errors';
import { pino } from 'pino';

/**
 * 内部独立 pino 实例（同 queue.ts 原因）
 */
const log = pino({ name: 'sync-runner', level: process.env['LOG_LEVEL'] ?? 'info' });
import {
  gcQueue,
  loadQueue,
  markEntryAbandoned,
  markEntryDone,
  markEntryFailed,
  type QueueEntry,
} from './queue.js';
import { getRegisteredOp } from './dispatch.js';

const POLL_INTERVAL_MS = 30 * 1000; // 30s
const MAX_ATTEMPTS = 5;
const RETRY_BACKOFF_BASE_MS = 5 * 1000; // 5s
const RETRY_BACKOFF_MAX_MS = 5 * 60 * 1000; // 5 min

export class SyncRunner {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private inFlight = new Map<string, Promise<void>>();
  private stopped = false;

  /** 内存里的 pending/failed 列表（按 queuedAt 升序） */
  private entries: QueueEntry[] = [];

  /**
   * 启动 runner：
   * 1. loadQueue 恢复
   * 2. gcQueue 清理
   * 3. 立即跑一次（处理上次崩留下的 pending）
   * 4. 起定时器
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopped = false;

    log.info('SyncRunner: starting');
    this.entries = await loadQueue();
    const gc = await gcQueue();
    log.info({ entries: this.entries.length, gc }, 'SyncRunner: queue restored');
    // 启动期立即跑一次
    void this.runOnce();
    // 定时器
    this.timer = setInterval(() => void this.runOnce(), POLL_INTERVAL_MS);
  }

  /**
   * 停 runner（before-quit）
   * 等待 in-flight 完成
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // 等待所有 in-flight 完成
    await Promise.all(this.inFlight.values());
    this.running = false;
    log.info('SyncRunner: stopped');
  }

  /**
   * 触发一次轮询（IPC handler 主动调，e.g. 网络恢复时）
   */
  triggerNow(): void {
    if (this.stopped) return;
    void this.runOnce();
  }

  /**
   * 当前 pending + failed 列表（PreferencesView 待处理面板用）
   */
  listPending(): QueueEntry[] {
    return this.entries.filter(
      (e) => e.status === 'pending' || e.status === 'failed',
    );
  }

  /**
   * 重试一条 failed entry（用户手动重试按钮）
   */
  async retryEntry(id: string): Promise<void> {
    const e = this.entries.find((x) => x.id === id);
    if (!e) return;
    e.attempt = 0; // 重置 attempt
    e.status = 'pending';
    e.lastError = undefined;
    e.failedAt = undefined;
    this.triggerNow();
  }

  /**
   * 放弃一条 entry（用户主动放弃按钮）
   */
  async abandonEntry(id: string): Promise<void> {
    const e = this.entries.find((x) => x.id === id);
    if (!e) return;
    e.status = 'abandoned';
    await markEntryAbandoned(id);
  }

  /**
   * 内部：跑一轮所有 pending/failed
   *
   * 串行执行（v1 单实例，单条 op 失败不影响其他）
   */
  private async runOnce(): Promise<void> {
    if (this.stopped) return;
    const work = this.entries.filter(
      (e) => e.status === 'pending' || e.status === 'failed',
    );
    for (const e of work) {
      if (this.stopped) return;
      // backoff：还没到 retry 时间
      if (e.status === 'failed' && e.failedAt) {
        const delay = this.backoffMs(e.attempt);
        if (Date.now() - e.failedAt < delay) continue;
      }
      await this.runOne(e);
    }
  }

  /**
   * 内部：跑单条 entry
   */
  private async runOne(e: QueueEntry): Promise<void> {
    const handler = getRegisteredOp(e.op);
    if (!handler) {
      log.error({ op: e.op, id: e.id }, 'SyncRunner: op no longer registered, abandoning');
      e.status = 'abandoned';
      await markEntryAbandoned(e.id);
      return;
    }

    e.status = 'in-flight';
    e.attempt += 1;
    const inflight = (async () => {
      try {
        await handler.execute(e.args as never);
        e.status = 'done';
        await markEntryDone(e.id);
        log.info(
          { id: e.id, op: e.op, attempt: e.attempt },
          'SyncRunner: entry done',
        );
      } catch (err) {
        // 注意：e.attempt 已在上面 +1（成功也算 attempt）；这里不重复累加
        e.failedAt = Date.now();
        if (e.attempt >= MAX_ATTEMPTS) {
          e.status = 'abandoned';
          await markEntryAbandoned(e.id);
          log.error(
            { id: e.id, op: e.op, attempt: e.attempt, err: errMsg(err) },
            'SyncRunner: max attempts reached, abandoning',
          );
        } else {
          e.status = 'failed';
          await markEntryFailed(e.id, errMsg(err));
          log.warn(
            { id: e.id, op: e.op, attempt: e.attempt, err: errMsg(err) },
            'SyncRunner: entry failed, will retry',
          );
        }
      } finally {
        this.inFlight.delete(e.id);
      }
    })();
    this.inFlight.set(e.id, inflight);
    await inflight;
  }

  /**
   * 内部：指数退避（5s, 10s, 20s, 40s, 80s, 160s, capped 5min）
   */
  private backoffMs(attempt: number): number {
    return Math.min(
      RETRY_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1),
      RETRY_BACKOFF_MAX_MS,
    );
  }
}

function errMsg(err: unknown): string {
  if (err instanceof IpcError) {
    return `${err.code}: ${err.message}`;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

/** 单例 */
let runnerInstance: SyncRunner | null = null;

export function getSyncRunner(): SyncRunner {
  if (!runnerInstance) {
    runnerInstance = new SyncRunner();
  }
  return runnerInstance;
}

/** 测试用 */
export function _resetSyncRunnerForTest(): void {
  runnerInstance = null;
}

/** 引用 IpcErrorCode 避免 unused（IPC 错误处理用） */
export const _iPC_ERROR_CODE = IpcErrorCode;
