/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

// window.api（Wails API shim 注入；详见 lib/wails-api-shim.ts）
// - api 顶层有 on() 通用事件订阅（main → renderer 推送转发到 window.runtime.EventsOn）
// - api 其余键都是 namespace.sub.method 的二维 Record
type WindowApi = {
  on: (event: string, cb: (payload: unknown) => void) => () => void;
  [namespace: string]: Record<string, (...args: any[]) => Promise<any>>;
};
declare interface Window {
  api: WindowApi;
  go?: Record<string, Record<string, (...args: any[]) => Promise<any>>>;
}
