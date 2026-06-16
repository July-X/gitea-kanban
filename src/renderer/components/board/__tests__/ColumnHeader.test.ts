/**
 * P0-2 列 = label UI 标注 · 文件指纹回归测试
 *
 * 拍板 2026-06-16（plan_25cc4562 Task C · P0-2）：
 *   - ColumnHeader 修"X 个标签"文案 bug → "X 张"（issueCount 是 issue 数）
 *   - label 列表 chip 化（gitea label 真实颜色作 dot + label 名）
 *   - 移除 v1.3 的 <Tag icon> + "·" join 文字（看不出 label 视觉差异）
 *   - ColumnMenu 加 unmatchedCount props + 未归类 banner 区（v1.4 占位）
 *
 * 为什么不渲染组件：AGENTS §7.2 "frontend 任务 0 装新依赖"（happy-dom 不在 deps）。
 * 改用**纯静态 + 文件指纹**断言，跟 P0-1 / TeamView 测试同模式。
 *
 * 运行：`pnpm test src/renderer/components/board/__tests__/ColumnHeader.test.ts`
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const projectRoot = resolve(__dirname, '../../../../..');
const columnHeaderPath = resolve(projectRoot, 'src/renderer/components/board/ColumnHeader.vue');
const columnMenuPath = resolve(projectRoot, 'src/renderer/components/board/ColumnMenu.vue');
const boardModalsCssPath = resolve(projectRoot, 'src/renderer/components/board/board-modals.css');
const columnSectionPath = resolve(projectRoot, 'src/renderer/components/board/KanbanColumnSection.vue');

describe('P0-2 列 = label UI 标注 · 文件指纹', () => {
  describe('ColumnHeader.vue · chip 化 + 修文案 bug', () => {
    it('文件存在', () => {
      expect(existsSync(columnHeaderPath)).toBe(true);
    });

    it('不引 lucide-vue-next 的 <Tag>（v1.3 用 Tag icon + · join，已弃）', () => {
      const content = readFileSync(columnHeaderPath, 'utf-8');
      expect(content).toMatch(/import\s*\{[^}]*Settings[^}]*\}\s*from\s*['"]lucide-vue-next['"]/);
      expect(content).not.toMatch(/import\s*\{[^}]*\bTag\b[^}]*\}\s*from\s*['"]lucide-vue-next['"]/);
    });

    it('template 里有 .column__label-chip 渲染', () => {
      const content = readFileSync(columnHeaderPath, 'utf-8');
      expect(content).toMatch(/<span[\s\S]+column__label-chip/);
    });

    it('label chip 用 v-for 渲染每个 label', () => {
      const content = readFileSync(columnHeaderPath, 'utf-8');
      expect(content).toMatch(/v-for="lab in props\.column\.labels"/);
    });

    it('label dot 用 gitea label 真实颜色（inline style background）', () => {
      const content = readFileSync(columnHeaderPath, 'utf-8');
      expect(content).toMatch(/:style="\{[\s\S]+background[\s\S]+lab\.color/);
    });

    it('修文案 bug：列头计数从"X 个标签"改成"X 张"', () => {
      const content = readFileSync(columnHeaderPath, 'utf-8');
      // 模板里渲染 "X 张"（{{ props.issueCount }} 张）
      expect(content).toMatch(/\{\{\s*props\.issueCount\s*\}\}\s*张/);
      // **不**能在 .vue 文件**任何位置**出现 "X 个标签"渲染文案（注释允许提作为历史）
      // 但**实际模板标签里**（<button> / <span> 文案）不能有
      // 取 <template>...</template> 段，**剥离** HTML 注释 <!----> 后再检查
      const templateMatch = content.match(/<template>[\s\S]+?<\/template>/);
      expect(templateMatch).not.toBeNull();
      // 去掉 <!-- ... --> 段（HTML 注释）
      const tplNoComments = templateMatch![0].replace(/<!--[\s\S]*?-->/g, '');
      expect(tplNoComments).not.toMatch(/个\s*标签/);
    });

    it('CSS 含 .column__label-chip / .column__label-dot 样式', () => {
      const content = readFileSync(columnHeaderPath, 'utf-8');
      expect(content).toMatch(/\.column__label-chip\s*\{/);
      expect(content).toMatch(/\.column__label-dot\s*\{/);
    });
  });

  describe('ColumnMenu.vue · 加 unmatchedCount props + banner 占位', () => {
    it('文件存在', () => {
      expect(existsSync(columnMenuPath)).toBe(true);
    });

    it('Props 加 unmatchedCount 字段', () => {
      const content = readFileSync(columnMenuPath, 'utf-8');
      expect(content).toMatch(/unmatchedCount:\s*number/);
    });

    it('unmatchedCount 默认值 0（withDefaults）', () => {
      const content = readFileSync(columnMenuPath, 'utf-8');
      expect(content).toMatch(/withDefaults\(defineProps<Props>\(\),\s*\{[\s\S]+unmatchedCount:\s*0/);
    });

    it('emit 加 open-batch-create 和 bind-unmatched-to-current 事件', () => {
      const content = readFileSync(columnMenuPath, 'utf-8');
      expect(content).toMatch(/\(e:\s*'open-batch-create'\)/);
      expect(content).toMatch(/\(e:\s*'bind-unmatched-to-current'\)/);
    });

    it('template 里有 .modal__unmatched banner 区', () => {
      const content = readFileSync(columnMenuPath, 'utf-8');
      expect(content).toMatch(/v-if="props\.unmatchedCount\s*>\s*0"[\s\S]+class="modal__unmatched"/);
    });

    it('banner 里有两个 CTA 按钮（再建几列 / 塞进当前列）', () => {
      const content = readFileSync(columnMenuPath, 'utf-8');
      expect(content).toMatch(/再建几列/);
      expect(content).toMatch(/塞进当前列/);
    });

    it('CTA 按钮 disabled（v1.4 占位 · v1.5 接 store 真实值）', () => {
      const content = readFileSync(columnMenuPath, 'utf-8');
      // 找 .modal__unmatched 区段（到 .modal__body 闭合 div 为止）
      const start = content.indexOf('class="modal__unmatched"');
      expect(start).toBeGreaterThan(-1);
      // 从 unmatched 段截到下一个 .modal__body 闭合（往回走找最近的 .modal__body 之前）
      // 简单：直接截到对应的 '</div>'（最近的、在 unmatched 之后）
      let end = -1;
      let depth = 1;
      let i = start;
      // 跳过当前 <div class="modal__unmatched">（已 index 找到），从它后面开始
      const openTagEnd = content.indexOf('>', start) + 1;
      i = openTagEnd;
      while (i < content.length && depth > 0) {
        const nextOpen = content.indexOf('<div', i);
        const nextClose = content.indexOf('</div>', i);
        if (nextClose === -1) break;
        if (nextOpen !== -1 && nextOpen < nextClose) {
          depth++;
          i = nextOpen + 4;
        } else {
          depth--;
          if (depth === 0) { end = nextClose; break; }
          i = nextClose + 6;
        }
      }
      expect(end).toBeGreaterThan(start);
      const block = content.slice(start, end);
      const buttons = block.match(/<button[\s\S]+?disabled/g);
      expect(buttons?.length ?? 0).toBeGreaterThanOrEqual(2);
    });
  });

  describe('board-modals.css · 新增 .modal__unmatched 样式', () => {
    it('文件存在', () => {
      expect(existsSync(boardModalsCssPath)).toBe(true);
    });

    it('含 .modal__unmatched 容器样式', () => {
      const content = readFileSync(boardModalsCssPath, 'utf-8');
      expect(content).toMatch(/\.modal__unmatched\s*\{/);
    });

    it('banner 颜色走主色 / 警告 token', () => {
      const content = readFileSync(boardModalsCssPath, 'utf-8');
      expect(content).toMatch(/\.modal__unmatched\s*\{[\s\S]+background:\s*var\(--color-warning-soft\)/);
    });

    it('CTA disabled 样式（opacity 0.5 + cursor not-allowed）', () => {
      const content = readFileSync(boardModalsCssPath, 'utf-8');
      expect(content).toMatch(/\.modal__unmatched-actions[\s\S]+:disabled\s*\{[\s\S]+opacity:\s*0\.5/);
      expect(content).toMatch(/\.modal__unmatched-actions[\s\S]+:disabled\s*\{[\s\S]+cursor:\s*not-allowed/);
    });
  });

  describe('KanbanColumnSection.vue · 不破坏现状（empty state 已合理）', () => {
    it('文件存在', () => {
      expect(existsSync(columnSectionPath)).toBe(true);
    });

    it('v1.4 现状 empty state 保留（"这列还没绑标签" + 绑 label 按钮）', () => {
      const content = readFileSync(columnSectionPath, 'utf-8');
      expect(content).toMatch(/这列还没绑标签/);
      expect(content).toMatch(/绑定标签/);
    });
  });
});
