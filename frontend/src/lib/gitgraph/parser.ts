/**
 * Git Graph Parser —— 1:1 移植 Gitea services/repository/gitgraph/parser.go
 *
 * 算法来源：~/2026/code/gitea/services/repository/gitgraph/parser.go（MIT）
 *   - 主解析状态机：`ParseGlyphs` + `setUpFlow` / `setOutFlow` / `setInFlow` /
 *                    `setRightFlow` / `setLeftFlow`
 *   - 颜色管理：`releaseUnusedColors` + `newFlow`
 *
 * 与 Gitea 原版的等价性：
 *   - 输入：`graph --graph --date-order` 的逐行字形字符串
 *     （不含 DATA: 之后的 commit 数据段）
 *   - 输出：Graph（Flows + Commits + 包围盒），与 Gitea `Graph.LoadAndProcessCommits` 前的形态一致
 *   - 颜色：用 `availableColors` 环形池 + `firstInUse/firstAvailable/nextAvailable`
 *           三个指针管理（与 parser.go 完全一致的复用策略）
 *
 * 状态变量命名对齐（方便 cross-reference Gitea 源码）：
 *   parser.go             | parser.ts
 *   --------------------- | -----------------
 *   glyphs / oldGlyphs    | glyphs / oldGlyphs（每次 swap）
 *   flows / oldFlows      | flows / oldFlows
 *   colors / oldColors    | colors / oldColors
 *   maxFlow               | maxFlow
 *   availableColors       | availableColors
 *   nextAvailable         | nextAvailable（-1 = 满）
 *   firstInUse            | firstInUse（-1 = 没人用）
 *   firstAvailable        | firstAvailable
 *   maxAllowedColors      | maxAllowedColors（0 = 默认 2 色）
 *
 * 字符规则（与 parser.go `ParseGlyphs` switch 对齐）：
 *   '|' '*' → setUpFlow
 *   '/'     → setOutFlow
 *   '\\'    → setInFlow（TS 写 '\\' 因为 \\ 是字符串里的反斜杠）
 *   '_'     → setRightFlow
 *   '.' '-' → setLeftFlow
 *   ' '     → 跳过
 *   其它    → newFlow
 *
 * 颜色映射（与 Gitea 一致）：
 *   flow.colorNumber → CSS class `flow-color-16-{colorNumber % 16}`
 *   每个 flow 在创建时从 availableColors 环形池拿一个色号，重复释放/复用
 */

import {
  newGraph,
  newFlow,
  RELATION_COMMIT_ID,
  compactColumns,
  type Flow,
  type GitGraphCommit,
  type Glyph,
  type Graph,
} from './models.js';
import type { GraphLine } from './types.js';

// ============================================================
// 常量
// ============================================================

/** 默认颜色数（maxAllowedColors = 0 时，环形池预填 [1, 2]） */
const DEFAULT_MAX_COLORS = 0;

/** 颜色编号 1-based，与 Gitea parser.go 一致 */
const INITIAL_COLORS: readonly number[] = [1, 2];

// ============================================================
// Parser 状态（与 Gitea parser.go Parser struct 字段一一对应）
// ============================================================

/**
 * Parser 内部状态。
 *
 * 注：与 Gitea 不同，我们把"swap oldGlyphs/glyphs"从 ParseGlyphs 入口移到了
 * setXxx 之前的清理阶段；语义等价（parseGlyphs 先清理再做 setUpFlow 等分支）。
 */
export class Parser {
  /** 当前行字形（即将被解析的目标） */
  glyphs: string = '';
  /** 上一行字形 */
  oldGlyphs: string = '';
  /** 当前行各列的 flow id */
  flows: number[] = [];
  /** 上一行各列的 flow id */
  oldFlows: number[] = [];
  /** 全局 flow id 自增计数器 */
  maxFlow: number = 0;
  /** 当前行各列的 colorNumber */
  colors: number[] = [];
  /** 上一行各列的 colorNumber */
  oldColors: number[] = [];

