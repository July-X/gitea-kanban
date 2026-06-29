/**
 * Git Graph SVG path 生成 —— 对齐 Gitea 路径（structured.ts）的 SourceTree 风格几何
 *
 * v2.46：把 ASCII 路径从"复刻 Gitea git log --graph 字符流"(右缘对齐 5px/lane)
 *        改成"对齐 structured 路径 LANE_WIDTH=10 中线对齐"——两侧视觉规则一致。
 *
 * 坐标公式（列宽 COL_WIDTH unit / 行高 ROW_HEIGHT unit，**lane 中线对齐**）：
 *   - '*' | '|'      → M (col*CW + CW/2) (row*RH + 0) v RH
 *                        垂直线，本 lane 中线
 *   - '/'            → M ((col+1)*CW + CW/2) (row*RH + 0) l (-2*CW) RH
 *                        起点：右邻 lane (col+1) 中线
 *                        终点：左邻 lane (col-1) 中线
 *                        跨 2 lane（git log --graph 的 / 是合并线，从右上斜向左下）
 *   - '\\'           → M ((col-1)*CW + CW/2) (row*RH + 0) l (2*CW) RH
 *                        起点：左邻 lane (col-1) 中线
 *                        终点：右邻 lane (col+1) 中线
 *                        跨 2 lane（\ 是分叉线，从左上斜向右下）
 *   - '-' | '.'      → M (col*CW - CW/2) (row*RH + RH) h CW
 *                        底部水平短线（lane 左缘 → 中线 → 右缘，1 个 lane 宽）
 *   - '_'            → M (col*CW - CW/2) (row*RH + RH) h 2*CW
 *                        底部水平长线（lane 左缘 → 中线 → 右缘 → 右邻中线，2 个 lane 宽）
 *
 * 这些公式跟 structured.ts laneX(lane) = lane*LANE_WIDTH + LANE_WIDTH/2 + FLOW_LEFT_PAD
 * 完全镜像 dot 的中线公式：column*COL_WIDTH + COL_WIDTH/2 + FLOW_LEFT_PAD，
 * dot cx 也用中线公式，
 * path d 与 dot 都在 lane 中线对齐（SourceTree 风格）。
 *
 * 关键前提：g.column 是 ASCII 字符流下标（lane 编号），不是 flowID。
 * 见 parser.ts addLineToGraph 的注释。
 *
 * 一个 flow 的所有 glyph path 段拼接成一个 d 字符串（用空格分隔），
 * 渲染端直接 `<path :d="path.d" ...>`。
 */

import type { Flow, Glyph, GitGraphCommit, Graph } from './models.js';
import { COL_WIDTH, FLOW_LEFT_PAD, ROW_HEIGHT } from './models.js';

// ============================================================
// 单字形 → path d 段
// ============================================================

/** 单字形 → path d 段字符串
 *
 * v2.42：所有 path 内部 x 坐标 +FLOW_LEFT_PAD（与 dot cx 公式一致）。
 * v2.46：把 path x 从"lane 右缘 (col*CW + CW)"改成"lane 中线 (col*CW + CW/2)"，
 *        与 structured 路径 laneX() 公式对齐（structured LANE_WIDTH=10 → 中线 lane*10+5）。
 *   viewBox.x = minColumn * COL_WIDTH（不偏移），path 内部 +FLOW_LEFT_PAD + COL_WIDTH/2，
 *   path 渲染位置 = (column*10 + 5 + 4 - minColumn*10) = (column-minColumn)*10 + 9，
 *   与 dot cx (column*10 + 5 - minX + 4) = (column-minColumn)*10 + 9 完全一致 ✓。*/
