#!/usr/bin/env node
/**
 * 测量 TimelineView 各个 computed 的执行耗时。
 */
import { get } from 'node:http';

const CDP_HTTP = 'http://127.0.0.1:9492';

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

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
  close() {
    this.ws.close();
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function generateTimeline(nodeCount = 500, laneCount = 8) {
  const labels = ['main', 'feature/merge', 'feature/kanban', 'develop', 'hotfix/auth', 'chore/ci', 'refactor/store', 'exp/x6'];
  const lanes = [];
  for (let i = 0; i < laneCount; i++) {
    lanes.push({ id: `lane-${i}`, label: labels[i] ?? `lane-${i}`, order: i, color: '#74B830' });
  }
  const nodes = [];
  const now = Date.now();
  for (let i = 0; i < nodeCount; i++) {
    const laneIdx = i % laneCount;
    const ts = new Date(now - i * 3600_000).toISOString();
    nodes.push({
      id: `node-${i}`,
      sha: `abcdef${i.toString(16).padStart(32, '0')}`.slice(0, 40),
      shortSha: `abc${i.toString(16).padStart(4, '0')}`.slice(0, 7),
      message: `commit message ${i} `.repeat(5).trim(),
      timestamp: ts,
      laneId: `lane-${laneIdx}`,
      isMerge: i % 17 === 0,
      isHead: i === 0,
      author: { name: `Author ${i % 12}`, email: `a${i}@test.com`, avatarUrl: '' },
      additions: i % 50,
      deletions: i % 30,
      filesChanged: i % 10,
      branchHints: [labels[laneIdx]],
      linkedCardIds: i % 5 === 0 ? [i] : [],
    });
  }
  return { lanes, nodes, edges: [] };
}

async function main() {
  const pages = await httpGetJson(`${CDP_HTTP}/json/list`);
  const target = pages.find((p) => p.title.includes('时间轴') && p.type === 'page');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
    setTimeout(() => reject(new Error('ws timeout')), 10_000);
  });
  const cdp = new CdpClient(ws);
  await cdp.send('Runtime.enable');

  const timeline = generateTimeline(500, 8);
  const branches = timeline.lanes.map((l) => ({ name: l.label, isDefault: l.order === 0, protected: false, starred: false, lastCommit: null }));

  const injectExpr = `
    (() => {
      const vm = window.__timelineVm;
      if (!vm) return { error: 'no vm' };
      vm.branches = ${JSON.stringify(branches)};
      vm.timeline = ${JSON.stringify(timeline)};
      vm.selectedBranches = new Set(['main']);
      vm.loadTimeline = () => Promise.resolve();
      return { ok: true };
    })()
  `;
  await cdp.send('Runtime.evaluate', { expression: injectExpr, returnByValue: true });

  // 测量单个 computed 的首次执行时间（注入后立即访问，触发重算）
  const measureExpr = `
    (() => {
      const vm = window.__timelineVm;
      const times = {};
      const t0 = performance.now();
      const sn = vm.sortedNodes; times.sortedNodes = performance.now() - t0;
      const t1 = performance.now();
      const lm = vm.laneXMap; times.laneXMap = performance.now() - t1;
      const t2 = performance.now();
      const ny = vm.nodeYMap; times.nodeYMap = performance.now() - t2;
      const t3 = performance.now();
      const ml = vm.mainLane; times.mainLane = performance.now() - t3;
      const t4 = performance.now();
      const hm = vm.heatmap; times.heatmap = performance.now() - t4;
      const t5 = performance.now();
      const gp = vm.graphPaths; times.graphPaths = performance.now() - t5;
      const t6 = performance.now();
      const cr = vm.commitRows; times.commitRows = performance.now() - t6;
      return { times, counts: { sortedNodes: sn.length, graphPaths: gp.length, commitRows: cr.length, heatmapTotal: hm?.total } };
    })()
  `;
  const res = await cdp.send('Runtime.evaluate', { expression: measureExpr, returnByValue: true });
  console.log(JSON.stringify(res.result?.value, null, 2));

  cdp.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