  /** 颜色环形池（存的是颜色编号，不是下标） */
  availableColors: number[] = [];
  /** 池中下一个可取色号的下标（-1 表示池已满且无空位可扩展） */
  nextAvailable: number = 0;
  /** 池中"正在使用"区间起点（-1 = 当前没人用色） */
  firstInUse: number = -1;
  /** 池中"空闲"区间起点 */
  firstAvailable: number = 0;
  /** 颜色上限（0 = 默认 2 色） */
  maxAllowedColors: number = DEFAULT_MAX_COLORS;

  reset(maxAllowedColors: number = DEFAULT_MAX_COLORS): void {
    this.maxFlow = 0;
    this.availableColors = [...INITIAL_COLORS];
    this.nextAvailable = 0;
    this.firstInUse = -1;
    this.firstAvailable = 0;
    this.maxAllowedColors = maxAllowedColors;
    // 清空 buffers
    this.glyphs = '';
    this.oldGlyphs = '';
    this.flows = [];
    this.oldFlows = [];
    this.colors = [];
    this.oldColors = [];
  }
}

// ============================================================
// 内部：flow 创建 / 颜色分配（与 parser.go newFlow / takePreviousFlow 一致）
// ============================================================

/**
 * 颜色复用 —— 释放 oldColors 中已经"不再被任何 active flow 使用"的颜色，
 * 让它们重新回到 availableColors 空闲段。
 *
 * 严格对齐 Gitea `releaseUnusedColors`（graph_test.go 的 TestReleaseUnusedColors
 * 覆盖了环形边界场景）。
 *
 * 算法核心：
 *   1. 在 oldColors 里找出"当前这一行还在用"的颜色集合（flows[i] != 0 的颜色）
 *   2. 把 availableColors 中"用过的部分（firstInUse 到 firstAvailable）"按"颜色
 *      仍然被使用 → 保留 / 不再被使用 → 排到 firstAvailable 之后"重排
 *   3. 这样 released 的颜色自然进入"空闲"区间，下一个 newFlow 时被取走
 */
function releaseUnusedColors(p: Parser): void {
  if (p.firstInUse <= -1) {
    // 没有 in-use 区间 → 上一行没人用色 → 不用回收
    return;
  }

  let stepsTaken = 0;
  let position = p.firstInUse;
  const poolLen = p.availableColors.length;

  for (const color of p.oldColors) {
    if (color === 0) continue;
    // 在环形池中查找 color 是否还"在用"
    let found = false;
    let i = position;
    for (let j = stepsTaken; i !== p.firstAvailable && j < poolLen; j++) {
      const colorToCheck = p.availableColors[i]!;
      if (colorToCheck === color) {
        found = true;
        break;
      }
      i = (i + 1) % poolLen;
    }
    if (!found) {
      // 重复颜色（已经被前面的 step 处理过）→ 跳过
      continue;
    }
    // 交换：把 "已释放的颜色" 排到 firstAvailable 之后
    const at = p.availableColors[i]!;
    const atPos = p.availableColors[position]!;
    p.availableColors[position] = at;
    p.availableColors[i] = atPos;
    stepsTaken++;
    position = (p.firstInUse + stepsTaken) % poolLen;
    if (position === p.firstAvailable || stepsTaken === poolLen) {
      break;
    }
  }

  if (stepsTaken === poolLen) {
    // 全部用完了 → 没有"空闲"段
    p.firstAvailable = -1;
  } else {
    p.firstAvailable = position;
    if (p.nextAvailable === -1) {
      p.nextAvailable = p.firstAvailable;
    }
  }
}

/**
 * 在 i 列开一个新 flow（必须分配新 colorNumber）。
 *
 * 与 parser.go `newFlow` 一致：
 *   - maxFlow += 1
 *   - 若 nextAvailable == -1（池满）→ 按需扩展（maxAllowedColors=0 时无上限）
 *   - 颜色从 nextAvailable 取出；环形推进 nextAvailable / firstAvailable
 *   - firstInUse 第一次 set
 */
