/**
 * WebdriverIO + tauri-driver configuration for Tauri native smoke tests.
 *
 * STATUS: V1 SKELETON — NOT active in CI.
 *   - tauri-driver does NOT support macOS (only Linux/Windows).
 *   - Requires a signed Tauri build bundle and a real desktop environment.
 *   - Activate via `npm run test:tauri-smoke` manually when the V2 pre-conditions are met.
 *   - The `.github/workflows/tauri-smoke.yml` workflow is `workflow_dispatch` only and
 *     uses `continue-on-error: true` on all test steps.
 *
 * See docs/TAURI-SMOKE.md for full instructions and V2 readiness checklist.
 */

import type { Options } from '@wdio/types';
import * as path from 'path';

export const config: Options.Testrunner = {
  runner: 'local',
  autoCompileOpts: {
    autoCompile: true,
    tsNodeOpts: {
      project: path.join(__dirname, 'tsconfig.node.json'),
      transpileOnly: true,
    },
  },

  specs: ['./e2e/tauri-smoke/**/*.e2e.ts'],
  exclude: [],

  maxInstances: 1,

  capabilities: [
    {
      // tauri-driver acts as a WebDriver endpoint that controls the Tauri app.
      // The app binary path must be an already-built production bundle.
      // On macOS: dist/macos/Abu.app (or the equivalent notarized .dmg mount).
      // On Linux: dist/linux/abu (the AppImage or Debian package).
      'tauri:options': {
        // Path to the built Tauri application binary.
        // Override via TAURI_APP_BINARY env var for CI flexibility.
        application:
          process.env.TAURI_APP_BINARY ??
          path.join(__dirname, 'src-tauri', 'target', 'release', 'Abu'),
      },
    },
  ],

  // tauri-driver is the local service that bridges WebDriver ↔ Tauri IPC.
  // Install with: cargo install tauri-driver
  // NOTE: tauri-driver does NOT support macOS — see docs/TAURI-SMOKE.md.
  services: [
    [
      'tauri',
      {
        // tauri-driver binary path (must be installed separately)
        tauriDriverPath: process.env.TAURI_DRIVER_PATH ?? 'tauri-driver',
      },
    ],
  ],

  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: {
    ui: 'bdd',
    // Generous timeout: app startup (cold Rust binary) can take 10–30s.
    timeout: 60000,
  },

  // No coverage — smoke tests validate the live binary, not the JS bundle.
};
