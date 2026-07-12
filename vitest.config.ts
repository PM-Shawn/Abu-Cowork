import { defineConfig, configDefaults } from 'vitest/config';
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
      { find: '@modelcontextprotocol/sdk/validation/cfworker', replacement: path.resolve(__dirname, './src/test/__mocks__/mcp.ts') },
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
    // v8 coverage instrumentation adds overhead to setup/beforeAll hooks on cold
    // CI runners. Give hooks extra headroom so they don't time out spuriously.
    // testTimeout is deliberately NOT set here — test bodies keep the default 5 s
    // so hung tests fail fast rather than masking hangs with a generous ceiling.
    hookTimeout: 30000,
    include: ['src/**/*.test.{ts,tsx}', 'src/__tests__/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'src/__tests__/quarantine/**'],
    // NOTE: the existing *.integration.test.ts files here are fast, in-process
    // (Tauri/SDKs mocked — no real DB or network), so they stay in the default
    // gate. If P3 introduces slow / external-dependency tests, give them a
    // dedicated script + exclude them here then — never silently drop them.
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
        // Global baselines — buffered lower bounds (floor, not auto-ratchet).
        // Baseline = full default run (unit + the fast in-process integration
        // tests), rounded down to the nearest integer, minus ~2 points drift
        // tolerance:
        //   statements 52.17 → 50, branches 43.38 → 41,
        //   functions  49.32 → 47, lines    53.47 → 51
        // Do NOT use autoUpdate: true — that rewrites this tracked config on every
        // passing run, dirtying the working tree and breaking /goal's `git status`
        // clean criterion, and it pins thresholds to exact decimals causing <1%
        // fluctuation false-reds. To raise these floors, do it manually in a
        // dedicated "raise coverage floor" commit — never let automation touch them.
        statements: 50,
        branches: 41,
        functions: 47,
        lines: 51,
        // Per-module floors — preserve existing minimums (do not lower).
        'src/core/llm/': { statements: 50 },
        'src/core/tools/': { statements: 50 },
        'src/core/context/': { statements: 60 },
        'src/stores/': { statements: 40 },
      },
    },
  },
});