function newFlowAt(p: Parser, i: number): void {
  p.maxFlow += 1;
  p.flows[i] = p.maxFlow;

  // 池满且允许扩展 → 扩容（+1）
  if (p.nextAvailable === -1) {
    const next = p.availableColors.length;
    if (p.maxAllowedColors < 1 || next < p.maxAllowedColors) {
      p.nextAvailable = next;
      p.firstAvailable = next;
      p.availableColors.push(next + 1);
    }
  }

  p.colors[i] = p.availableColors[p.nextAvailable]!;

  if (p.firstInUse === -1) {
    p.firstInUse = p.nextAvailable;
  }

  // swap nextAvailable ↔ firstAvailable
  const a = p.availableColors[p.firstAvailable]!;
  const b = p.availableColors[p.nextAvailable]!;
  p.availableColors[p.firstAvailable] = b;
  p.availableColors[p.nextAvailable] = a;

  // 推进
  p.nextAvailable = (p.nextAvailable + 1) % p.availableColors.length;
  p.firstAvailable = (p.firstAvailable + 1) % p.availableColors.length;

  // 池满（环形回到 in-use 起点）→ nextAvailable 失效
  if (p.nextAvailable === p.firstInUse) {
    p.nextAvailable = p.firstAvailable;
  }
  if (p.nextAvailable === p.firstInUse) {
    p.nextAvailable = -1;
    p.firstAvailable = -1;
  }
}

/**
 * 从上一行 j 列的 flow 继承到当前 i 列。
 *
 * 与 parser.go `takePreviousFlow` 等价：复制 oldFlows[j] → flows[i]，
 * 复制 oldColors[j] → colors[i]，并把 oldFlows[j] / oldColors[j] 置 0
 * （表示"已被这一行认领"）。
 */
function takePreviousFlow(p: Parser, i: number, j: number): void {
  if (j < p.oldFlows.length && p.oldFlows[j]! > 0) {
    p.flows[i] = p.oldFlows[j]!;
    p.oldFlows[j] = 0;
    p.colors[i] = p.oldColors[j]!;
    p.oldColors[j] = 0;
  } else {
    newFlowAt(p, i);
  }
}

/**
 * 从当前行 j 列的 flow 复制到当前 i 列（同行内复用，例如 `__` / `_/` / `_|_`）。
 */
function takeCurrentFlow(p: Parser, i: number, j: number): void {
  if (j < p.flows.length && p.flows[j]! > 0) {
    p.flows[i] = p.flows[j]!;
    p.colors[i] = p.colors[j]!;
  } else {
    newFlowAt(p, i);
  }
}

// ============================================================
// 内部：setUpFlow / setOutFlow / setInFlow / setRightFlow / setLeftFlow
// （与 parser.go setUpFlow 等函数 1:1 对应；注释里的"上一行/当前行"
//  ASCII 图对齐 Gitea 源码注释）
// ============================================================

/**
 * setUpFlow 处理 '|' 或 '*' —— 该列向上延伸自上一行某 flow。
 *
 * 优先级（与 parser.go setUpFlow 注释对齐）：
 *   Previous Row: '\? '  ' |'  '  /'
 *   Current Row:  ' | '  ' |'  ' | '
 *
 * 即优先从斜线下一格继承；否则直接从正上继承；否则从右上斜线底继承；否则开新 flow。
 */
