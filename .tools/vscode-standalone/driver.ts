// Setup global document via jsdom
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!DOCTYPE html><html><body><div id="view"></div></body></html>');
(global as any).document = dom.window.document;
(global as any).window = dom.window;
(global as any).SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
(global as any).HTMLElement = dom.window.HTMLElement;
(global as any).MouseEvent = dom.window.MouseEvent;

import { Graph } from '/tmp/vscode-graph-runtime/out/graph.js';

const config = {
  colours: ['#0085d9', '#d9008f', '#00d90a', '#d98500', '#a300d9', '#ff0000', '#00d9cc', '#e138e8', '#85d900', '#dc5b23', '#6f24d6', '#ffcc00'],
  style: 0,
  grid: { x: 16, y: 24, offsetX: 16, offsetY: 12, expandY: 250 },
  uncommittedChanges: 0,
};

const commits = [
  { hash: 'c5', parents: ['c4'], author: 'x', email: 'x@y.z', date: 0, message: 'c5', heads: [], tags: [], remotes: [], stash: null },
  { hash: 'c4', parents: ['c3'], author: 'x', email: 'x@y.z', date: 0, message: 'c4', heads: [], tags: [], remotes: [], stash: null },
  { hash: 'c3', parents: ['c2'], author: 'x', email: 'x@y.z', date: 0, message: 'c3', heads: [], tags: [], remotes: [], stash: null },
  { hash: 'c2', parents: ['c1'], author: 'x', email: 'x@y.z', date: 0, message: 'c2', heads: [], tags: [], remotes: [], stash: null },
  { hash: 'c1', parents: [], author: 'x', email: 'x@y.z', date: 0, message: 'c1', heads: [], tags: [], remotes: [], stash: null },
];
const lookup = { c1: 4, c2: 3, c3: 2, c4: 1, c5: 0 };

const viewElem: any = dom.window.document.getElementById('view');
const muteConfig: any = { commits: [], avatars: {} };

const g = new (Graph as any)('test', viewElem, config, muteConfig);
g.loadCommits(commits, 'c5', lookup, false);

const branches: any[] = (g as any).branches;
const vertices: any[] = (g as any).vertices;
const output = {
  branchCount: branches.length,
  branches: branches.map((b: any) => ({
    colour: b.colour,
    end: b.end,
    lines: b.lines.map((ln: any) => ({ p1: ln.p1, p2: ln.p2, lockedFirst: ln.lockedFirst })),
  })),
  vertices: vertices.map((v: any) => ({ id: v.id, x: v.x, nextX: v.nextX, onBranch: v.onBranch ? 'yes' : 'no', isStash: v.isStash })),
};
console.log(JSON.stringify(output, null, 2));