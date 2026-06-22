/**
 * Patch hunk header 解析（v1.1.3 · task #23）
 *
 * gitea 服务端返回的 unified diff `patch` 字段形如：
 *   @@ -10,5 +12,7 @@ function foo(arg: string): void
 *   @@ -42,3 +50,9 @@ class Bar::baz
 *   @@ -100,8 +110,12 @@ def qux(self):
 *
 * hunk 头"@@ ... @@"之后的部分是 language-specific section heading
 * —— TS/Python/Go/Rust 各有语法；这里**不**做语言特化，heading 原文透传。
 *
 * 设计：parse 一次（main 端 toCommitDto 阶段），结果存到 DTO 的 `functions` 字段，
 * 渲染端**不**重复解析 patch 字符串（避免在 IPC 边界上传输 patch 全文）。
 */

/**
 * 从 unified diff 的 patch 字段中提取所有 hunk 头后面的 heading
 * 返回的 heading 数组按文件中出现顺序排列、可有重复（由调用方按文件去重）
 */
export function extractFunctionsFromPatch(patch: string | undefined): string[] {
  if (!patch) return [];
  const headings: string[] = [];
  // 匹配 `@@ -<old> [,<count>] +<new> [,<count>] @@ <heading>`
  // - old/new 行号必填，count 可省（=1）
  // - heading 可为空（hunks without section heading）
  const re = /^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@\s*(.*)$/gm;
  for (let m = re.exec(patch); m !== null; m = re.exec(patch)) {
    const h = m[1]?.trim() ?? '';
    if (h) headings.push(h);
  }
  return headings;
}

/**
 * 判定 gitea file.status 是否二进制
 * gitea 端约定：status='binary' OR binary_file=true
 */
export function isBinaryFileStatus(
  status: string | undefined,
  binaryFileFlag: boolean | undefined,
): boolean {
  return status === 'binary' || binaryFileFlag === true;
}
