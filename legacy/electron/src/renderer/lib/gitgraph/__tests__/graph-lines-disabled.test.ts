/**
 * GraphLinesDto `disabled` 字段契约测试
 *
 * 背景：
 * - v1.4 commit `67cef88` 后，TimelineNewView 上线运行遇 bug：
 *   main handler 抛 `IpcError(code='internal', message='...v1.5...')`，
 *   前端 catch 里 `err.message?.includes('v1.5')` 匹配失败（IPC 边界后字段是 `messageText`），
 *   结果走 else 分支弹"操作失败"toast，而不是"功能暂未启用"占位
 *
 * 修复方案（commit `e1f9c0f`）：
 * - main handler **不抛错**，返 `{ disabled: true, disabledReason, lines: [] }`
 * - 前端按 `dto.disabled` 切换 UI
 * - 真错误（网络 / 解析）才走 catch
 *
 * 本测试验证：GraphLinesDto schema 接受 `disabled: true` 字段，
 * 业务契约 = handler 应该返 disabled=true 而不是 throw。
 */

import { describe, it, expect } from 'vitest';
import { GraphLinesDtoSchema } from '../../../../main/ipc/schema';

describe('GraphLinesDto.disabled 字段契约', () => {
  it('disabled 默认 false（v1.5 落地后正常返回）', () => {
    const dto = {
      lines: [],
      totalCommits: 0,
      truncated: false,
      range: { from: new Date(0).toISOString(), to: new Date(0).toISOString() },
    };
    const parsed = GraphLinesDtoSchema.parse(dto);
    expect(parsed.disabled).toBe(false);
  });

  it('disabled=true 时 schema 接受 disabledReason', () => {
    const dto = {
      disabled: true,
      disabledReason: 'v1.4 placeholder：仓库本地路径未配置',
      lines: [],
      totalCommits: 0,
      truncated: false,
      range: { from: new Date(0).toISOString(), to: new Date(0).toISOString() },
    };
    const parsed = GraphLinesDtoSchema.parse(dto);
    expect(parsed.disabled).toBe(true);
    expect(parsed.disabledReason).toBe('v1.4 placeholder：仓库本地路径未配置');
    expect(parsed.lines).toEqual([]);
  });

  it('disabled=true 但 lines 非空 → schema 仍接受（容错；正常 handler 不会这样）', () => {
    // handler 实测应该 lines=[]；但 schema 不强制（防御式编程）
    const dto = {
      disabled: true,
      disabledReason: 'reason',
      lines: [
        {
          row: 0,
          glyph: '*',
          commit: {
            sha: 'abc',
            shortSha: 'abc',
            subject: 's',
            date: new Date(0).toISOString(),
            authorName: 'a',
            authorEmail: 'a@x',
            isMerge: false,
            parents: [],
            refs: [],
          },
        },
      ],
      totalCommits: 1,
      truncated: false,
      range: { from: new Date(0).toISOString(), to: new Date(0).toISOString() },
    };
    const parsed = GraphLinesDtoSchema.parse(dto);
    expect(parsed.disabled).toBe(true);
    expect(parsed.lines).toHaveLength(1);
  });
});
