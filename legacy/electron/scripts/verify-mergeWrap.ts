#!/usr/bin/env -S npx tsx
/**
 * scripts/verify-mergeWrap.ts
 *
 * 验证目的（plan_ca3ee537 fix-mergegiteapull-wrap · 2026-06-11）：
 * 修 src/main/gitea/pulls.ts mergeGiteaPull 的 gitea-js throw HttpResponse bug。
 *
 * 修前行为：gitea-js 1.23.0 在 fetch 层遇到 !response.ok 时直接 throw 修改过的 HttpResponse
 *   （见 node_modules/gitea-js/dist/index.js:161-162 `if (!response.ok) throw data;`）
 *   业务层没 try/catch → 这个对象一路冒到 IPC wrapIpc，
 *   wrapIpc 把它判成 IpcError(INTERNAL) → 前端只看到"应用内部错误"，
 *   丢码（应该是 CONFLICT/PERMISSION_DENIED/NOT_FOUND 等）又丢人话。
 *
 * 修后行为：mergeGiteaPull 加 try/catch，catch 内识别 HttpResponse（err.ok === false），
 *   走 unwrapGitea 复用 httpErrorToIpcError 映射 → 抛 IpcError(code, message, httpStatus)
 *   其它错误（程序 bug / IO）保持原样 throw，wrapIpc 走 INTERNAL 通用路径
 *
 * 测试方法：**真实** 起一个 mock gitea HTTP server（Node http.createServer），
 *   让 gitea-js 走真实 fetch 路径（gitea-js 内部 customFetch 默认走 globalThis.fetch），
 *   触发 gitea-js 的 throw 路径，跑通业务层 try/catch，验证最后抛的是 IpcError 而不是裸 Response。
 *
 * 不用 vitest（AGENTS §8.12 plan 收口教训：vitest ABI 切回 node，dev 跑不了）
 * 不用 monkey-patch gitea-js / fetch（改 import 链太重）
 * 不用 nock / msw（避免加新 dep）
 *
 * 验证矩阵（3 case）：
 * - 409 + body {message: "pull request is closed"} → IpcError(CONFLICT) [PR 已合并的典型场景]
 * - 422 + body {message: "branch is protected"}   → IpcError(VALIDATION_FAILED) [保护分支]
 * - 405 + body {message: "..."}                  → IpcError(GITEA_ERROR) [fallback，405 没在
 *                                                       httpErrorToIpcError 单独 case → default]
 *   注释：pulls.ts:19 doc comment 说 405/409 都应映射 CONFLICT，但 httpErrorToIpcError
 *   当前没 405 case——405 走 default branch → GITEA_ERROR。**这是 doc vs 实现不匹配
 *   的独立 issue，不在本任务 scope**（任务 prompt "只改 mergeGiteaPull 这一处"）。
 *   本测试断言 405 抛 IpcError（任何 code）即可，重点是"不是裸 Response、不是 INTERNAL"。
 *
 * 用法：
 *   cd /Users/zhongxingxing/2026/code/gitea-kanban
 *   pnpm exec tsx scripts/verify-mergeWrap.ts
 *
 * 副作用：
 * - 临时在系统 keychain 写 service=`gitea-kanban@http://127.0.0.1:<port>` 下的
 *   user=mockuser 的 fake token；跑完会 keychainDelete 清理
 * - **不**碰 gitea 端（mock server 跑完关掉）
 * - **不**碰 ~/.gitea-kanban/kanban.db
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { IpcError, IpcErrorCode } from '../src/shared/errors.js';
import { mergeGiteaPull } from '../src/main/gitea/pulls.js';
import { keychainSet, keychainDelete } from '../src/main/gitea/keychain.js';
import { clearGiteaClientCache } from '../src/main/gitea/client.js';

interface MockCase {
  name: string;
  status: number;
  body: Record<string, unknown>;
  /** 期望的 IpcErrorCode（null = 任何 code 都行，只要不是 INTERNAL 就行） */
  expectCode: string | null;
  /** 期望的 httpStatus 透传 */
  expectHttpStatus: number;
  /** 备注 */
  note: string;
}

const CASES: MockCase[] = [
  {
    name: 'PR 已合并 → 409',
    status: 409,
    body: { message: 'pull request is closed', url: 'http://example.com' },
    expectCode: IpcErrorCode.CONFLICT,
    expectHttpStatus: 409,
    note: '典型 W3 step 5b fail 场景；映射到 CONFLICT 是 httpErrorToIpcError 唯一 409 case',
  },
  {
    name: '保护分支 → 422',
    status: 422,
    body: { message: 'head branch is protected' },
    expectCode: IpcErrorCode.VALIDATION_FAILED,
    expectHttpStatus: 422,
    note: 'doc pulls.ts:19 提到 422 protected branch → CONFLICT，但 httpErrorToIpcError 实际 422 → VALIDATION_FAILED（独立 doc vs 实现 issue）',
  },
  {
    name: 'gitea 405 Method Not Allowed',
    status: 405,
    body: { message: 'pull request is closed' },
    expectCode: IpcErrorCode.GITEA_ERROR, // 405 走 default branch → GITEA_ERROR
    expectHttpStatus: 405,
    note: 'doc pulls.ts:19 说 405→CONFLICT，但 httpErrorToIpcError 当前 405 走 default → GITEA_ERROR。修后**不是**裸 Response，doc 不匹配属独立 issue',
  },
];

interface MockServer {
  port: number;
  url: string;
  close: () => Promise<void>;
  setNext: (status: number, body: Record<string, unknown>) => void;
  requestLog: Array<{ method: string; path: string; auth: string | null; body: string }>;
}

