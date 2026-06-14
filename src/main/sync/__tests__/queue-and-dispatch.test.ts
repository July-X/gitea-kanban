/**
 * sync 模块单测（dispatch / queue / runner）
 *
 * 不引 electron；不引 better-sqlite3；纯 JS mock
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveQueuePath,
  loadQueue,
  enqueueEntry,
  markEntryDone,
  markEntryFailed,
  gcQueue,
  type QueueEntry,
} from '../queue.js';
import {
  registerOp,
  dispatch,
  listRegisteredOps,
  _resetRegistryForTest,
  _registrySize,
} from '../dispatch.js';
import { SyncRunner, _resetSyncRunnerForTest } from '../runner.js';
import { IpcError, IpcErrorCode } from '@shared/errors';

let TMP_DIR: string;
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env['GITEA_KANBAN_DATA_DIR'];
  TMP_DIR = mkdtempSync(join(tmpdir(), 'gitea-kanban-queue-test-'));
  process.env['GITEA_KANBAN_DATA_DIR'] = TMP_DIR;
  _resetRegistryForTest();
  _resetSyncRunnerForTest();
});

afterEach(async () => {
  if (savedEnv !== undefined) process.env['GITEA_KANBAN_DATA_DIR'] = savedEnv;
  else delete process.env['GITEA_KANBAN_DATA_DIR'];
  if (existsSync(TMP_DIR)) {
    rmSync(TMP_DIR, { recursive: true, force: true });
  }
});

// ===== queue =====

describe('resolveQueuePath', () => {
  it('返 ${GITEA_KANBAN_DATA_DIR}/queue.jsonl', () => {
    expect(resolveQueuePath()).toBe(join(TMP_DIR, 'queue.jsonl'));
  });
});

describe('loadQueue', () => {
  it('文件不存在返空数组', async () => {
    expect(await loadQueue()).toEqual([]);
  });
  it('空文件返空', async () => {
    writeFileSync(resolveQueuePath(), '');
    expect(await loadQueue()).toEqual([]);
  });
  it('解析多行 entry 返升序数组', async () => {
    const entries = [
      { id: 'q-1', op: 'a.b', args: {}, queuedAt: 100, attempt: 0, status: 'pending' },
      { id: 'q-2', op: 'c.d', args: {}, queuedAt: 200, attempt: 0, status: 'pending' },
    ];
    writeFileSync(
      resolveQueuePath(),
      entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
    );
    const loaded = await loadQueue();
    expect(loaded.length).toBe(2);
    expect(loaded[0]!.id).toBe('q-1');
  });
  it('崩恢复：in-flight → pending', async () => {
    const e = {
      id: 'q-1',
      op: 'a.b',
      args: {},
      queuedAt: 100,
      attempt: 1,
      status: 'in-flight',
    };
    writeFileSync(resolveQueuePath(), JSON.stringify(e) + '\n');
    const loaded = await loadQueue();
    expect(loaded[0]!.status).toBe('pending');
  });
  it('malformed JSON 跳过 + warn', async () => {
    writeFileSync(
      resolveQueuePath(),
      JSON.stringify({ id: 'q-1', op: 'a', args: {}, queuedAt: 100, attempt: 0, status: 'pending' }) +
        '\n' +
        '{ this is not valid JSON\n' +
        JSON.stringify({ id: 'q-2', op: 'b', args: {}, queuedAt: 200, attempt: 0, status: 'pending' }) +
        '\n',
    );
    const loaded = await loadQueue();
    expect(loaded.length).toBe(2);
  });
});

describe('enqueueEntry + markDone + markFailed', () => {
  it('enqueue 追加新行', async () => {
    const e = await enqueueEntry({ op: 'a.b', payload: { x: 1 } });
    expect(e.status).toBe('pending');
    expect(e.op).toBe('a.b');
    const loaded = await loadQueue();
    expect(loaded.length).toBe(1);
    expect(loaded[0]!.id).toBe(e.id);
  });
  it('markDone 追加 status=done 行', async () => {
    const e = await enqueueEntry({ op: 'a', payload: null });
    await markEntryDone(e.id);
    const loaded = await loadQueue();
    const latest = loaded.find((x) => x.id === e.id);
    expect(latest?.status).toBe('done');
  });
  it('markFailed 追加 status=failed 行 + lastError', async () => {
    const e = await enqueueEntry({ op: 'a', payload: null });
    await markEntryFailed(e.id, 'oops');
    const loaded = await loadQueue();
    const latest = loaded.find((x) => x.id === e.id);
    expect(latest?.status).toBe('failed');
    expect(latest?.lastError).toBe('oops');
  });
});

describe('gcQueue', () => {
  it('30 天前 done 删', async () => {
    const old: QueueEntry = {
      id: 'q-old',
      op: 'a',
      args: null,
      queuedAt: 1,
      attempt: 0,
      status: 'done',
      doneAt: Date.now() - 31 * 24 * 60 * 60 * 1000,
    };
    const recent: QueueEntry = {
      id: 'q-recent',
      op: 'a',
      args: null,
      queuedAt: Date.now(),
      attempt: 0,
      status: 'done',
      doneAt: Date.now(),
    };
    writeFileSync(
      resolveQueuePath(),
      [old, recent].map((e) => JSON.stringify(e)).join('\n') + '\n',
    );
    const { removed, remaining } = await gcQueue();
    expect(removed).toBe(1);
    expect(remaining).toBe(1);
  });
  it('空文件返 0', async () => {
    const r = await gcQueue();
    expect(r.removed).toBe(0);
    expect(r.remaining).toBe(0);
  });
});

// ===== dispatch =====

describe('dispatch', () => {
  it('注册 op + execute 返结果', async () => {
    registerOp('test.add', {
      execute: async (args: { n: number }) => args.n * 2,
    });
    const r = await dispatch<{ n: number }, number>('test.add', { n: 5 });
    expect(r.mode).toBe('online');
    expect(r.result).toBe(10);
  });
  it('未注册 op 抛 INTERNAL', async () => {
    await expect(dispatch('not.registered', {})).rejects.toThrow();
  });
  it('gitea 抛 NETWORK_OFFLINE + 有 offlineApply → fallback offline', async () => {
    registerOp('test.net', {
      execute: async () => {
        throw new IpcError({
          code: IpcErrorCode.NETWORK_OFFLINE,
          message: 'net',
        });
      },
      offlineApply: (args: { n: number }) => -args.n, // 离线预测
    });
    const r = await dispatch<{ n: number }, number>('test.net', { n: 7 });
    expect(r.mode).toBe('offline');
    expect(r.result).toBe(-7); // offlineApply
    expect(r.entryId).toBeDefined();
  });
  it('gitea 抛 NETWORK_OFFLINE + 无 offlineApply → 重抛', async () => {
    registerOp('test.no-offline', {
      execute: async () => {
        throw new IpcError({
          code: IpcErrorCode.NETWORK_OFFLINE,
          message: 'net',
        });
      },
      // 无 offlineApply
    });
    await expect(dispatch('test.no-offline', {})).rejects.toThrow();
  });
  it('gitea 抛非网络错 → 重抛（不降级）', async () => {
    registerOp('test.conflict', {
      execute: async () => {
        throw new IpcError({
          code: IpcErrorCode.CONFLICT,
          message: 'biz err',
        });
      },
      offlineApply: () => 'should not be called',
    });
    await expect(dispatch('test.conflict', {})).rejects.toThrow(/biz err/);
  });
  it('execute 返成功 → 不 enqueue', async () => {
    registerOp('test.ok', {
      execute: async () => 'ok',
    });
    const r = await dispatch('test.ok', null);
    expect(r.mode).toBe('online');
    expect(r.entryId).toBeUndefined();
  });
});

describe('listRegisteredOps', () => {
  it('返所有注册 op 名（排序）', () => {
    registerOp('z.last', { execute: async () => null });
    registerOp('a.first', { execute: async () => null });
    expect(listRegisteredOps()).toEqual(['a.first', 'z.last']);
  });
});

// ===== SyncRunner =====

describe('SyncRunner', () => {
  it('start 拉 queue + 跑一次；stop 关闭', async () => {
    // enqueue 一条 op
    registerOp('runner.test', {
      execute: async () => 'done',
    });
    await enqueueEntry({ op: 'runner.test', payload: null });

    const runner = new SyncRunner();
    await runner.start();
    // 等 runOnce 跑完
    await new Promise((r) => setTimeout(r, 50));
    const pending = runner.listPending();
    expect(pending.length).toBe(0); // 已被 done
    await runner.stop();
  });

  it('execute 失败 → 累 attempt + status=failed', async () => {
    let attempt = 0;
    registerOp('runner.fail', {
      execute: async () => {
        attempt++;
        throw new Error('boom');
      },
    });
    await enqueueEntry({ op: 'runner.fail', payload: null });

    const runner = new SyncRunner();
    await runner.start();
    await new Promise((r) => setTimeout(r, 50));

    const pending = runner.listPending();
    expect(pending.length).toBe(1);
    expect(pending[0]!.status).toBe('failed');
    expect(pending[0]!.attempt).toBe(1);

    await runner.stop();
  });

  it('execute 超 MAX_ATTEMPTS → abandoned', async () => {
    registerOp('runner.boom', {
      execute: async () => {
        throw new Error('always boom');
      },
    });
    // 直接写 5 条 attempt entry（已 attempt 4 次）
    const e: QueueEntry = {
      id: 'q-1',
      op: 'runner.boom',
      args: null,
      queuedAt: Date.now(),
      attempt: 4, // 再失败一次 = 5 → abandoned
      status: 'pending',
    };
    writeFileSync(resolveQueuePath(), JSON.stringify(e) + '\n');

    const runner = new SyncRunner();
    await runner.start();
    await new Promise((r) => setTimeout(r, 50));

    const pending = runner.listPending();
    expect(pending.length).toBe(0); // abandoned
    const onDisk = await loadQueue();
    expect(onDisk[0]!.status).toBe('abandoned');

    await runner.stop();
  });
});
