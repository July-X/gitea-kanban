/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

// window.api 声明（Wails API shim 注入；详见 lib/wails-api-shim.ts）
declare interface Window {
  api: any;
  go?: {
    main?: {
      App?: {
        GetAppInfo(): Promise<{
          version: string;
          dataDir: string;
          platform: string;
        }>;
      };
    };
  };
}
