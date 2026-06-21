#!/usr/bin/env node
/**
 * cdp-dump-timeline-state.mjs
 * 排查真实数据下 timeline 的 lanes/nodes/edges 实际是什么
 */
import { get } from 'node:http';

const CDP_HTTP = 'http://127.0.0.1:9492';

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== undefined && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
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
  close() { this.ws.close(); }
}

async function main() {
  const pages = await httpGetJson(`${CDP_HTTP}/json/list`);
  let target = pages.find((p) => p.type === 'page' && p.url.startsWith('file://') && (p.title.includes('时间轴') || p.url.includes('timeline')));
  if (!target) target = pages.find((p) => p.type === 'page' && p.url.startsWith('file://'));
  if (!target) throw new Error('no app page');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; setTimeout(() => j(new Error('timeout')), 10_000); });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');

  // 切到时间轴
  await cdp.send('Runtime.evaluate', { expression: `location.hash = '#/timeline'`, returnByValue: true });
  await new Promise((r) => setTimeout(r, 2500));

  // 触发一次刷新确保 timeline 加载
  await cdp.send('Runtime.evaluate', {
    expression: `(()=>{ const vm = window.__timelineVm; if(vm && vm.loadTimeline) vm.loadTimeline(); return 'triggered'; })()`,
    returnByValue: true,
  });
  await new Promise((r) => setTimeout(r, 3000));

  // dump lanes/nodes/edges
  const dump = await cdp.send('Runtime.evaluate', {
    expression: `(()=>{ const vm = window.__timelineVm; if(!vm) return { err:'no vm' }; const t = vm.timeline?.value ?? vm.timeline; if(!t) return { err:'no timeline' }; return { lanes: t.lanes.map(l => ({ id: l.id, label: l.label, order: l.order })), nodeCount: t.nodes.length, edgeCount: t.edges.length, firstFewNodes: t.nodes.slice(0, 8).map(n => ({ sha: n.sha.slice(0,7), laneId: n.laneId, branchHints: n.branchHints })), sortedNodesFirst8: (vm.sortedNodes?.value ?? vm.sortedNodes).slice(0, 8).map(n => ({ sha: n.sha.slice(0,7), laneId: n.laneId, branchHints: n.branchHints })), pathsCount: (vm.graphPaths?.value ?? vm.graphPaths).length }; })()`,
    returnByValue: true,
  });
  console.log(JSON.stringify(dump.result.value, null, 2));

  // 看下 dot 真实 x 坐标（用 DOM 测量）
  const dotDump = await cdp.send('Runtime.evaluate', {
    expression: `(()=>{ const rows = document.querySelectorAll('.commit-row'); const result = []; for(let i=0; i<Math.min(8, rows.length); i++){ const dot = rows[i].querySelector('.commit-row__dot'); const svg = document.querySelector('.commit-list__edges'); result.push({ rowIdx: i, dotLeft: dot?.style.left, dotRect: dot?.getBoundingClientRect().toJSON(), svgRect: svg?.getBoundingClientRect().toJSON(), rowHash: rows[i].querySelector('.commit-row__hash')?.textContent }); } return result; })()`,
    returnByValue: true,
  });
  console.log('\n=== DOT vs SVG positions ===');
  console.log(JSON.stringify(dotDump.result.value, null, 2));

  cdp.close();
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });