#!/usr/bin/env tsx
/**
 * 验证 undo/redo 栈核心逻辑
 * （M6 undo/redo 真栈落地验证）
 *
 * 测试范围（7 个场景）：
 * - 栈机制：push / pop / 双向栈 / 容量上限 / projectId 隔离 / redo 清空
 * - dispatch 表：handler 注入 + 实际派发（fake handler）
 * - **不**测试 moveIssueColumn 业务侧（需要 mock gitea + sqlite，依赖重）
 *   → 业务侧集成由 e2e plan（plan_w3_e2e_regression）覆盖
 *
 * 运行：
 *   pnpm exec tsx scripts/verify-undoStack.ts
 */
import {
  pushUndo,
  undoStackSize,
  redoStackSize,
  undoOne,
  redoOne,
  undoStatus,
  registerUndoHandler,
  _resetStacks,
  _snapshotStacks,
} from '../src/main/board/undo.js';

let pass = 0;
let fail = 0;
function assert(cond: boolean, label: string, detail = ''): void {
  if (cond) {
    console.log(`  ✅ ${label}${detail ? ' — ' + detail : ''}`);
    pass++;
  } else {
    console.error(`  ❌ ${label}${detail ? ' — ' + detail : ''}`);
    fail++;
  }
}

_resetStacks();

// fake handler：记录 forward / reverse 调用 + 把 args 传出去（用于校验）
let forwardCalls: unknown[] = [];
let reverseCalls: unknown[] = [];
registerUndoHandler('issues.moveColumn', {
  forward: async (args) => {
    forwardCalls.push(args);
    return { ok: true, dir: 'forward', args };
  },
  reverse: async (args) => {
    reverseCalls.push(args);
    return { ok: true, dir: 'reverse', args };
  },
});

console.log('--- 1. 栈基础 ---');
assert(undoStackSize('p1') === 0, '空栈深度 = 0');
assert(redoStackSize('p1') === 0, '空 redo 栈深度 = 0');

pushUndo('issues.moveColumn', 'p1', { from: 'a', to: 'b' }, { from: 'b', to: 'a' });
assert(undoStackSize('p1') === 1, 'push 后 undo 深度 = 1');
assert(redoStackSize('p1') === 0, 'push 后 redo 深度仍 = 0');

console.log('\n--- 2. 不同 projectId 隔离 ---');
pushUndo('issues.moveColumn', 'p2', { from: 'a', to: 'b' }, { from: 'b', to: 'a' });
assert(undoStackSize('p1') === 1, 'p1 深度仍 = 1');
assert(undoStackSize('p2') === 1, 'p2 深度 = 1');

console.log('\n--- 3. 新操作清 redo 栈（行业惯例） ---');
_resetStacks();
// re-register because _resetStacks clears handlers
registerUndoHandler('issues.moveColumn', {
  forward: async (args) => {
    forwardCalls.push(args);
    return { ok: true };
  },
  reverse: async (args) => {
    reverseCalls.push(args);
    return { ok: true };
  },
});
forwardCalls = [];
reverseCalls = [];

pushUndo('issues.moveColumn', 'p1', { from: 'a', to: 'b' }, { from: 'b', to: 'a' });
const r1 = await undoOne({ projectId: 'p1' });
assert(r1.restored === 1, 'undo 第一次 restored=1');
assert(undoStackSize('p1') === 0, 'undo 后 undo 栈 = 0');
assert(redoStackSize('p1') === 1, 'undo 后 redo 栈 = 1');
assert(reverseCalls.length === 1, 'undo 触发 1 次 reverse 调用');
assert(
  JSON.stringify(reverseCalls[0]) === JSON.stringify({ from: 'b', to: 'a' }),
  'reverse 入参 = 原 pushUndo 的 reverseArgs',
);

pushUndo('issues.moveColumn', 'p1', { from: 'c', to: 'd' }, { from: 'd', to: 'c' });
assert(redoStackSize('p1') === 0, '新 push 清 redo 栈');
assert(undoStackSize('p1') === 1, '新 push 进 undo 栈');

console.log('\n--- 4. redo 推进 undo 栈 ---');
forwardCalls = [];
reverseCalls = [];
const r2 = await redoOne();
assert(r2.restored === 0, 'redo 栈空时返 restored=0');
const r3 = await undoOne({ projectId: 'p1' });
assert(r3.restored === 1, 'undo 又弹出');
assert(undoStackSize('p1') === 0, 'undo 后 undo 栈 = 0');
assert(redoStackSize('p1') === 1, 'undo 后 redo 栈 = 1');
assert(reverseCalls.length === 1, 'undo 触发 reverse');
const r4 = await redoOne({ projectId: 'p1' });
assert(r4.restored === 1, 'redo 弹出 1');
assert(forwardCalls.length === 1, 'redo 触发 forward');
assert(
  JSON.stringify(forwardCalls[0]) === JSON.stringify({ from: 'c', to: 'd' }),
  'forward 入参 = 原 pushUndo 的 forwardArgs',
);
assert(undoStackSize('p1') === 1, 'redo 后 undo 栈 = 1');
assert(redoStackSize('p1') === 0, 'redo 后 redo 栈 = 0');

