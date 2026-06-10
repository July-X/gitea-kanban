// electron-vite 三端构建配置
//
// electron-vite v5.0.0 重构了 config 接口（changelog 2025-12-07）：
// - `externalizeDepsPlugin()` deprecated → `build.externalizeDeps`（顶层 boolean / 配置对象）
// - `bytecodePlugin` deprecated → `build.bytecode`
// - 完整 release notes: https://github.com/alex8088/electron-vite/blob/master/CHANGELOG.md#v500
//
// 参考 docs: https://electron-vite.org/config/

import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  main: {
    build: {
      // v5 新写法（v2 的 `plugins: [externalizeDepsPlugin()]` 已废弃）
      externalizeDeps: true,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
      outDir: 'out/main',
    },
    resolve: {
      alias: {
        '@main': resolve(__dirname, 'src/main'),
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: true,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        output: {
          // electron sandboxed preload 不支持 ESM：
          //   浏览器加载 .mjs 时 V8 强制 module 模式，要求 `import/export`；
          //   sandboxed preload 跑在 classic-script 上下文里，require 是 polyfill（见
          //   https://www.electronjs.org/docs/latest/tutorial/sandbox#preload-scripts）。
          //   两套加载语义不兼容 → 必须产物是 CJS bundle，文件名 `.cjs`。
          //
          //   任何 worker 看到 `.cjs` 想"优化"回 `.mjs` / ESM 都会撞同一个坑。
          //   这条经验已沉淀到 AGENTS.md §8。
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
      outDir: 'out/preload',
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [vue()],
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer'),
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
      outDir: 'out/renderer',
    },
  },
});
