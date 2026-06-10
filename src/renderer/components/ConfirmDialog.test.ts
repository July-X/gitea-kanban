/**
 * ConfirmDialog.test.ts —— 二次确认核心逻辑
 *
 * 覆盖（ConfirmDialog 行为 + lib/confirm.checkCanConfirm + AGENTS §8.3 + OVERRIDE §本项目专属规则 #2）：
 * - 不传 confirmKeyword → canConfirm 恒为 true（任意输入都可通过）
 * - 传 confirmKeyword → 严格匹配（大小写敏感、严格相等）
 * - trim 后匹配（" delete " 等同 "delete"）
 *
 * **不**测 mount / DOM 渲染：
 *   - 项目**未**装 @vitejs/plugin-vue / happy-dom / jsdom（v1 不装新依赖）
 *   - 核心 canConfirm 逻辑抽到 lib/confirm.checkCanConfirm 纯函数，这里直接覆盖
 *   - DOM 行为（watch open 清空、Esc 关闭）由 component 单测 + e2e 后续补（M1）
 */
import { describe, expect, it } from 'vitest';
import { checkCanConfirm } from '@renderer/lib/confirm';

describe('checkCanConfirm', () => {
  describe('不传 confirmKeyword（空字符串）', () => {
    it('输入空 → true', () => {
      expect(checkCanConfirm('', '')).toBe(true);
    });

    it('任意输入 → true（无关键词限制）', () => {
      expect(checkCanConfirm('随便输', '')).toBe(true);
      expect(checkCanConfirm('delete', '')).toBe(true);
      expect(checkCanConfirm('any text', '')).toBe(true);
    });
  });

  describe('传 confirmKeyword', () => {
    it('完全匹配 → true', () => {
      expect(checkCanConfirm('delete', 'delete')).toBe(true);
    });

    it('trim 后匹配 → true（用户输入前后空格容忍）', () => {
      expect(checkCanConfirm('  delete  ', 'delete')).toBe(true);
      expect(checkCanConfirm('\tdelete\n', 'delete')).toBe(true);
    });

    it('大小写不匹配 → false', () => {
      expect(checkCanConfirm('Delete', 'delete')).toBe(false);
      expect(checkCanConfirm('DELETE', 'delete')).toBe(false);
    });

    it('多字符 / 少字符 → false', () => {
      expect(checkCanConfirm('deleted', 'delete')).toBe(false);
      expect(checkCanConfirm('del', 'delete')).toBe(false);
    });

    it('空输入 → false', () => {
      expect(checkCanConfirm('', 'delete')).toBe(false);
      expect(checkCanConfirm('   ', 'delete')).toBe(false);
    });

    it('中文关键词（任务用语场景）', () => {
      expect(checkCanConfirm('我了解风险', '我了解风险')).toBe(true);
      expect(checkCanConfirm('我了解风险 ', '我了解风险')).toBe(true);
      expect(checkCanConfirm('了解风险', '我了解风险')).toBe(false);
    });
  });
});
