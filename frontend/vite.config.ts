import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

// Wails v2 前端 Vite 配置
// 产物输出到 frontend/dist/，由 main.go 的 //go:embed 嵌入
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src'),
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    // Wails v2 HMR WebSocket 兼容：WebView 在 wails.localhost:34115 宿主
    // 内部向 localhost:5173 建立 ws 连接时需放宽 origin 限制
    hmr: {
      protocol: 'ws',
      host: 'localhost',
    },
    allowedHosts: ['wails.localhost'],
  },
})
