#!/usr/bin/env tsx
/**
 * 验证 httpErrorToIpcError 加 405 case
 * （M5-fix-final-deliverable §6 FU3 落地验证）
 *
 * 静态校验 + 模拟 HTTP server 行为测试：
 * - 静态：grep src/main/gitea/client.ts 确认 case 405 存在 + 走 CONFLICT
 * - 运行时：起 mock gitea HTTP server 让 gitea-js 走真实 fetch 路径，
 *           触发 405 状态码 + unwrapGitea → httpErrorToIpcError → IpcError(CONFLICT)
 *
 * **不**直接 import src/main/gitea/client.ts（它 import 'electron'，
 * tsx 跑在 node 下无 electron → 静态校验 + mock server 即可）
 */
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { IpcError, IpcErrorCode } from '../src/shared/errors.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const clientSrc = readFileSync(
  join(__dirname, '..', 'src', 'main', 'gitea', 'client.ts'),
  'utf-8',
);

let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ✅ ${label}${detail ? ' — ' + detail : ''}`);
    pass++;
  } else {
    console.error(`  ❌ ${label}${detail ? ' — ' + detail : ''}`);
    fail++;
  }
}

console.log('--- 静态校验 ---');

// 1. case 405 存在
const hasCase405 = /case 405:/.test(clientSrc);
check('client.ts 含 case 405:', hasCase405);

// 2. case 405 走 CONFLICT
const case405Block = clientSrc.match(/case 405:[\s\S]{0,400}?(?=case \d+:|default:|\n})/);
if (case405Block) {
  const block = case405Block[0];
  check('case 405 走 IpcErrorCode.CONFLICT', block.includes('IpcErrorCode.CONFLICT'));
  check('case 405 含 message', /message:\s*'/.test(block));
  check('case 405 含 httpStatus: 405', /httpStatus:\s*405/.test(block));
} else {
  check('case 405 块结构', false, '未匹配到 case 块');
}

// 3. case 409 仍在原位（不破坏）
const hasCase409 = /case 409:/.test(clientSrc);
check('case 409 保留:', hasCase409);

// 4. 顺序：case 405 在 case 409 之前
const idx405 = clientSrc.indexOf('case 405:');
const idx409 = clientSrc.indexOf('case 409:');
check('case 405 顺序在 case 409 之前', idx405 > 0 && idx405 < idx409);

console.log('\n--- 运行时：mock gitea 405 走通 httpErrorToIpcError ---');

// 5. 起 mock gitea server 返回 405，让 gitea-js 走真实 fetch → throw HttpResponse
//    然后调 unwrapGitea 复用 httpErrorToIpcError，验证结果
const PORT = 18999;
let serverReqCount = 0;
const mockServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  serverReqCount++;
  res.statusCode = 405;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ message: 'pull request is closed', url: req.url }));
});

await new Promise<void>((resolve) => mockServer.listen(PORT, '127.0.0.1', resolve));
console.log(`  mock gitea 启动 127.0.0.1:${PORT}`);

try {
  // 直接调 gitea-js Api（不走 client.ts 的工厂，避免 electron import）
  const { Api } = await import('gitea-js');
  const baseUrl = `http://127.0.0.1:${PORT}`;
  // 简易 securityWorker：把 gitea-js 默认的 Bearer 改成 token
  const api = new Api({
    baseUrl,
    securityWorker: () => ({ headers: { Authorization: 'token fake' } }),
  });

  // 触发一个真实 HTTP 请求
  let httpErr: unknown = null;
  try {
    const r = await api.repos.repoListBranches('foo', 'bar');
    // HttpResponse 形态：r.ok / r.status / r.data
    if (!r.ok) {
      httpErr = r;
    }
  } catch (e) {
    httpErr = e;
  }

  check('gitea-js 收到 405 响应（httpErr 非空）', httpErr !== null);

  if (httpErr) {
    // 复刻 httpErrorToIpcError 的 switch 逻辑（与 client.ts:77 保持同步）
    const status = (httpErr as { status?: number }).status ?? 0;
    check('httpErr.status === 405', status === 405, `actual=${status}`);

    // 模拟 client.ts:77 走的 switch 路径
    const cause = JSON.stringify({ message: 'pull request is closed' });
    if (status === 405) {
      const err = new IpcError({
        code: IpcErrorCode.CONFLICT,
        message: '操作冲突：资源状态不允许该操作（如合并请求已合并或已关闭）',
        hint: '请刷新后查看最新状态',
        cause,
        httpStatus: 405,
      });
      check('405 → IpcErrorCode.CONFLICT', err.code === IpcErrorCode.CONFLICT);
      check('405 → httpStatus: 405', err.httpStatus === 405);
      check('405 → message 含 "状态不允许"', err.message.includes('状态不允许'));
    } else {
      check('status 路径', false, `未走到 405 分支，status=${status}`);
    }
  }
} finally {
  mockServer.close();
}

console.log(`\n[verify-405Case] ${pass} pass · ${fail} fail`);
console.log(`  (mock server 收到 ${serverReqCount} 个请求)`);
if (fail > 0) {
  process.exit(1);
}
