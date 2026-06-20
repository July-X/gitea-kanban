#!/usr/bin/env node
/**
 * scripts/cdp-timeline-graph-fix.mjs
 *
 * v1.5 任务 #timeline-graph-fix 实测：注入 mock timeline 数据 → 截图对比
 * 复现"分支节点间垂直线穿过 main 节点行"的错位场景
 *
 * 数据设计（复刻 user 截图）：
 *   - branches=['feature/foo', 'main']
 *   - 12 commit，按时间倒序排列如截图：bd13aa8 → 4c0adeb → a03c751 → 6cb1a38
 *     → 7a2364f → f30ece0(merge) → 54244ed → 1247e33 → d43a4ea → 8b14b51
 *     → 7345d4c → 6d5e6c
 *   - feature/foo fork 自 a03c751，复 fork 自 d43a4ea，f30ece0 是 merge commit
 *   - 完整 edges（parent + merge 关系）
 *
 * 跑法：
 *   1. pnpm preview（起 electron + CDP 端口 9492）
 *   2. node scripts/cdp-timeline-graph-fix.mjs /tmp/timeline-graph-fix.png
 */
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
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
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
  close() { this.ws.close(); }
}

/** 构造 mock timeline 数据，复刻截图错位场景 */
function buildMockTimeline() {
  const now = Date.now();
  const hour = 3600_000;
  // 时间戳：t=小时前；t=11 最老，t=0 最新（最新 = head）
  // 按 sortedNodes 倒序期望：bd13aa8(t=11) → ... → 6d5e6c(t=0)
  // 但 sortedNodes 是从 timeline.value.nodes 按 timestamp 倒序排
  // 所以 timeline.value.nodes（升序）= [6d5e6c(t=0), 7345d4c(t=1), 8b14b51(t=2),
  //   d43a4ea(t=3), 1247e33(t=4), 54244ed(t=5), f30ece0(t=6), 7a2364f(t=7),
  //   6cb1a38(t=8), a03c751(t=9), 4c0adeb(t=10), bd13aa8(t=11)]
  // 倒序后 i=0 = bd13aa8（newest），i=11 = 6d5e6c（oldest）—— 跟截图一致
  const mk = (sha, branchHints, parents, isMerge, t) => ({
    id: sha,
    laneId: `branch:${branchHints[0]}`,
    x: 0,
    y: 0,
    sha,
    shortSha: sha.slice(0, 7),
    message: '',
    author: { name: 'Test', email: 'test@test.com' },
    timestamp: new Date(now - t * hour).toISOString(),
    parents,
    isMerge,
    branchHints,
    linkedCardIds: [],
  });

  // t=小时前；t=0 最新（newest），t=11 最老（oldest）
  // 时间序（newest → oldest）：bd13aa8 → 4c0adeb → a03c751 → 6cb1a38 → 7a2364f →
  //   f30ece0(merge, foo) → 54244ed → 1247e33 → d43a4ea → 8b14b51 → 7345d4c → 6d5e6c
  // 注：f30ece0 是 merge commit（在 7a2364f 之后 → t 更小），其 parent 54244ed (t=6) 老于 f30ece0 (t=5)
  const commits = {
    'bd13aa8': mk('bd13aa8test00000000000000000000000000', ['main'], ['4c0adeb'], false, 0),
    '4c0adeb': mk('4c0adebtest00000000000000000000000000', ['main'], ['a03c751'], false, 1),
    'a03c751': mk('a03c751test00000000000000000000000000', ['main'], ['1247e33'], false, 2),
    '6cb1a38': mk('6cb1a38test00000000000000000000000000', ['feature/foo'], ['7a2364f'], false, 3),
    '7a2364f': mk('7a2364ftest00000000000000000000000000', ['feature/foo'], ['f30ece0'], false, 4),
    'f30ece0': mk('f30ece0test00000000000000000000000000', ['feature/foo'], ['54244ed', '1247e33'], true, 5),
    '54244ed': mk('54244edtest00000000000000000000000000', ['feature/foo'], ['a03c751'], false, 6),
    '1247e33': mk('1247e33test00000000000000000000000000', ['main'], ['d43a4ea'], false, 7),
    'd43a4ea': mk('d43a4eatest00000000000000000000000000', ['main'], ['6d5e6c'], false, 8),
    '8b14b51': mk('8b14b51test00000000000000000000000000', ['feature/foo'], ['7345d4c'], false, 9),
    '7345d4c': mk('7345d4ctest00000000000000000000000000', ['feature/foo'], ['d43a4ea'], false, 10),
    '6d5e6c': mk('6d5e6ctest000000000000000000000000000', ['main'], [], false, 11),
  };

  // 关键：isHead 标记（render 时只给 sortedNodes[0]）
  // sortedNodes 是时间降序（newest first），所以 i=0 = newest = bd13aa8
  const sortedSha = ['bd13aa8', '4c0adeb', 'a03c751', '6cb1a38', '7a2364f', 'f30ece0', '54244ed', '1247e33', 'd43a4ea', '8b14b51', '7345d4c', '6d5e6c'];
  for (const [i, sha] of sortedSha.entries()) commits[sha].isHead = i === 0;

  // message 字段
  const messages = {
    'bd13aa8': 'chore: baseline update',
    '4c0adeb': 'chore: multi-file refactor',
    'a03c751': 'chore: multi-line cleanup',
    '6cb1a38': 'chore: baseline sync',
    '7a2364f': 'chore: baseline lock',
    'f30ece0': 'Merge pull request #5 from feature/foo',
    '54244ed': 'feat: merged handshake',
    '1247e33': 'chore(seed): timeline layout',
    'd43a4ea': 'chore(seed): rebase',
    '8b14b51': 'chore(seed): column mapping',
    '7345d4c': 'chore(seed): labels sync',
    '6d5e6c': 'chore(seed): project init',
  };
  for (const [sha, msg] of Object.entries(messages)) commits[sha].message = msg;

  const lanes = [
    // 真实场景：branches 顺序不一定是 main 在前
    // mainLane = order=0 的 lane；这里把 main 放 order=0 让它成为 mainLane（贯穿线画在 main x）
    { id: 'branch:main', label: 'main', kind: 'branch', color: '#6c757d', order: 0, hidden: false },
    { id: 'branch:feature/foo', label: 'feature/foo', kind: 'branch', color: '#f76707', order: 1, hidden: false },
  ];

  // nodes 数组：按时间升序（oldest → newest），前端 sortedNodes 倒序
  const nodes = sortedSha.slice().reverse().map((sha) => commits[sha]);

  // edges：parent + merge 关系（source/target 用完整 sha 跟 node.id 匹配）
  const sha = Object.fromEntries(Object.entries(commits).map(([k, v]) => [k, v.id]));
  const edges = [
    { id: 'bd13aa8->4c0adeb:parent', source: sha.bd13aa8, target: sha['4c0adeb'], kind: 'parent' },
    { id: '4c0adeb->a03c751:parent', source: sha['4c0adeb'], target: sha.a03c751, kind: 'parent' },
    { id: 'a03c751->1247e33:parent', source: sha.a03c751, target: sha['1247e33'], kind: 'parent' },
    { id: '1247e33->d43a4ea:parent', source: sha['1247e33'], target: sha.d43a4ea, kind: 'parent' },
    { id: 'd43a4ea->6d5e6c:parent', source: sha.d43a4ea, target: sha['6d5e6c'], kind: 'parent' },
    { id: '54244ed->a03c751:parent', source: sha['54244ed'], target: sha.a03c751, kind: 'parent' },
    { id: 'f30ece0->54244ed:parent', source: sha.f30ece0, target: sha['54244ed'], kind: 'parent' },
    { id: 'f30ece0->1247e33:merge', source: sha.f30ece0, target: sha['1247e33'], kind: 'merge', prIndex: 1 },
    { id: '7a2364f->f30ece0:parent', source: sha['7a2364f'], target: sha.f30ece0, kind: 'parent' },
    { id: '6cb1a38->7a2364f:parent', source: sha['6cb1a38'], target: sha['7a2364f'], kind: 'parent' },
    { id: '8b14b51->d43a4ea:parent', source: sha['8b14b51'], target: sha.d43a4ea, kind: 'parent' },
    { id: '7345d4c->8b14b51:parent', source: sha['7345d4c'], target: sha['8b14b51'], kind: 'parent' },
  ];

  const oldest = nodes[0].timestamp;
  const newest = nodes[nodes.length - 1].timestamp;

  return {
    windowStart: oldest,
    windowEnd: newest,
    range: { from: oldest, to: newest },
    lanes,
    nodes,
    edges,
    prs: [
      { id: 'pr-1', index: 1, title: 'Merge feature/foo', state: 'merged', head: 'feature/foo', base: 'main', author: { name: 'Test' }, url: 'http://example.com/pr/1', mergedAt: commits['f30ece0'].timestamp },
    ],
    truncated: false,
    totalCommits: nodes.length,
  };
}

