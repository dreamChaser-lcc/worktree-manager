import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** dev 模式下 /api 代理到本地 Koa 服务；生产构建产物交由 Koa 托管 */
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:5210',
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: 'dist'
  }
});
