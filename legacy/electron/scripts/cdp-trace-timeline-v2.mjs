#!/usr/bin/env node
import { get } from 'node:http';
import { writeFileSync } from 'node:fs';

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
    this.events = [];
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
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
  waitForEvent(method, timeoutMs = 60_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), timeoutMs);
      const check = () => {
        const idx = this.events.findIndex((e) => e.method === method);
        if (idx >= 0) {
          clearTimeout(timer);
          resolve(this.events.splice(idx, 1)[0]);
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    });
  }
  close() {
    this.ws.close();
  }
}

function generateTimeline(nodeCount = 500, laneCount = 8) {
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

  const labels = ['main', 'feature/merge', 'feature/kanban', 'develop', 'hotfix/auth', 'chore/ci', 'refactor/store', 'exp/x6'];
  const branches = labels.map((l, i) => ({ name: l, isDefault: i === 0, protected: false, starred: false, lastCommit: null }));
  const timeline = generateTimeline(500, 8);

  // 先设置好分支
  await cdp.send('Runtime.evaluate', {
    expression: `(()=>{ const vm=window.__timelineVm; vm.branches=${JSON.stringify(branches)}; vm.selectedBranches=new Set(['main']); vm.loadTimeline=()=>Promise.resolve(); return 'ok'; })()`,
    returnByValue: true,
  });

  // 开始 trace
  await cdp.send('Tracing.start', {
    categories: 'devtools.timeline,v8,blink,cc,loading,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.frame',
    transferMode: 'ReportEvents',
  });

  // 注入 500 节点数据
  const clickScript = `
    (async () => {
      const vm = window.__timelineVm;
      const data = ${JSON.stringify(timeline)};
      vm.timeline = data;
      await new Promise((r) => setTimeout(r, 500));
      return document.querySelectorAll('.commit-row').length;
    })()
  `;
  const res = await cdp.send('Runtime.evaluate', {
    expression: clickScript,
    awaitPromise: true,
    returnByValue: true,
    timeout: 60_000,
  });
  console.log('rows:', res.result?.value);

  await cdp.send('Tracing.end');
  const complete = await cdp.waitForEvent('Tracing.tracingComplete', 60_000);
  const events = cdp.events.filter((e) => e.method === 'Tracing.dataCollected').flatMap((e) => e.params.value);
  const outPath = '/tmp/timeline-trace-500.json';
  writeFileSync(outPath, JSON.stringify(events));
  console.log('trace saved to', outPath, 'events', events.length);
  cdp.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