function setUpFlow(p: Parser, i: number): void {
  if (i > 0 && i - 1 < p.oldGlyphs.length && p.oldGlyphs[i - 1] === '\\') {
    takePreviousFlow(p, i, i - 1);
  } else if (i < p.oldGlyphs.length && (p.oldGlyphs[i] === '|' || p.oldGlyphs[i] === '*')) {
    takePreviousFlow(p, i, i);
  } else if (i < p.oldGlyphs.length && p.oldGlyphs[i] === '\\') {
    // \ 在同一位置：fork 的斜线下方接 * 时继承同一 flow
    // 例如 |\ → | * 中的 * 应从上一行的 \ 继承 flow 2
    takePreviousFlow(p, i, i);
  } else if (i + 1 < p.oldGlyphs.length && p.oldGlyphs[i + 1] === '/') {
    takePreviousFlow(p, i, i + 1);
  } else {
    newFlowAt(p, i);
  }
}

/**
 * setOutFlow 处理 '/' —— 该位置是斜线的起点（右上 → 左下）。
 *
 * 优先级：
 *   Previous Row: ' |/' ' |_' ' |' ' /' ' _' '\'
 *   Current Row:  '/| ' '/| ' '/ ' '/ ' '/ ' '/'
 */
function setOutFlow(p: Parser, i: number): void {
  if (
    i + 2 < p.oldGlyphs.length &&
    (p.oldGlyphs[i + 1] === '|' || p.oldGlyphs[i + 1] === '*') &&
    (p.oldGlyphs[i + 2] === '/' || p.oldGlyphs[i + 2] === '_') &&
    i + 1 < p.glyphs.length &&
    (p.glyphs[i + 1] === '|' || p.glyphs[i + 1] === '*')
  ) {
    takePreviousFlow(p, i, i + 2);
  } else if (
    i + 1 < p.oldGlyphs.length &&
    (p.oldGlyphs[i + 1] === '|' ||
      p.oldGlyphs[i + 1] === '*' ||
      p.oldGlyphs[i + 1] === '/' ||
      p.oldGlyphs[i + 1] === '_')
  ) {
    takePreviousFlow(p, i, i + 1);
    if (p.oldGlyphs[i + 1] === '/') {
      // Gitea: 把当前 '/' 改成 '|'（因为已经被下方 commit "合并"）
      p.glyphs = setCharAt(p.glyphs, i, '|');
    }
  } else if (i < p.oldGlyphs.length && p.oldGlyphs[i] === '\\') {
    takePreviousFlow(p, i, i);
  } else {
    newFlowAt(p, i);
  }
}

/**
 * setInFlow 处理 '\\' —— 该位置是斜线的起点（左上 → 右下）。
 *
 * 优先级：
 *   Previous Row: '| ' '-. ' '| ' '\ ' '/' '---'
 *   Current Row:  '|\' '  \' ' \' ' \' '\' ' \ '
 */
function setInFlow(p: Parser, i: number): void {
  if (
    i > 0 &&
    i - 1 < p.oldGlyphs.length &&
    (p.oldGlyphs[i - 1] === '|' || p.oldGlyphs[i - 1] === '*') &&
    (p.glyphs[i - 1] === '|' || p.glyphs[i - 1] === '*')
  ) {
    newFlowAt(p, i);
  } else if (
    i > 0 &&
    i - 1 < p.oldGlyphs.length &&
    (p.oldGlyphs[i - 1] === '|' ||
      p.oldGlyphs[i - 1] === '*' ||
      p.oldGlyphs[i - 1] === '.' ||
      p.oldGlyphs[i - 1] === '\\')
  ) {
    takePreviousFlow(p, i, i - 1);
    if (p.oldGlyphs[i - 1] === '\\') {
      p.glyphs = setCharAt(p.glyphs, i, '|');
    }
  } else if (i < p.oldGlyphs.length && p.oldGlyphs[i] === '/') {
    takePreviousFlow(p, i, i);
  } else {
    newFlowAt(p, i);
  }
}

/**
 * setRightFlow 处理 '_' —— 同行向右延伸（commit 头连接右侧的 flow）。
 *
 * 优先级：
 *   Current Row:  '__' '_/' '_|_' '_|/'
 */
