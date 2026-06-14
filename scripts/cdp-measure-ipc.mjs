#!/usr/bin/env node
import { get } from 'node:http';

const pages = await new Promise((resolve, reject) => {
  get('http://127.0.0.1:9492/json/list', (res) => {
    let d = '';
    res.on('data', (c) => (d += c));
    res.on('end', () => resolve(JSON.parse(d)));
  }).on('error', reject);
});
const t = pages.find((p) => p.title.includes('时间轴') && p.type === 'page');
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
  setTimeout(() => reject(new Error('ws timeout')), 10_000);
});

class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message}`));
        else resolve(msg.result);
      }
    };
  }
  send(method, params = {}) {
    this.id += 1;
    const id = this.id;
    const p = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.ws.send(JSON.stringify({ id, method, params }));
    return p;
  }
}
const cdp = new CdpClient(ws);
await cdp.send('Runtime.enable');

// 直接调用 loadTimeline，测量 IPC round-trip
const expr = `
  (async () => {
    const vm = window.__timelineVm;
    vm.selectedBranches = new Set(['main']);
    const t0 = performance.now();
    await vm.loadTimeline();
    const t1 = performance.now();
    return { ms: Math.round(t1 - t0), nodes: vm.timeline?.nodes?.length, error: vm.error };
  })()
`;
const res = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 30_000 });
console.log(JSON.stringify(res.result?.value ?? res.result, null, 2));
ws.close();
