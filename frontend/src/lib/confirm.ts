/**
 * 二次确认核心逻辑（纯函数）
 *
 * 从 ConfirmDialog.vue 抽出 canConfirm 计算逻辑，让测试**不**依赖 Vue SFC / DOM 渲染。
 * 组件和测试都从这里 import → 测试可以直接 assert 行为，组件用 computed 包。
 *
 * 设计（AGENTS §8.3 + OVERRIDE §本项目专属规则 #2 二次确认）：
 *   - 不传 confirmKeyword → 恒为 true（无关键词限制）
 *   - 传 confirmKeyword → 要求输入严格 trim 后 === keyword
 *   - 大小写敏感（"Delete" ≠ "delete"）
 */
export function checkCanConfirm(inputText: string, confirmKeyword: string): boolean {
  if (!confirmKeyword) return true;
  return inputText.trim() === confirmKeyword;
}