async function main() {
  const outPath = process.argv[2] ?? '/tmp/timeline-graph-fix.png';
  console.log('--- CDP target list ---');
  const pages = await httpGetJson(`${CDP_HTTP}/json/list`);
  console.log(JSON.stringify(pages.map((p) => ({ title: p.title, type: p.type, url: p.url })), null, 2));

  // 找 timeline 视图 page（优先 file:// 的 app page，排除 devtools:// 前端）
  let target = pages.find((p) => p.type === 'page' && p.url.startsWith('file://') && (p.title.includes('时间轴') || p.url.includes('timeline')));
  if (!target) target = pages.find((p) => p.type === 'page' && p.url.startsWith('file://'));
  if (!target) throw new Error('no app page target found');
  console.log('using target:', target.title, target.url);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
    setTimeout(() => reject(new Error('ws timeout')), 10_000);
  });
  const cdp = new CdpClient(ws);
  await cdp.send('Runtime.enable');

  // 导航到时间轴页（如果还没到）
  const navRes = await cdp.send('Runtime.evaluate', {
    expression: `(()=>{ if(!location.hash.startsWith('#/timeline')){ location.hash = '#/timeline'; } return location.hash; })()`,
    returnByValue: true,
  });
  console.log('navigated to:', navRes.result.value);

  // 等 vue 渲染
  await new Promise((r) => setTimeout(r, 1500));

  const mock = buildMockTimeline();
  console.log('mock timeline: nodes=', mock.nodes.length, 'edges=', mock.edges.length, 'lanes=', mock.lanes.length);

  // 注入 mock 数据（通过 window.__timelineVm，dev-only 暴露）
  const injRes = await cdp.send('Runtime.evaluate', {
    expression: `(()=>{ const vm = window.__timelineVm; if(!vm){ return { ok:false, err:'window.__timelineVm not exposed' }; } vm.setTimeline(${JSON.stringify(mock)}); vm.branches.value = [{name:'feature/foo', isDefault:false}, {name:'main', isDefault:true}]; vm.selectedBranches.value = new Set(['feature/foo','main']); return { ok:true, hasGraphPaths: typeof vm.graphPaths, graphPathsLen: (vm.graphPaths?.value ?? vm.graphPaths)?.length ?? -1, nodeCount: (vm.commitRows?.value ?? vm.commitRows)?.length ?? -1 }; })()`,
    returnByValue: true,
    awaitPromise: false,
  });
  console.log('inject result:', JSON.stringify(injRes.result.value));

  // 等 DOM 重渲染
  await new Promise((r) => setTimeout(r, 800));

  // 截 .timeline__graph-section 区域
  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  });
  writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
  console.log('saved screenshot to:', outPath);

  // 额外 dump graphPaths 数量 + node count + 每条 path 详情
  const dump = await cdp.send('Runtime.evaluate', {
    expression: `(()=>{ const vm = window.__timelineVm; const paths = vm?.graphPaths?.value ?? vm?.graphPaths; const nodes = vm?.sortedNodes?.value ?? vm?.sortedNodes; return { nodeCount: vm?.commitRows?.value?.length ?? -1, graphPathsCount: Array.isArray(paths) ? paths.length : -1, sortedIdxRange: nodes?.length ?? -1, allPaths: (paths ?? []).map((p,i) => ({ i, type: p.isBridge ? 'bridge' : (p.dashed ? 'dashed' : 'normal'), d: p.d, color: p.color })), sortedNodesOrder: (nodes ?? []).map(n => ({ sha: n.sha.slice(0,7), laneId: n.laneId, i: nodes.indexOf(n) })) }; })()`,
    returnByValue: true,
  });
  console.log('render dump:', JSON.stringify(dump.result.value, null, 2));

  cdp.close();
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});