function setRightFlow(p: Parser, i: number): void {
  if (i + 1 < p.glyphs.length && (p.glyphs[i + 1] === '_' || p.glyphs[i + 1] === '/')) {
    takeCurrentFlow(p, i, i + 1);
  } else if (
    i + 2 < p.glyphs.length &&
    (p.glyphs[i + 1] === '|' || p.glyphs[i + 1] === '*') &&
    (p.glyphs[i + 2] === '_' || p.glyphs[i + 2] === '/')
  ) {
    takeCurrentFlow(p, i, i + 2);
  } else {
    newFlowAt(p, i);
  }
}

/**
 * setLeftFlow 处理 '-' 和 '.' —— 同行向左延伸（commit 头连接左侧的 flow）。
 *
 * Gitea 用 '-' / '.' 区分"无 commit" / "有 commit" 桥接，但本项目不区分
 * （直接 `----.` 走同一分支）。
 */
function setLeftFlow(p: Parser, i: number): void {
  if (p.glyphs[i] === '.') {
    newFlowAt(p, i);
  } else if (i + 1 < p.glyphs.length && (p.glyphs[i + 1] === '-' || p.glyphs[i + 1] === '.')) {
    takeCurrentFlow(p, i, i + 1);
  } else {
    newFlowAt(p, i);
  }
}

/** 字符串 helper：把字符串 index i 处替换为新字符 */
function setCharAt(s: string, i: number, c: string): string {
  if (i < 0 || i >= s.length) return s;
  return s.substring(0, i) + c + s.substring(i + 1);
}

// ============================================================
// ParseGlyphs —— 状态机入口（与 parser.go ParseGlyphs 1:1）
// ============================================================

/**
 * 解析一行字形，更新 Parser 内部状态（flows/colors/oldGlyphs）。
 *
 * 与 Gitea 原版顺序对齐：
 *   1. swap glyphs/oldGlyphs、flows/oldFlows、colors/oldColors
 *   2. 按列数初始化 flows/colors
 *   3. 拷贝 glyphs 到状态
 *   4. releaseUnusedColors（先释放上一行的过期颜色）
 *   5. 从右往左遍历 glyphs，按字符调用 setXxx（与 parser.go slices.Backward 等价）
 *
 * 这是**纯函数式**——只更新 Parser 状态；调用方还要再调 addLineToGraph
 * 把 (row, column, glyph) 写入 Graph。
 */
export function parseGlyphs(p: Parser, glyphs: string): void {
  // 1. swap buffers
  const prevGlyphs = p.glyphs;
  p.glyphs = p.oldGlyphs;
  p.oldGlyphs = prevGlyphs;

  const prevFlows = p.flows;
  p.flows = p.oldFlows;
  p.oldFlows = prevFlows;

  const prevColors = p.colors;
  p.colors = p.oldColors;
  p.oldColors = prevColors;

  // 2. 清空 + 按列数初始化 flows/colors
  p.flows.length = 0;
  p.colors.length = 0;
  for (let i = 0; i < glyphs.length; i++) {
    p.flows.push(0);
    p.colors.push(0);
  }

  // 3. 拷贝
  p.glyphs = glyphs;

  // 4. 释放过期颜色
  releaseUnusedColors(p);

  // 5. 从右往左处理（与 parser.go slices.Backward 等价）
  for (let i = glyphs.length - 1; i >= 0; i--) {
    const glyph = glyphs[i]!;
    switch (glyph) {
      case '|':
      case '*':
        setUpFlow(p, i);
        break;
      case '/':
        setOutFlow(p, i);
        break;
      case '\\':
        setInFlow(p, i);
        break;
      case '_':
        setRightFlow(p, i);
        break;
      case '.':
      case '-':
        setLeftFlow(p, i);
        break;
      case ' ':
        // no-op
        break;
      default:
        newFlowAt(p, i);
        break;
    }
  }
}

// ============================================================
// addLineToGraph —— 把一行字形（带 commit 数据）写入 Graph
// （与 parser.go AddLineToGraph 等价；行号 commit 由调用方传入）
// ============================================================

