/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

// window.api（Wails API shim 注入；详见 lib/wails-api-shim.ts）
declare interface Window {
  api: Record<string, Record<string, (...args: any[]) => Promise<any>>>;
  go?: Record<string, Record<string, (...args: any[]) => Promise<any>>>;
}
