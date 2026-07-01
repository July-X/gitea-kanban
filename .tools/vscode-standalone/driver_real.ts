// DeepSeek-Reasonix 真实 commit 跑 vscode-git-graph 真实算法
// 输入: /tmp/vscode-commits.json (commit 数组 + head)
// 输出: JSON 含真实 vscode 的 branches + vertices

import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!DOCTYPE html><html><body><div id="test"></div></body></html>');
(global as any).document = dom.window.document;
(global as any).window = dom.window;
(global as any).SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
(global as any).HTMLElement = dom.window.HTMLElement;
(global as any).MouseEvent = dom.window.MouseEvent;
(global as any).UNCOMMITTED = '*';

import * as fs from 'fs';
import { Graph } from '/tmp/vscode-graph-runtime/out/graph.js';

const config = {
  colours: ['#0085d9', '#d9008f', '#00d90a', '#d98500', '#a300d9', '#ff0000', '#00d9cc', '#e138e8', '#85d900', '#dc5b23', '#6f24d6', '#ffcc00'],
  style: 0,
  grid: { x: 16, y: 24, offsetX: 16, offsetY: 12, expandY: 250 },
  uncommittedChanges: 0,
};

const inputPath = process.argv[2] || '/tmp/vscode-commits.json';
const data = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
const commits = data.commits;
const head = data.head;

const lookup: { [h: string]: number } = {};
for (let i = 0; i < commits.length; i++) lookup[commits[i].hash] = i;

const viewElem: any = dom.window.document.getElementById('test');
const muteConfig: any = { commits: [], avatars: {} };

const g = new (Graph as any)('test', viewElem, config, muteConfig);
g.loadCommits(commits, head, lookup, false);

const branches: any[] = (g as any).branches;
const vertices: any[] = (g as any).vertices;
const output = {
  config,
  branchCount: branches.length,
  branches: branches.map((b: any) => ({
    colour: b.colour,
    end: b.end,
    lines: b.lines.map((ln: any) => ({ p1: ln.p1, p2: ln.p2, lockedFirst: ln.lockedFirst })),
  })),
  vertices: vertices.map((v: any) => ({
    id: v.id,
    x: v.x,
    nextX: v.nextX,
    isCurrent: !!v.isCurrent,
    isStash: !!v.isStash,
  })),
};
console.log(JSON.stringify(output));