/**
 * 把一行字形 + commit 数据写入 Graph。
 *
 * 与 parser.go `AddLineToGraph(graph, row, line)` 对齐：
 *   - 行内每个非空格 glyph → graph.AddGlyph(row, column, flowID, color, glyph)
 *   - 若该行有 '*' → graph.AddCommit(row, column, flowID, after) 写入 commit
 *   - 若该行**无** '*' → graph.Commits.append(RelationCommit)（占位）
 *
 * 我们已经把 commit 元数据拆出来了，所以这里只接 commit 数据；
 * 找不到 * 时插入 RelationCommit 占位。
 *
 * @param row 行号（0 = 最新 / 顶部）
 * @param glyphs 字符流（与 Gitea parser.go `before` 一致）
 * @param commit 该行对应的 commit；null 表示过渡行（merge edge 中间段）
 */
export function addLineToGraph(
  p: Parser,
  graph: Graph,
  row: number,
  glyphs: string,
  commit: GitGraphCommit | null,
): void {
  // 1. 先 parseGlyphs 更新 Parser 状态
  parseGlyphs(p, glyphs);

  // 2. 遍历当前行，把每个非空格 glyph 写入 graph
  //    注意：column 写入 graph 时用 flows[columnIdx]（即 flowId 当 column 用，与 Gitea graph.go Column 一致）
  let commitDone = false;
  for (let columnIdx = 0; columnIdx < p.glyphs.length; columnIdx++) {
    const glyph = p.glyphs[columnIdx]!;
    if (glyph === ' ') continue;

    const flowID = p.flows[columnIdx]!;
    const color = p.colors[columnIdx]!;
    const column = flowID; // flowId 是流在所有行中的稳定列号（位置索引会因 git graph 空格而漂移）

    // 对角线的另一端列号（\ 从 parent 分叉，/ 合并到 parent）
    // 注：svg.ts 渲染斜线时已改用 column-1（相邻 lane）几何关系，不再依赖 parentColumn，
    //     这里仍按原逻辑记录 parentColumn 供 compactColumns 等参考（不影响渲染）。
    let parentColumn: number | undefined;
    if (glyph === '\\' && columnIdx > 0) {
      parentColumn = p.flows[columnIdx - 1]; // \ 从左侧的 | 分叉
    } else if (glyph === '/' && columnIdx > 0) {
      parentColumn = p.flows[columnIdx - 1]; // / 合并到左侧的 | 
    }
    addGlyphToGraph(graph, row, column, flowID, color, glyph, parentColumn);

    if (glyph === '*') {
      if (commitDone) {
        // 同一行出现两个 *（Gitea 原版会报 double commit 错误）
        // 我们这里静默忽略：保留第一个
      }
      commitDone = true;
      if (commit) {
        addCommitToFlow(graph, row, column, flowID, commit);
      }
    }
  }

  // 3. 行内无 * → RelationCommit 占位
  if (!commitDone) {
    graph.relationCommits.push({ id: RELATION_COMMIT_ID, row });
  }

  // 4. 更新全局包围盒
  if (row < graph.minRow) graph.minRow = row;
  if (row > graph.maxRow) graph.maxRow = row;
}

// ============================================================
// Graph 内部 helper
// ============================================================

function addGlyphToGraph(
  graph: Graph,
  row: number,
  column: number,
  flowID: number,
  colorNumber: number,
  glyph: string,
  parentColumn?: number,
): void {
  let flow = graph.flows.get(flowID);
  if (!flow) {
    flow = newFlow(flowID, colorNumber, row, column);
    graph.flows.set(flowID, flow);
  }
  // flow 内追加 glyph + 维护 flow 包围盒
  flow.glyphs.push({ row, column, glyph, parentColumn });
  if (row < flow.minRow) flow.minRow = row;
  if (row > flow.maxRow) flow.maxRow = row;
  if (column < flow.minColumn) flow.minColumn = column;
  if (column > flow.maxColumn) flow.maxColumn = column;

  // 全局包围盒
  if (row < graph.minRow) graph.minRow = row;
  if (row > graph.maxRow) graph.maxRow = row;
  if (column < graph.minColumn) graph.minColumn = column;
  if (column > graph.maxColumn) graph.maxColumn = column;
}

