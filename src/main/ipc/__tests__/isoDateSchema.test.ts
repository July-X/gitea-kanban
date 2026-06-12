/**
 * IsoDateSchema 单元测试（M5-fix1）
 *
 * 背景：M4 final-integration 报告 Z1-Z3 known-issue——
 * `z.string().datetime()` 默认只接受 UTC 'Z' 格式，但 gitea 1.x 实际返 +08:00 / -05:00 等
 * 带时区偏移的 ISO 时间戳（如 `2026-06-11T16:30:00+08:00`），导致 PullDto / TimelineDto / IssueDto
 * 通过 Zod 校验时被拒。
 *
 * 修复：IsoDateSchema 改为 `z.string().datetime({ offset: true })`。
 *
 * 此测试验证：
 * - UTC 'Z' 后缀仍然接受（向后兼容）
 * - 正向偏移 +08:00 接受（gitea 默认时区）
 * - 负向偏移 -05:00 接受
 * - 纯日期字符串 `2026-06-11` 拒绝（schema 要求时间部分）
 */
import { describe, it, expect } from 'vitest';
import { IsoDateSchema } from '../schema.js';

describe('IsoDateSchema (M5-fix1: gitea +08:00 时区不再被 Zod 拒)', () => {
  it('接受 UTC 后缀 (Z)', () => {
    const r = IsoDateSchema.safeParse('2026-06-11T08:30:00Z');
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toBe('2026-06-11T08:30:00Z');
  });

  it('接受 +08:00 正向偏移（gitea 默认时区）', () => {
    const r = IsoDateSchema.safeParse('2026-06-11T16:30:00+08:00');
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toBe('2026-06-11T16:30:00+08:00');
  });

  it('接受 -05:00 负向偏移', () => {
    const r = IsoDateSchema.safeParse('2026-06-11T03:30:00-05:00');
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toBe('2026-06-11T03:30:00-05:00');
  });

  it('拒绝纯日期字符串（schema 要求时间部分）', () => {
    const r = IsoDateSchema.safeParse('2026-06-11');
    expect(r.success).toBe(false);
  });
});