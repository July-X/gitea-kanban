#!/usr/bin/env node
import { get } from 'node:http';

const size = parseInt(process.argv[2] || '100', 10);

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

function generateTimeline(nodeCount = 100, laneCount = 8) {
  const labels = ['main', 'feature/merge', 'feature/kanban', 'develop', 'hotfix/auth', 'chore/ci', 'refactor/store', 'exp/x6'];
  const lanes = [];
  for (let i = 0; i < laneCount; i++) lanes.push({ id: `lane-${i}`, label: labels[i] || `lane-${i}`, order: i, color: '#74B830' });
  const nodes = [];
  const now = Date.now();
  for (let i = 0; i < nodeCount; i++) {
    const laneIdx = i % laneCount;
    nodes.push({
      id: `node-${i}`,
      sha: `abcdef${i.toString(16).padStart(32, '0')}`.slice(0, 40),
      shortSha: `abc${i.toString(16).padStart(4, '0')}`.slice(0, 7),
      message: `commit message ${i}`,
      timestamp: new Date(now - i * 3600_000).toISOString(),
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
  return { lanes, nodes, edges: [], totalCommits: nodes.length, truncated: false, range: { from: nodes[nodes.length - 1]?.timestamp || new Date().toISOString(), to: nodes[0]?.timestamp || new Date().toISOString() } };
}

const labels = ['main', 'feature/merge', 'feature/kanban', 'develop', 'hotfix/auth', 'chore/ci', 'refactor/store', 'exp/x6'];
const branches = labels.map((l, i) => ({ name: l, isDefault: i === 0, protected: false, starred: false, lastCommit: null }));
const timeline = generateTimeline(size, 8);

const expr = `
  (async () => {
    const vm = window.__timelineVm;
    vm.branches = ${JSON.stringify(branches)};
    vm.selectedBranches = new Set(['main']);
    vm.loadTimeline = () => Promise.resolve();
    const data = ${JSON.stringify(timeline)};
    const t0 = performance.now();
    vm.timeline = data;
    let rows = 0;
    while (rows < ${size} && performance.now() - t0 < 60000) {
      await new Promise((r) => setTimeout(r, 50));
      rows = document.querySelectorAll('.commit-row').length;
    }
    const t1 = performance.now();
    return { size: ${size}, ms: Math.round(t1 - t0), rows, paths: document.querySelectorAll('.commit-list__edges path').length };
  })()
`;

ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true, timeout: 70_000 } }));
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id === 1) {
    console.log(JSON.stringify(msg.result?.value ?? msg.result, null, 2));
    ws.close();
  }
};