console.log('\n--- 5. 容量上限（FIFO 丢头） ---');
_resetStacks();
registerUndoHandler('issues.moveColumn', {
  forward: async () => ({}),
  reverse: async () => ({}),
});
for (let i = 0; i < 60; i++) {
  pushUndo('issues.moveColumn', 'p1', { i }, { i });
}
assert(undoStackSize('p1') === 50, '60 push 后深度 = 50（上限）');
// 最先 push 的 0..9 应被丢
const snap5 = _snapshotStacks();
const firstKept = (snap5.undo.p1 ?? [])[0];
assert(
  JSON.stringify(firstKept?.forwardArgs) === JSON.stringify({ i: 10 }),
  '丢头 FIFO：i=10 是保留下来的最早一条',
);

console.log('\n--- 6. snapshot ---');
_resetStacks();
registerUndoHandler('issues.moveColumn', {
  forward: async () => ({}),
  reverse: async () => ({}),
});
pushUndo('issues.moveColumn', 'p1', { x: 1 }, { x: -1 });
pushUndo('issues.moveColumn', 'p1', { x: 2 }, { x: -2 });
const snap = _snapshotStacks();
assert(Object.keys(snap.undo).length === 1, 'snapshot 1 project');
assert(snap.undo.p1?.length === 2, 'snapshot undo p1 深度 2');

console.log('\n--- 7. dispatch 表未注册 op 走 IpcError(INTERNAL) ---');
_resetStacks();
// 不注册 handler
let threw = false;
try {
  pushUndo('issues.moveColumn', 'p1', { x: 1 }, { x: -1 });
  await undoOne({ projectId: 'p1' });
} catch (e) {
  threw = true;
  const msg = e instanceof Error ? e.message : String(e);
  // IpcError 实例化后是 plain object（IPC 序列化用），断言 message 含关键字
  const messageField = (e as { message?: string }).message ?? msg;
  assert(
    messageField.includes('未注册') || messageField.includes('undo op'),
    'IpcError.message 含 "未注册" 或 "undo op"',
    messageField,
  );
}
assert(threw, '未注册 handler 时 undoOne 抛错');

console.log('\n--- 8. 跨 projectId 不互撤（M6 undo-by-project） ---');
_resetStacks();
registerUndoHandler('issues.moveColumn', {
  forward: async () => ({}),
  reverse: async () => ({}),
});
pushUndo('issues.moveColumn', 'p1', { x: 1 }, { x: -1 });
pushUndo('issues.moveColumn', 'p2', { x: 2 }, { x: -2 });
// 弹 p1：只动 p1，p2 不动
const r8 = await undoOne({ projectId: 'p1' });
assert(r8.restored === 1, 'undo(p1) restored=1');
assert(undoStackSize('p1') === 0, 'p1 栈清空');
assert(undoStackSize('p2') === 1, 'p2 栈仍 = 1（**不**跨撤）');
assert(r8.undoSize === 0, '回返 undoSize = 0');
assert(r8.redoSize === 1, '回返 redoSize = 1（p1 推入 redo）');
// 弹 p2：独立
const r8b = await undoOne({ projectId: 'p2' });
assert(r8b.restored === 1, 'undo(p2) restored=1');
assert(undoStackSize('p2') === 0, 'p2 栈清空');
assert(r8b.undoSize === 0, 'p2 undoSize = 0');
assert(r8b.redoSize === 1, 'p2 redoSize = 1');

console.log('\n--- 9. 无 projectId 走安全默认（restored=0，不跨看板） ---');
_resetStacks();
registerUndoHandler('issues.moveColumn', {
  forward: async () => ({}),
  reverse: async () => ({}),
});
pushUndo('issues.moveColumn', 'p1', { x: 1 }, { x: -1 });
const r9 = await undoOne();
assert(r9.restored === 0, '无 projectId → restored=0（安全默认）');
assert(undoStackSize('p1') === 1, 'p1 栈**不**被跨撤（仍 = 1）');
const r9b = await undoOne({ projectId: undefined });
assert(r9b.restored === 0, '显式 projectId=undefined 也走安全默认');

console.log('\n--- 10. undoStatus 栈深度查询 ---');
_resetStacks();
registerUndoHandler('issues.moveColumn', {
  forward: async () => ({}),
  reverse: async () => ({}),
});
assert(
  JSON.stringify(undoStatus('p1')) === JSON.stringify({ undoSize: 0, redoSize: 0 }),
  '空栈 undoStatus(空) = {0,0}',
);
pushUndo('issues.moveColumn', 'p1', { x: 1 }, { x: -1 });
pushUndo('issues.moveColumn', 'p1', { x: 2 }, { x: -2 });
const s = undoStatus('p1');
assert(s.undoSize === 2, '2 push 后 undoSize = 2');
assert(s.redoSize === 0, 'redoSize = 0');
await undoOne({ projectId: 'p1' });
const s2 = undoStatus('p1');
assert(s2.undoSize === 1, 'undo 后 undoSize = 1');
assert(s2.redoSize === 1, 'undo 后 redoSize = 1');

console.log('\n--- 11. 操作后栈深度回传（免一次 roundtrip） ---');
_resetStacks();
registerUndoHandler('issues.moveColumn', {
  forward: async () => ({}),
  reverse: async () => ({}),
});
pushUndo('issues.moveColumn', 'p1', { x: 1 }, { x: -1 });
const r11 = await undoOne({ projectId: 'p1' });
assert(r11.undoSize === 0, 'undoOne 返 undoSize = 0（操作后）');
assert(r11.redoSize === 1, 'undoOne 返 redoSize = 1（操作后）');
assert(r11.op === 'issues.moveColumn', 'undoOne 返 op 字段');

console.log(`\n[verify-undoStack] ${pass} pass · ${fail} fail`);
if (fail > 0) {
  process.exit(1);
}
