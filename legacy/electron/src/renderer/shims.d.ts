/**
 * Vue SFC 模块声明 —— 让 tsc 在没有 vue-tsc 的情况下接受 .vue import
 *
 * 背景（gitea-kanban v1）：
 *   - 项目**未**安装 `vue-tsc`（devDependency），pnpm type-check 走的是 `tsc -p tsconfig.json --noEmit`
 *   - tsc **无法** type-check Vue SFC 内部（template / scoped style）——这是已知局限
 *   - 但 tsc 需要 .vue import **不**报错才能跑通（本任务 hard requirement："pnpm type-check 0 error"）
 *   - 本文件用 .d.ts 声明让 tsc 把 .vue 文件视作 default-export any 形态,跳过内部 type check
 *
 * 严格 type-check SFC 内部留给：vue-tsc / 集成测试 / 运行时错误
 * （AGENTS §5.2 没装 vue-tsc,本任务也**不**装新依赖——M1 补）
 *
 * 用法：在 tsconfig.json 的 include 列表里包含此文件即可。
 */

/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}
