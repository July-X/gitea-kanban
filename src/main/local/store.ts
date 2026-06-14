/**
 * LocalStore —— electron-store 之上的一层包装
 * (touch v5)
 *
 * 为什么不直接用 electron-store：
 * 1. `store.store` getter 每次访问从磁盘读（v1 IPC 大量是同步风格，IO 不可接受）
 * 2. schema 选项会拉起 ajv 121 KB（v1 校验统一走 Zod，重复）
 * 3. 没有批量 set 节流（每次写一行都 fsync，IO 抖动）
 *
 * 本类承担：
 * - 启动期一次 readFile + JSON.parse，之后 mutate 内存
 * - mutate() 标 dirty，触发 debounce 100ms flush
 * - 写盘 = writeFile(tmp) + rename(tmp, real) 原子写
 * - 失败：log + 把内存 dirty 状态保留（下次 flush 重试）
 *
 * 边界（AGENTS §5.1 / ADR-0003 Phase 1）：
 * - **不**做 schema 校验（Zod 在 IPC 边界做）
 * - **不**做并发锁（v1 主进程单写者；v2 多窗口时再引 atomically）
 * - **不**做多 store 抽象（一个 app 一个 state.json，1 个单例）
 *
 * 错误处理（Phase 1 双写期）：
 * - load 失败：throw —— 启动期不应当失败（数据目录是白名单）
 * - flush 失败：log error，**不**抛 —— 调用方（IPC handler）已写完 SQLite，localStore 是 best-effort
 * - mutate 期间崩：dirty 状态丢失，下次启动从磁盘 reload（最多丢 100ms 内未 flush 的变更）
 */

import { writeFile, readFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join, isAbsolute } from 'node:path';
import os from 'node:os';
import { pino } from 'pino';

/** debounce 间隔：100ms（任务 prompt §性能 + 实测 IPC handler 平均间隔） */
const FLUSH_DEBOUNCE_MS = 100;

/** 写盘失败时重试间隔（指数退避上限） */
const FLUSH_RETRY_MAX_MS = 5000;

/**
 * 内部独立 pino 实例
 *
 * 为什么不用 src/main/logger.ts：logger.ts 顶层 import `electron.app`，
 * vitest 在 Node 环境下跑会炸（app is undefined）。localStore 是纯 JS 模块，
 * 必须能在 Node 测试环境跑。日志独立到 stderr，prod 走 pino 同源。
 */
const log = pino({ name: 'local-store', level: process.env['LOG_LEVEL'] ?? 'info' });

export class LocalStore<T extends object> {
  private cache: T | null = null;
  private dirty = false;
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing = false;
  private retryDelay = 0;
  private readonly file: string;
  private readonly defaults: T;

  constructor(args: { file: string; defaults: T }) {
    this.file = args.file;
    this.defaults = args.defaults;
  }

