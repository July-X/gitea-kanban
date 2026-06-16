// Vitest 配置
// 主进程 + preload + shared 代码单测（renderer 由 frontend agent 负责）
import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@main': resolve(__dirname, 'src/main'),
      '@shared': resolve(__dirname, 'src/shared'),
      '@preload': resolve(__dirname, 'src/preload'),
      '@renderer': resolve(__dirname, 'src/renderer'),
    },
  },
  test: {
    // 默认 node 环境（不破坏现有 main/preload/shared 测试）
    // 渲染端测试如需 DOM（如 ConfirmDialog 组件），可在文件顶部加
    //   // @vitest-environment happy-dom
    // 当前 frontend 任务 0 装新依赖,DOM 测试用最小 stub 规避
    environment: 'node',
    globals: true,
    include: [
      'src/main/**/*.test.ts',
      'src/preload/**/*.test.ts',
      'src/shared/**/*.test.ts',
      'src/renderer/**/*.test.ts',  // frontend agent 单测（plan_373b3dd8 M2）
      'tests/**/*.spec.ts',         // plan_25cc4562 Task C 起的 e2e 端到端验证（mount BoardView + mock IPC）
    ],
    exclude: [
      'node_modules/**',
      'out/**',
      'dist/**',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      reportsDirectory: './coverage',
      include: [
        'src/main/**/*.ts',
        'src/shared/**/*.ts',
        'src/preload/**/*.ts',
      ],
      exclude: [
        '**/*.test.ts',
        '**/types.ts',  // 类型声明文件
        '**/index.ts',  // barrel files（被覆盖在各自子文件里）
      ],
      thresholds: {
        // v1.4 polish 修订（commit 5b5a432+）：实际覆盖率 23.5%（远低于历史 70% 假数字）。
        // 原因：main/ipc + main/gitea + main/board 三层业务几乎 0 测（1 万+ LOC）。
        // 历史 70% 是 v1.0 设的"目标"——实际没 enforce（CI 只跑 pnpm test，不带 coverage）。
        // v1.4 拍板：把 threshold 降到当前实际 + buffer，**不**装高水位。
        // 后续 plan（v1.5/M12）逐步补 IPC handler / board 业务 / gitea 集成的单测后再涨。
        //
        // 2026-06-16 baseline：lines 23.49% / statements 23.52% / branches 12.49% / functions 24.57%
        // 设 buffer = +2pp 给后续零星加测的余量
        lines: 25,
        statements: 25,
        functions: 25,
        branches: 15,
      },
    },
  },
});
