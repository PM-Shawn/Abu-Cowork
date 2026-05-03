import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { version } from './package.json'

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  clearScreen: false,
  server: {
    host: host || false,
    port: 5173,
    strictPort: true,
    hmr: host ? { protocol: 'ws', host, port: 5174 } : undefined,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari14',
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    rollupOptions: {
      // Multi-entry: main app + desktop pet window (PRD-02)
      input: {
        main: path.resolve(__dirname, 'index.html'),
        pet: path.resolve(__dirname, 'pet.html'),
      },
      // Only externalize stdio transport (requires Node.js: cross-spawn, node:process, node:stream)
      // Client + HTTP/SSE transports are browser-compatible and should be bundled
      external: [
        '@modelcontextprotocol/sdk/client/stdio.js',
        '@modelcontextprotocol/sdk/client/stdio',
        'cross-spawn',
        'node:process',
        'node:stream',
      ],
      output: {
        // zustand's `create` was landing in the main chunk while imChannelStore
        // (and other stores) imported it from there, creating a circular dep that
        // caused `create` to be undefined at store-module evaluation time →
        // "ve is not a function" → white screen on Windows before React mounts.
        // Pinning zustand + immer to their own leaf chunk breaks the cycle.
        manualChunks(id) {
          if (id.includes('/node_modules/zustand/') || id.includes('/node_modules/immer/')) {
            return 'vendor-state';
          }
        },
      },
    },
  },
})