  /**
   * 启动期调用：读磁盘 + 解析 + 内存镜像
   *
   * ENOENT → 用 defaults 初始化（写盘一次）
   * 解析失败 → throw（**不**自动清空，避免丢用户数据；启动期显式报警让用户处理）
   */
  async load(): Promise<T> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        log.info({ file: this.file }, 'localStore: file missing, init with defaults');
        this.cache = structuredClone(this.defaults);
        // ENOENT 路径：标 dirty + 同步 flush（**不等 debounce**，因为调用方 load() 后
        // 常常立刻读 + 写；debounce 会导致竞态）
        this.dirty = true;
        await this.doFlush();
        return this.cache;
      }
      throw err;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      log.fatal({ file: this.file, err }, 'localStore: JSON parse failed; refusing to start');
      throw new Error(
        `localStore 解析失败: ${this.file}。` +
          `请检查文件是否被外部工具改坏；备份后删除此文件可恢复默认状态。`,
      );
    }

    // 合并 defaults（防止旧版本字段缺失）
    this.cache = { ...structuredClone(this.defaults), ...(parsed as Partial<T>) } as T;
    log.info({ file: this.file, keys: Object.keys(this.cache) }, 'localStore: loaded');
    return this.cache;
  }

  /**
   * 同步读内存镜像
   *
   * 必须在 load() 之后调用；否则 throw
   */
  get(): T {
    if (!this.cache) {
      throw new Error('localStore not loaded; call load() first');
    }
    return this.cache;
  }

  /**
   * 修改内存态（同步）+ 触发 debounce flush
   *
   * 使用模式：
   * ```ts
   * store.mutate(s => {
   *   s.prefs.theme = 'light';
   * });
   * ```
   */
  mutate<R>(fn: (s: T) => R): R {
    if (!this.cache) {
      throw new Error('localStore not loaded; call load() first');
    }
    const r = fn(this.cache);
    this.dirty = true;
    this.scheduleFlush();
    return r;
  }

  /**
   * 立刻同步 flush（不等待 debounce）
   *
   * 用途：before-quit hook；测试断言
   */
  async flushNow(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.doFlush();
  }

  /**
   * 关停（before-quit 调用）
   */
  async close(): Promise<void> {
    await this.flushNow();
  }

  // ===== 私有 =====

  private scheduleFlush(): void {
    // 已有 timer 在排 → 复用（debounce 语义）
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.doFlush();
    }, FLUSH_DEBOUNCE_MS);
  }

  private async doFlush(): Promise<void> {
    if (this.flushing) return;
    if (!this.dirty || !this.cache) return;

    this.flushing = true;
    try {
      const snapshot = JSON.stringify(this.cache, null, 2);
      const tmp = `${this.file}.tmp.${process.pid}.${Date.now()}`;

      // 确保目录存在
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });

      // 原子写：write tmp + rename
      await writeFile(tmp, snapshot, { mode: 0o600 });
      await rename(tmp, this.file);

      this.dirty = false;
      this.retryDelay = 0; // 成功后清零
      log.debug({ file: this.file, bytes: snapshot.length }, 'localStore: flushed');
    } catch (err) {
      // 失败：清理残留 tmp 文件 + 退避重试（保留 dirty 状态）
      try {
        const { unlink } = await import('node:fs/promises');
        await unlink(tmp).catch(() => {
          // tmp 不存在 / 已删 = 忽略
        });
      } catch {
        // unlink 自身失败 = 忽略（tmp 可能正被另一进程持有）
      }
      this.retryDelay = Math.min(
        this.retryDelay === 0 ? 200 : this.retryDelay * 2,
        FLUSH_RETRY_MAX_MS,
      );
      log.error(
        { file: this.file, err, retryDelayMs: this.retryDelay },
        'localStore: flush failed; will retry',
      );
      setTimeout(() => void this.doFlush(), this.retryDelay);
    } finally {
      this.flushing = false;
    }
  }
}

/**
 * 工具：拼出 state.json 的完整路径
 *
 * 路径策略：与 src/main/cache/sqlite.ts 的 `resolveDbPath` 保持完全一致
 * - 优先 ${GITEA_KANBAN_DATA_DIR}/state.json
 * - 兜底 ~/.gitea-kanban/state.json
 *
 * 这里**独立实现**而不 import resolveDbPath：
 * - sqlite.ts 顶层 import electron.app，测试时炸
 * - 两边必须 100% 走同路径策略；本函数是 sqlite.ts resolveDbPath 的精简版
 *   （只取 dirname(kanban.db) 拼 state.json，**不**读 SQLITE_DB_FILENAME 常量）
 *
 * **不**接受用户输入的绝对路径（AGENTS §8.4）
 */
export function resolveStatePath(): string {
  const dataDir = process.env['GITEA_KANBAN_DATA_DIR']
    ?? join(os.homedir(), '.gitea-kanban');
  if (!isAbsolute(dataDir)) {
    throw new Error(`data dir must be absolute, got: ${dataDir}`);
  }
  return join(dataDir, 'state.json');
}
