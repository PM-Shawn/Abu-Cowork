import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { version as packageVersion } from './package.json'

// electron-builder can override extraMetadata.version for an RC/release
// candidate, but the renderer is compiled before that packaging step. CI must
// pass the same candidate here or the About screen and diagnostics will claim
// the package.json version while Electron's app.getVersion() reports another
// one (for example UI 0.34.0 inside an actual 0.34.0-rc.38 bundle).
const version = process.env.ABU_BUILD_VERSION?.trim() || packageVersion
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Invalid ABU_BUILD_VERSION: ${version}`)
}

// Build target switch: OSS (default) or Enterprise
// ABU_BUILD_TARGET=enterprise → resolves @enterprise-modules to sibling private repo
const BUILD_TARGET = process.env.ABU_BUILD_TARGET ?? 'oss'
const enterpriseModulesPath = BUILD_TARGET === 'enterprise'
  ? path.resolve(__dirname, '../Abu-enterprise-modules/src')
  : path.resolve(__dirname, 'src/enterprise-modules-stub')
const srcPath = path.resolve(__dirname, './src')
const enterprisePeerPackages = [
  'react',
  'react-dom',
  'zustand',
  '@noble/curves',
  '@noble/hashes',
  '@tauri-apps/api',
  '@tauri-apps/plugin-fs',
  '@tauri-apps/plugin-http',
  'fflate',
  'lucide-react',
]
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const enterprisePeerAliases = BUILD_TARGET === 'enterprise'
  ? enterprisePeerPackages.map((pkg) => ({
      find: new RegExp(`^${escapeRegExp(pkg)}(?=$|/)`),
      replacement: path.resolve(__dirname, 'node_modules', pkg),
    }))
  : []

console.log(`[vite] ABU_BUILD_TARGET=${BUILD_TARGET} → @enterprise-modules → ${enterpriseModulesPath}`)

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(version),
    // Build-target flag for the client: enterprise-only UI (the enterprise-mode
    // settings entry + bind flow) is gated on this so it never shows in OSS builds.
    __ENTERPRISE_BUILD__: JSON.stringify(BUILD_TARGET === 'enterprise'),
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: /^@enterprise-modules(?=$|\/)/, replacement: enterpriseModulesPath },
      { find: /^@\//, replacement: `${srcPath}/` },
      ...enterprisePeerAliases,
    ],
    // Enterprise modules are a sibling peer-dependency package. Vite 8's
    // Rolldown resolver otherwise starts from the external importer's path and
    // cannot see the host node_modules directory. Resolve every shared runtime
    // from this application root so OSS and Enterprise builds use one copy.
    dedupe: enterprisePeerPackages,
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
