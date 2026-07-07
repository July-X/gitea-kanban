/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

// Wails Go bindings 注入（v0.6.0 已删除 wails-api-shim 兼容层）
declare interface Window {
  go?: Record<string, Record<string, (...args: any[]) => Promise<any>>>;
  };
}
