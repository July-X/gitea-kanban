// Vitest 配置
// 主进程 + preload + shared 代码单测（renderer 由 frontend agent 负责）
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@main': resolve(__dirname, 'src/main'),
      '@shared': resolve(__dirname, 'src/shared'),
      '@preload': resolve(__dirname, 'src/preload'),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    include: [
      'src/main/**/*.test.ts',
      'src/preload/**/*.test.ts',
      'src/shared/**/*.test.ts',
    ],
    exclude: [
      'node_modules/**',
      'out/**',
      'dist/**',
      'src/renderer/**',  // 由 frontend agent 单独测
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
        lines: 70,
        statements: 70,
        functions: 70,
        branches: 65,
      },
    },
  },
});