/**
 * 起一个 mock gitea 服务器：
 * - 任何 /api/v1/* POST/PUT/DELETE/PATCH → 返 nextStatus + nextBody
 * - 任何 /api/v1/* GET/HEAD/OPTIONS → 返 200 + {} （client.ts 的 giteaFetch 不会走，但 securityWorker 可能探测）
 * - 任何其它路径 → 404
 */
async function startMockGitea(): Promise<MockServer> {
  const requestLog: Array<{ method: string; path: string; auth: string | null; body: string }> = [];
  let nextStatus = 500;
  let nextBody: Record<string, unknown> = { message: 'mock default' };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const auth = (req.headers['authorization'] as string | undefined) ?? null;
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf-8');
    });
    req.on('end', () => {
      requestLog.push({ method: req.method ?? '?', path: req.url ?? '?', auth, body });

      // /api/v1 路径透传 nextStatus / nextBody
      if ((req.url ?? '').startsWith('/api/v1/') && req.method !== 'GET' && req.method !== 'HEAD') {
        res.statusCode = nextStatus;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(nextBody));
        return;
      }
      // 默认 200 + {}
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end('{}');
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('mock server failed to bind');
  }
  const port = address.port;
  const url = `http://127.0.0.1:${port}`;

  return {
    port,
    url,
    requestLog,
    setNext(status: number, body: Record<string, unknown>) {
      nextStatus = status;
      nextBody = body;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

let pass = 0;
let fail = 0;
const failures: string[] = [];

function logOk(name: string, detail: string): void {
  pass++;
  console.log(`  ✅ ${name}: ${detail}`);
}

function logFail(name: string, detail: string): void {
  fail++;
  failures.push(`${name}: ${detail}`);
  console.log(`  ❌ ${name}: ${detail}`);
}

async function runCase(server: MockServer, c: MockCase): Promise<void> {
  server.setNext(c.status, c.body);
  // 清 client cache 让 fetch 走 mock URL（避免 stale token / baseUrl）
  clearGiteaClientCache();

  let caught: unknown;
  try {
    const result = await mergeGiteaPull({
      giteaUrl: server.url,
      username: 'mockuser',
      owner: 'mockowner',
      repo: 'mockrepo',
      index: 1,
      method: 'merge',
    });
    logFail(c.name, `expected throw, got result: ${JSON.stringify(result)}`);
    return;
  } catch (e: unknown) {
    caught = e;
  }

  // 断言 1：必须是 IpcError
  if (!(caught instanceof IpcError)) {
    const typeName =
      caught && typeof caught === 'object' ? (caught as { constructor?: { name?: string } }).constructor?.name ?? typeof caught : typeof caught;
    const detail =
      caught && typeof caught === 'object' && 'status' in (caught as Record<string, unknown>)
        ? `raw HttpResponse-like object (status=${(caught as { status: unknown }).status}, ok=${(caught as { ok: unknown }).ok})`
        : `${typeName}: ${caught instanceof Error ? caught.message : String(caught)}`;
    logFail(c.name, `expected IpcError, got ${detail}`);
    return;
  }

  // 断言 2：code 匹配（如果指定了）
  if (c.expectCode !== null && caught.code !== c.expectCode) {
    logFail(
      c.name,
      `expected code=${c.expectCode}, got code=${caught.code}; full IpcError: ${JSON.stringify(caught.toJSON())}`,
    );
    return;
  }

  // 断言 3：code 一定不是 INTERNAL（INTERNAL = wrapIpc catch-all 把裸 Response 误判的指纹）
  if (caught.code === IpcErrorCode.INTERNAL) {
    logFail(
      c.name,
      `IpcError.code = INTERNAL ← wrapIpc catch-all 误判的指纹，证明 catch 路径没生效; full: ${JSON.stringify(caught.toJSON())}`,
    );
    return;
  }

  // 断言 4：httpStatus 透传
  if (caught.httpStatus !== c.expectHttpStatus) {
    logFail(
      c.name,
      `expected httpStatus=${c.expectHttpStatus}, got ${caught.httpStatus}; full: ${JSON.stringify(caught.toJSON())}`,
    );
    return;
  }

  logOk(
    c.name,
    `IpcError(code=${caught.code}, httpStatus=${caught.httpStatus}, message="${caught.message}", cause=${(caught.cause ?? '').slice(0, 60)})`,
  );
}

async function main(): Promise<void> {
  console.log('verify-mergeWrap: gitea-js throw HttpResponse → mergeGiteaPull try/catch wrap\n');

  const server = await startMockGitea();
  console.log(`[setup] mock gitea at ${server.url}`);

  // 1. seed keychain
  const FAKE_TOKEN = 'mock-token-for-test-only-not-a-real-pat';
  await keychainSet(server.url, 'mockuser', FAKE_TOKEN);
  console.log('[setup] keychain seeded with fake token\n');

  try {
    for (const c of CASES) {
      console.log(`[case] ${c.name}`);
      console.log(`       note: ${c.note}`);
      await runCase(server, c);
      console.log('');
    }
  } finally {
    // cleanup
    console.log('[cleanup] closing mock server + deleting keychain entry');
    await keychainDelete(server.url, 'mockuser');
    await server.close();
    clearGiteaClientCache();
  }

  console.log(`\n[summary] pass=${pass} fail=${fail}`);
  if (fail > 0) {
    console.log('failures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('all pass');
  process.exit(0);
}

main().catch((e: unknown) => {
  console.error('verify-mergeWrap: unexpected error', e);
  process.exit(2);
});