export function glyphToPathD(g: Glyph): string {
  const xCenter = g.column * COL_WIDTH + COL_WIDTH / 2 + FLOW_LEFT_PAD;
  const y = g.row * ROW_HEIGHT;
  switch (g.glyph) {
    case '*':
    case '|':
      // 垂直线 v ROW_HEIGHT（本列中线）
      return `M ${xCenter} ${y} v ${ROW_HEIGHT}`;
    case '/': {
      // / 从右邻 lane (col+1) 中线斜向左下到左邻 lane (col-1) 中线（跨 2 lane）
      //
      // 跨 2 lane 几何：起点 ((col+1)*CW + CW/2)，终点 ((col-1)*CW + CW/2)，
      // 横向距离 = (col+1 - (col-1)) * CW = 2*CW，纵向 ROW_HEIGHT，斜率 = RH/(2*CW) = 30/20 = 1.5
      // (v2.46 前 CW=5 时斜率 30/10=3.0，更陡)。
      const sx = (g.column + 1) * COL_WIDTH + COL_WIDTH / 2 + FLOW_LEFT_PAD;
      const ex = (g.column - 1) * COL_WIDTH + COL_WIDTH / 2 + FLOW_LEFT_PAD;
      return `M ${sx} ${y} l ${ex - sx} ${ROW_HEIGHT}`;
    }
    case '\\': {
      // \ 从左邻 lane (col-1) 中线斜向右下到右邻 lane (col+1) 中线（跨 2 lane）
      const sx = (g.column - 1) * COL_WIDTH + COL_WIDTH / 2 + FLOW_LEFT_PAD;
      const ex = (g.column + 1) * COL_WIDTH + COL_WIDTH / 2 + FLOW_LEFT_PAD;
      return `M ${sx} ${y} l ${ex - sx} ${ROW_HEIGHT}`;
    }
    case '-':
    case '.':
      // 底部水平短线（从本 lane 左缘 → 右缘，长 1 个 lane = CW）
      return `M ${xCenter - COL_WIDTH / 2} ${y + ROW_HEIGHT} h ${COL_WIDTH}`;
    case '_':
      // 底部水平长线（从本 lane 左缘 → 右邻 lane 中线，长 2 个 lane = 2*CW）
      return `M ${xCenter - COL_WIDTH / 2} ${y + ROW_HEIGHT} h ${2 * COL_WIDTH}`;
    default:
      return '';
  }
}

// ============================================================
// Flow → 单条 path d
// ============================================================

/**
 * 一个 flow 的所有 glyph 拼成一条 path d。
 *
 * 返回空字符串表示该 flow 没有可视 glyph（孤立 commit / 仅含 ' '）。
 *
 * 注：glyphs 应该**已经按 (row, column) 升序排好**（parser.ts 收尾时会排），
 * 渲染出来的 path 在 SVG 里视觉上"自顶向下"扫描，与 commit 列表对齐。
 */
export function flowToPathD(flow: Flow): string {
  if (flow.glyphs.length === 0) return '';
  const parts: string[] = [];
  for (const g of flow.glyphs) {
    const d = glyphToPathD(g);
    if (d) parts.push(d);
  }
  return parts.join(' ');
}

// ============================================================
// flowToPathDCompact —— display row 压缩版
// ============================================================

/**
 * 把一个 flow 的所有 commit 用紧凑 path 表示（用于 ASCII 字符流的 edge row
 * 已被压缩到 displayRow 的场景）。
 *
 * 背景：
 *   - parseLines 输出的 commit.row 是 ASCII 字符流行号（多 PR 场景下不连续：
 *     row 0/2/3/5/7/8/10 这种，中间有 edge row）
 *   - 如果直接拿 ASCII row 渲染 commit-row 容器 + 跟 svgHeight 同步，会在两个
 *     commit 之间出现"看不见的 30px 空行"（edge row 占据 grid 单元格）
 *   - 修复方案：把 commit 排成连续 displayRow 0..N-1，grid 容器跟 commit 数对齐
 *     → 这里就需要 path d 也在 displayRow 坐标系里绘制
 *
 * 算法（v2.65 复刻 VSCode Git Graph）：
 *   1. 把 flow.commits 按 row 升序
 *   2. 用 rowRemap 查每个 commit 的 displayRow
 *   3. 顺序连点：
 *      - 同 lane → 垂直 V 命令
 *      - 跨 lane → S 曲线 C 命令，控制点 y = midpoint ± curveDy
 *        (curveDy = 8px，给曲线一个优雅的弧度——不夸张，跨短距离不抖动)
 *   4. 末尾追加 ROW_HEIGHT 竖线让线条穿过最后一个 commit 的 row
 *
 * 与原 flowToPathD 的差别：
 *   - 原版逐字形绘制，edge row（|, /, \, _ 等）每个都产生独立 d 段
 *   - 压缩版只看 commit，edge 几何被两个相邻 commit 的 (column, displayRow) 隐式表达
 *   - 视觉上 VSCode 风格：分叉 / 合并用 commit 之间的 S 曲线优雅表达
 *
 * v2.65（VSCode 风格）：
 *   - 同 lane 用 V 命令（垂直）
 *   - 跨 lane 用 S 曲线（C 命令）—— 比直线更优雅，跨行时的视觉过渡更自然
 *   - 支持 rowOffset 累加：手风琴展开时，displayRow >= expandedIndex 的所有 commit
 *     y 坐标加 offsetPx，让 SVG 路径自动"拉伸延伸"覆盖展开行（VSCode 行为）
 */
