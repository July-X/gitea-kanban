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
  server: {
    // Wails dev 模式通过代理注入，端口由 Wails 管理
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
