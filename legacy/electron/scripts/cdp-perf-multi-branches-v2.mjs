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

function generateTimeline(selectedBranches, nodesPerBranch = 200) {
  const allLabels = ['main', 'feature/merge', 'feature/kanban', 'develop', 'hotfix/auth', 'chore/ci', 'refactor/store', 'exp/x6'];
  const labels = allLabels.filter((l) => selectedBranches.includes(l));
  const lanes = labels.map((l, i) => ({ id: `lane-${i}`, label: l, order: i, color: '#74B830' }));
  const nodes = [];
  const now = Date.now();
  let idx = 0;
  for (const branch of labels) {
    const laneIdx = labels.indexOf(branch);
    for (let i = 0; i < nodesPerBranch; i++) {
      nodes.push({
        id: `node-${idx}`,
        sha: `abcdef${idx.toString(16).padStart(32, '0')}`.slice(0, 40),
        shortSha: `abc${idx.toString(16).padStart(4, '0')}`.slice(0, 7),
        message: `commit message ${idx}`,
        timestamp: new Date(now - idx * 3600_000).toISOString(),
        laneId: `lane-${laneIdx}`,
        isMerge: idx % 17 === 0,
        isHead: idx === 0,
        author: { name: `Author ${idx % 12}`, email: `a${idx}@test.com`, avatarUrl: '' },
        additions: idx % 50,
        deletions: idx % 30,
        filesChanged: idx % 10,
        branchHints: [branch],
        linkedCardIds: idx % 5 === 0 ? [idx] : [],
      });
      idx++;
    }
  }
  return { lanes, nodes, edges: [], totalCommits: nodes.length, truncated: false, range: { from: nodes[nodes.length - 1]?.timestamp || new Date().toISOString(), to: nodes[0]?.timestamp || new Date().toISOString() } };
}

const labels = ['main', 'feature/merge', 'feature/kanban', 'develop', 'hotfix/auth', 'chore/ci', 'refactor/store', 'exp/x6'];
const branches = labels.map((l, i) => ({ name: l, isDefault: i === 0, protected: false, starred: false, lastCommit: null }));

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

async function measure(branchCount) {
  const selected = labels.slice(0, branchCount);
  const timeline = generateTimeline(selected, 200);
  const expr = `
    (async () => {
      const vm = window.__timelineVm;
      vm.branches = ${JSON.stringify(branches)};
      vm.selectedBranches = new Set(${JSON.stringify(selected)});
      vm.loadTimeline = () => Promise.resolve();
      const data = ${JSON.stringify(timeline)};
      const t0 = performance.now();
      vm.timeline = data;
      const expected = ${timeline.nodes.length};
      let rows = 0;
      while (rows < expected && performance.now() - t0 < 60000) {
        await new Promise((r) => setTimeout(r, 50));
        rows = document.querySelectorAll('.commit-row').length;
      }
      const t1 = performance.now();
      return { branches: ${branchCount}, nodes: expected, ms: Math.round(t1 - t0), rows, paths: document.querySelectorAll('.commit-list__edges path').length };
    })()
  `;
  return cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 70_000 });
}

const results = [];
for (const bc of [1, 2, 4, 6, 8]) {
  const res = await measure(bc);
  results.push(res.result?.value ?? res.result);
  await cdp.send('Runtime.evaluate', { expression: `window.__timelineVm.timeline={lanes:[],nodes:[],edges:[]}`, returnByValue: true });
  await new Promise((r) => setTimeout(r, 500));
}
console.log(JSON.stringify(results, null, 2));
ws.close();