export function flowToPathDCompact(
  flow: Flow,
  rowRemap: Map<number, number>,
  options?: { curve?: boolean; rowOffsets?: Map<number, number> },
): string {
  const rowOffsets = options?.rowOffsets;
  const commits = flow.commits
    .filter((c) => rowRemap.has(c.row))
    .sort((a, b) => a.row - b.row);
  if (commits.length < 1) return '';

  const remappedRows = [...rowRemap.entries()].sort((a, b) => a[0] - b[0]);
  const displayTop = (displayRow: number) =>
    displayRow * ROW_HEIGHT + (rowOffsets?.get(displayRow) ?? 0);

  const rowTop = (asciiRow: number): number => {
    const exact = rowRemap.get(asciiRow);
    if (exact !== undefined) return displayTop(exact);

    let prev: [number, number] | undefined;
    let next: [number, number] | undefined;
    for (const entry of remappedRows) {
      if (entry[0] < asciiRow) prev = entry;
      if (entry[0] > asciiRow) {
        next = entry;
        break;
      }
    }
    if (prev && next) {
      const [prevRow, prevDisplayRow] = prev;
      const [nextRow, nextDisplayRow] = next;
      const t = (asciiRow - prevRow) / (nextRow - prevRow);
      return displayTop(prevDisplayRow) + (displayTop(nextDisplayRow) - displayTop(prevDisplayRow)) * t;
    }
    if (prev) return displayTop(prev[1]) + (asciiRow - prev[0]) * ROW_HEIGHT;
    if (next) return displayTop(next[1]) - (next[0] - asciiRow) * ROW_HEIGHT;
    return asciiRow * ROW_HEIGHT;
  };

  const laneX = (column: number) => column * COL_WIDTH + COL_WIDTH / 2 + FLOW_LEFT_PAD;
  const parts: string[] = [];
  for (const g of flow.glyphs) {
    const y1 = rowTop(g.row);
    const y2 = rowTop(g.row + 1);
    const x = laneX(g.column);
    switch (g.glyph) {
      case '*':
      case '|':
        parts.push(`M ${x} ${y1} L ${x} ${y2}`);
        break;
      case '/': {
        const parentColumn = g.parentColumn ?? g.column - 1;
        parts.push(`M ${laneX(g.column + (g.column - parentColumn))} ${y1} L ${laneX(parentColumn)} ${y2}`);
        break;
      }
      case '\\': {
        const parentColumn = g.parentColumn ?? g.column - 1;
        parts.push(`M ${laneX(parentColumn)} ${y1} L ${laneX(g.column + (g.column - parentColumn))} ${y2}`);
        break;
      }
      case '-':
      case '.':
        parts.push(`M ${x - COL_WIDTH / 2} ${y2} L ${x + COL_WIDTH / 2} ${y2}`);
        break;
      case '_':
        parts.push(`M ${x - COL_WIDTH / 2} ${y2} L ${x + COL_WIDTH * 1.5} ${y2}`);
        break;
    }
  }

  return parts.join(' ');
}

export interface CompactGraphPath {
  id: string;
  colorNumber: number;
  d: string;
}

export interface VscodeGraphNode {
  sha: string;
  row: number;
  lane: number;
  colorNumber: number;
}

export interface VscodeGraphLayout {
  nodes: Map<string, VscodeGraphNode>;
  paths: CompactGraphPath[];
  laneCount: number;
}

