import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: [
      { find: '@', replacement: path.resolve(__dirname, './src') },
      // Prevent vitest from trying to resolve MCP SDK (Node.js only)
      // Specific subpaths must come before the generic prefix
      { find: '@modelcontextprotocol/sdk/client/index.js', replacement: path.resolve(__dirname, './src/test/__mocks__/mcp.ts') },
      { find: '@modelcontextprotocol/sdk/client/stdio.js', replacement: path.resolve(__dirname, './src/test/__mocks__/mcp.ts') },
      { find: '@modelcontextprotocol/sdk/client/streamableHttp.js', replacement: path.resolve(__dirname, './src/test/__mocks__/mcp.ts') },
      { find: '@modelcontextprotocol/sdk/client/sse.js', replacement: path.resolve(__dirname, './src/test/__mocks__/mcp.ts') },
      { find: '@modelcontextprotocol/sdk', replacement: path.resolve(__dirname, './src/test/__mocks__/mcp.ts') },
    ],
  },
  define: {
    // Mirror vite.config.ts so modules that consume APP_VERSION via
    // `__APP_VERSION__` (see src/utils/version.ts) don't blow up under vitest.
    __APP_VERSION__: JSON.stringify('test'),
    // Tests run as the OSS build target (enterprise UI hidden).
    __ENTERPRISE_BUILD__: JSON.stringify(false),
    // Provide a stub URL so modules guarded by `if (!CONSOLE_URL) return`
    // (consoleDiagnostic, consoleAnnouncement) don't early-exit in CI where
    // .env.local is absent. Tests mock fetch independently — this value is
    // never actually called.
    'import.meta.env.VITE_CONSOLE_URL': JSON.stringify('https://console-test.local'),
  },
  test: {
    environment: 'happy-dom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'src/__tests__/**/*.{ts,tsx}', 'scripts/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      exclude: [
        'src/components/**',
        'src/test/**',
        'src/main.tsx',
        'src/App.tsx',
        '**/*.d.ts',
      ],
      thresholds: {
        // Core modules — enforce minimum coverage
        'src/core/llm/': { statements: 50 },
        'src/core/tools/': { statements: 50 },
        'src/core/context/': { statements: 60 },
        'src/stores/': { statements: 40 },
      },
    },
  },
});
