/**
 * 拉 renderer 进程最近 console messages + 任何未捕获 exception
 * 走 CDP Runtime / Log domain over WebSocket
 */
import WebSocket from '../node_modules/.pnpm/ws@8.21.0/node_modules/ws/wrapper.mjs';

const wsUrl = process.argv[2];
if (!wsUrl) {
  console.error('usage: node scripts/_peek-renderer-console.mjs <wsUrl>');
  process.exit(1);
}

const ws = new WebSocket(wsUrl);
let id = 0;
const pending = new Map();
const collected = [];

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}

ws.on('open', async () => {
  // 启用 Log + Runtime
  await send('Log.enable');
  await send('Runtime.enable');
  // 拉 snapshot：之前已经发生的 exception
  // 用 Log.getRequestsForVA 不可行 —— 改用 Page.getNavigationHistory 看 visited pages；
  // 更直接：直接 ask 浏览器 reload 之前的 frame state，但我们不能 reload 用户界面。
  // 退而求其次：开 Log.enable 后，所有后续 message 会进 events。
  // 已经发生的，我们通过 evaluate `JSON.stringify(performance.getEntries())` 看资源失败，
  // 再问 console.history（无内置 API），只能让用户配合重现。
  // 实际方案：现在 listen 30 秒，期间用户操作触发任何 console/error 都收。
  console.log('[peek] connected, listening 25s ...');
});

ws.on('message', (data) => {
  let msg;
  try {
    msg = JSON.parse(data.toString());
  } catch {
    return;
  }
  if (msg.id != null) {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      msg.error ? p.reject(msg.error) : p.resolve(msg.result);
    }
    return;
  }
  // event
  const method = msg.method;
  if (method === 'Log.entryAdded') {
    const e = msg.params.entry;
    collected.push({
      source: e.source,
      level: e.level,
      text: e.text,
      url: e.url,
      lineNumber: e.lineNumber,
      category: e.category,
    });
  }
  if (method === 'Runtime.consoleAPICalled') {
    const p = msg.params;
    const text = (p.args || [])
      .map((a) => (a.value !== undefined ? String(a.value) : a.description || a.unserializableValue || JSON.stringify(a.preview?.properties?.slice(0, 5))))
      .join(' ');
    collected.push({
      source: 'console',
      level: p.type,
      text,
      url: p.stackTrace?.callFrames?.[0]?.url,
      line: p.stackTrace?.callFrames?.[0]?.lineNumber,
    });
  }
  if (method === 'Runtime.exceptionThrown') {
    const e = msg.params.exceptionDetails;
    collected.push({
      source: 'exception',
      level: 'error',
      text: e.text + ' ' + (e.exception?.description || ''),
      url: e.url,
      line: e.lineNumber,
    });
  }
});

setTimeout(() => {
  console.log('=== collected console entries ===');
  if (collected.length === 0) {
    console.log('(none during this window — try triggering UI action)');
  } else {
    for (const e of collected) {
      console.log(`[${e.level.padEnd(5)}] [${e.source}] ${e.text}`);
      if (e.url) console.log(`         at ${e.url}:${e.line ?? '?'}`);
    }
  }
  ws.close();
  process.exit(0);
}, 25000);