function addCommitToFlow(
  graph: Graph,
  row: number,
  column: number,
  flowID: number,
  commit: GitGraphCommit,
): void {
  const enriched: GitGraphCommit = {
    ...commit,
    row,
    column,
    flowId: flowID,
  };
  graph.commits.push(enriched);
  const flow = graph.flows.get(flowID);
  if (flow) flow.commits.push(enriched);
}

// ============================================================
// 公开入口：parseLines —— 把 GraphLine[] 解析为 Graph
// ============================================================

/**
 * 把 main 端 commits.gitgraph.lines 返回的 GraphLine[] 解析为 Graph。
 *
 * 这是 renderer 端 git graph 子系统的核心入口。
 *
 * 用法：
 *   const parser = new Parser();
 *   const graph = parseLines(parser, lines);
 *
 * @param lines 行数据（按 row 升序排列；row 0 = 最新）
 * @param maxAllowedColors 颜色上限（0 = 默认 2 色，与 Gitea 一致）
 */
export function parseLines(
  lines: GraphLine[],
  maxAllowedColors: number = DEFAULT_MAX_COLORS,
): { graph: Graph; parser: Parser } {
  const parser = new Parser();
  parser.reset(maxAllowedColors);

  const graph = newGraph();

  for (const line of lines) {
    const commit: GitGraphCommit | null = line.commit
      ? {
          id: line.commit.sha,
          sha: line.commit.sha,
          shortSha: line.commit.shortSha,
          subject: line.commit.subject,
          date: line.commit.date,
          refs: line.commit.refs,
          authorName: line.commit.authorName,
          authorEmail: line.commit.authorEmail,
          authorAvatar: line.commit.authorAvatar,
          isMerge: line.commit.isMerge,
          parents: line.commit.parents,
          // 坐标由 addLineToGraph 填
          flowId: 0,
          row: 0,
          column: 0,
        }
      : null;
    addLineToGraph(parser, graph, line.row, line.glyph, commit);
  }

  // 全局 minRow 修正：parser 第一行（row 0）还没人设过；强制初始化为 0
  if (graph.maxRow < 0) {
    graph.minRow = 0;
    graph.maxRow = 0;
  }

  // 全局 column 包围盒归一化：newGraph() 用 sentinel 值初始化，
  // 空图或无边时回落到 0
  if (graph.flows.size === 0) {
    graph.minColumn = 0;
    graph.maxColumn = 0;
  } else if (graph.minColumn === Number.MAX_SAFE_INTEGER) {
    // 有 flow 但 minColumn 未被更新（理论上不会发生，防御性）
    let mc = Infinity;
    let Mc = -Infinity;
    for (const f of graph.flows.values()) {
      if (f.minColumn < mc) mc = f.minColumn;
      if (f.maxColumn > Mc) Mc = f.maxColumn;
    }
    graph.minColumn = mc < Infinity ? mc : 0;
    graph.maxColumn = Mc > -Infinity ? Mc : 0;
  }

  // 把每个 flow 的 glyphs 按 (row, column) 升序排序（对齐 Gitea Graph 流式收尾）
  for (const flow of graph.flows.values()) {
    flow.glyphs.sort((a, b) => a.row - b.row || a.column - b.column);
  }

  // 列压缩：复用已死 flow 的列号，让 active flows 尽量左靠
  compactColumns(graph);

  // commits 按 row 升序（与 Gitea 一致）
  graph.commits.sort((a, b) => a.row - b.row);

  return { graph, parser };
}

// 兼容导出：Graph 类型被外部消费
export type { Graph, Flow, Glyph, GitGraphCommit };
