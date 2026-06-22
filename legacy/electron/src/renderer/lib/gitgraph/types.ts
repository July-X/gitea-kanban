/**
 * Git Graph 渲染层共享类型
 *
 * 这些类型**只在 renderer 端** git graph 子系统使用，与 Gitea 对齐：
 * - GitRef：分支 / tag / 远程 / PR 装饰（对应 gitea %D 字段）
 * - GraphLine：来自 main 端 `commits.gitgraph.lines` 的单行结构
 *   （一行的字符流 + 该行 commit 元数据，None 表示行中无 *）
 */

/** ref 类型（对齐 Gitea modules/git/ref.go RefName.RefGroup） */
export type RefGroup = 'heads' | 'tags' | 'remotes' | 'pull';

/** 一个 ref（分支 / tag / PR 引用） */
export interface GitRef {
  /** 完整 ref 名，如 refs/heads/main / refs/tags/v1.0 / refs/pull/42/head */
  name: string;
  /** ref 分组（heads/tags/remotes/pull） */
  refGroup: RefGroup;
  /** 短名（去前缀） */
  shortName: string;
}

/**
 * 单行字符流（main 端 commits.gitgraph.lines 返回的最小单位）
 *
 * `glyph` 是 `git log --graph` 输出的**字形前缀**（不含 DATA: 之后的数据段），
 * 即 `* | / \ _ - . ` 这类 ASCII 字符序列。
 *
 * `commit` 为空时表示该行只是过渡（merge edge 的 intermediate row），
 * Gitea parser.go 把它当成 RelationCommit 占位。
 */
export interface GraphLine {
  /** 行号（0 = 最新 / 顶部） */
  row: number;
  /** 字形字符流（与 Gitea git --graph 输出对齐） */
  glyph: string;
  /** 该行对应的 commit 元数据；过渡行没有 commit */
  commit: GraphLineCommit | null;
}

/** 单个 commit 的轻量 DTO —— main 端按 gitgraph 协议返的形态 */
export interface GraphLineCommit {
  sha: string;
  shortSha: string;
  subject: string;
  /** ISO 日期 */
  date: string;
  authorName: string;
  authorEmail: string;
  authorAvatar?: string;
  isMerge: boolean;
  parents: string[];
  refs: GitRef[];
}

/**
 * commits.gitgraph.lines 端点的完整返回（按行数排序，row 0 在前）
 *
 * 与 main 端 src/main/ipc/schema.ts GraphLinesDtoSchema 对应
 */
export interface GraphLinesDto {
  lines: GraphLine[];
  totalCommits: number;
  truncated: boolean;
  range: { from: string; to: string };
}
