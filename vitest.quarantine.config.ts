/**
 * Vitest config for quarantined (potentially flaky) tests.
 *
 * Quarantine tests are intentionally excluded from the main gate (vitest.config.ts).
 * Run with: npm run test:quarantine
 *
 * Rules for quarantine tests:
 *   - Each file MUST start with: // QUARANTINED: <issue-url> (<date>)
 *   - Date must be within 4 weeks (enforced by src/__tests__/quarantine-sla.test.ts)
 *   - Fix or delete within 4 weeks — the SLA meta-test will fail otherwise
 */

import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: [
      { find: '@', replacement: path.resolve(__dirname, './src') },
      { find: '@modelcontextprotocol/sdk/client/index.js', replacement: path.resolve(__dirname, './src/test/__mocks__/mcp.ts') },
      { find: '@modelcontextprotocol/sdk/client/stdio.js', replacement: path.resolve(__dirname, './src/test/__mocks__/mcp.ts') },
      { find: '@modelcontextprotocol/sdk/client/streamableHttp.js', replacement: path.resolve(__dirname, './src/test/__mocks__/mcp.ts') },
      { find: '@modelcontextprotocol/sdk/client/sse.js', replacement: path.resolve(__dirname, './src/test/__mocks__/mcp.ts') },
      { find: '@modelcontextprotocol/sdk', replacement: path.resolve(__dirname, './src/test/__mocks__/mcp.ts') },
    ],
  },
  define: {
    __APP_VERSION__: JSON.stringify('test'),
    __ENTERPRISE_BUILD__: JSON.stringify(false),
    'import.meta.env.VITE_CONSOLE_URL': JSON.stringify('https://console-test.local'),
  },
  test: {
    environment: 'happy-dom',
    setupFiles: ['./src/test/setup.ts'],
    hookTimeout: 30000,
    // Only run quarantined tests — NOT the main suite.
    include: ['src/__tests__/quarantine/**/*.test.{ts,tsx}'],
    // No coverage thresholds: quarantined tests are excluded from gate enforcement.
    // Coverage from flaky tests is unreliable.
    coverage: {
      provider: 'v8',
      exclude: [
        'src/components/**',
        'src/test/**',
        'src/main.tsx',
        'src/App.tsx',
        '**/*.d.ts',
      ],
    },
  },
});