export function layoutVscodeGraph(
  graph: Graph,
  rowRemap: Map<number, number>,
  options?: { rowOffsets?: Map<number, number> },
): VscodeGraphLayout {
  const rowOffsets = options?.rowOffsets;
  const commits = graph.commits
    .filter((c) => rowRemap.has(c.row))
    .sort((a, b) => a.row - b.row);
  if (commits.length === 0) return { nodes: new Map(), paths: [], laneCount: 0 };

  const bySha = new Map(commits.map((c) => [c.sha, c]));
  const visible = new Set(bySha.keys());
  const active: Array<{ sha: string; colorNumber: number }> = [];
  const nodeBySha = new Map<string, VscodeGraphNode>();
  const edges: Array<{ from: GitGraphCommit; to: GitGraphCommit; colorNumber: number }> = [];
  let nextColor = 0;
  let maxLane = 0;

  for (const commit of commits) {
    let lane = active.findIndex((entry) => entry.sha === commit.sha);
    if (lane < 0) {
      lane = active.length;
      active.push({ sha: commit.sha, colorNumber: nextColor++ });
    }

    const current = active[lane]!;
    nodeBySha.set(commit.sha, {
      sha: commit.sha,
      row: rowRemap.get(commit.row)!,
      lane,
      colorNumber: current.colorNumber,
    });

    active.splice(lane, 1);
    const visibleParents = commit.parents.filter((parentSha) => visible.has(parentSha));
    visibleParents.forEach((parentSha, parentIndex) => {
      const parent = bySha.get(parentSha)!;
      let parentLane = active.findIndex((entry) => entry.sha === parentSha);
      let colorNumber: number;

      if (parentLane < 0) {
        parentLane = Math.min(active.length, lane + (parentIndex === 0 ? 0 : parentIndex));
        colorNumber = parentIndex === 0 ? current.colorNumber : nextColor++;
        active.splice(parentLane, 0, { sha: parentSha, colorNumber });
      } else {
        colorNumber = active[parentLane]!.colorNumber;
      }

      edges.push({ from: commit, to: parent, colorNumber });
    });

    maxLane = Math.max(maxLane, lane, active.length - 1);
  }

  const displayTop = (displayRow: number) =>
    displayRow * ROW_HEIGHT + (rowOffsets?.get(displayRow) ?? 0);
  const point = (commit: GitGraphCommit) => {
    const node = nodeBySha.get(commit.sha)!;
    return {
      x: node.lane * COL_WIDTH + COL_WIDTH / 2 + FLOW_LEFT_PAD,
      y: displayTop(node.row) + ROW_HEIGHT / 2,
    };
  };
  const colorOf = (commit: GitGraphCommit) => nodeBySha.get(commit.sha)?.colorNumber ?? 0;
  const edgePath = (from: GitGraphCommit, to: GitGraphCommit) => {
    const a = point(from);
    const b = point(to);
    if (a.x === b.x) return `M ${a.x} ${a.y} L ${b.x} ${b.y}`;

    const dir = b.y > a.y ? 1 : -1;
    const turnY = a.y + dir * ROW_HEIGHT / 2;
    const ease = ROW_HEIGHT / 3;
    return `M ${a.x} ${a.y} C ${a.x} ${a.y + dir * ease}, ${b.x} ${turnY - dir * ease}, ${b.x} ${turnY} L ${b.x} ${b.y}`;
  };

  const paths: CompactGraphPath[] = [];
  const hasVisibleChild = new Set<string>();
  for (const edge of edges) {
    hasVisibleChild.add(edge.to.sha);
    paths.push({
      id: `${edge.from.sha}-${edge.to.sha}`,
      colorNumber: edge.colorNumber,
      d: edgePath(edge.from, edge.to),
    });
  }

  for (const commit of commits) {
    const visibleParentCount = commit.parents.filter((parentSha) => bySha.has(parentSha)).length;
    if (visibleParentCount > 0 || hasVisibleChild.has(commit.sha)) {
      continue;
    }
    const p = point(commit);
    paths.push({
      id: `${commit.sha}-stub`,
      colorNumber: colorOf(commit),
      d: `M ${p.x} ${p.y - ROW_HEIGHT / 2} L ${p.x} ${p.y + ROW_HEIGHT / 2}`,
    });
  }

  const laneCount = Math.max(0, maxLane, ...[...nodeBySha.values()].map((node) => node.lane)) + 1;
  return { nodes: nodeBySha, paths, laneCount };
}

export function graphToParentPaths(
  graph: Graph,
  rowRemap: Map<number, number>,
  options?: { rowOffsets?: Map<number, number> },
): CompactGraphPath[] {
  return layoutVscodeGraph(graph, rowRemap, options).paths;
}
