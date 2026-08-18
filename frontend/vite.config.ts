import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import pkg from './package.json' with { type: 'json' }

export default defineConfig({
  base: '/agentmobile/',
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  __APP_NAME__: JSON.stringify(pkg.name),
  __APP_DESC__: JSON.stringify(pkg.description || ''),
  },
  build: {
    outDir: '../frontend/dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom'],
          xterm: ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-web-links']
        }
      }
    }
  },
  server: {
    proxy: {
      '/api': 'http://localhost:59000',
      '/ws': {
        target: 'ws://localhost:59000',
        ws: true,
      },
    },
  },
})
