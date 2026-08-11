import { defineConfig, mergeConfig } from 'vitest/config';
import path from 'path';
import baseConfig from './vitest.config';

/**
 * Opt-in private-module gate. The default OSS test command never requires the
 * sibling repository; enterprise builders run this config after checking out
 * Abu-enterprise-modules next to Abu-opensource.
 */
const enterpriseConfig = mergeConfig(
  baseConfig,
  defineConfig({
    define: {
      __ENTERPRISE_BUILD__: JSON.stringify(true),
    },
    resolve: {
      alias: {
        '@enterprise-modules': path.resolve(__dirname, '../Abu-enterprise-modules/src'),
        '@tauri-apps/api/path': path.resolve(__dirname, 'node_modules/@tauri-apps/api/path.js'),
        '@tauri-apps/plugin-deep-link': path.resolve(__dirname, 'node_modules/@tauri-apps/plugin-deep-link/dist-js/index.js'),
        '@tauri-apps/plugin-fs': path.resolve(__dirname, 'node_modules/@tauri-apps/plugin-fs/dist-js/index.js'),
        '@tauri-apps/plugin-http': path.resolve(__dirname, 'node_modules/@tauri-apps/plugin-http/dist-js/index.js'),
        '@tauri-apps/plugin-opener': path.resolve(__dirname, 'node_modules/@tauri-apps/plugin-opener/dist-js/index.js'),
        // Private component tests are authored in the enterprise repository but
        // intentionally execute with the public host's single React/test stack.
        '@testing-library/react': path.resolve(__dirname, 'node_modules/@testing-library/react/dist/index.js'),
        'react/jsx-dev-runtime': path.resolve(__dirname, 'node_modules/react/jsx-dev-runtime.js'),
        'react/jsx-runtime': path.resolve(__dirname, 'node_modules/react/jsx-runtime.js'),
        react: path.resolve(__dirname, 'node_modules/react/index.js'),
        'lucide-react': path.resolve(__dirname, 'node_modules/lucide-react/dist/cjs/lucide-react.js'),
        '@noble/curves/ed25519': path.resolve(__dirname, 'node_modules/@noble/curves/esm/ed25519.js'),
        '@noble/hashes/sha2': path.resolve(__dirname, 'node_modules/@noble/hashes/esm/sha2.js'),
        fflate: path.resolve(__dirname, 'node_modules/fflate/esm/browser.js'),
        'zustand/react/shallow': path.resolve(__dirname, 'node_modules/zustand/esm/react/shallow.mjs'),
        'zustand/middleware/immer': path.resolve(__dirname, 'node_modules/zustand/esm/middleware/immer.mjs'),
        'zustand/middleware': path.resolve(__dirname, 'node_modules/zustand/esm/middleware.mjs'),
        zustand: path.resolve(__dirname, 'node_modules/zustand/esm/index.mjs'),
      },
    },
    test: {
      // Replaced below because mergeConfig concatenates array values.
      include: [],
    },
  }),
);

enterpriseConfig.test ??= {};
// Two test populations share this gate: the host-side enterprise tests in
// this repo, and the overlay's own unit tests in the sibling repository
// (dependency resolution there works via the overlay's gitignored
// node_modules -> ../Abu-Cowork/node_modules symlink).
enterpriseConfig.test.include = [
  'enterprise-tests/**/*.test.{ts,tsx}',
  '../Abu-enterprise-modules/src/**/*.test.{ts,tsx}',
];
enterpriseConfig.server ??= {};
enterpriseConfig.server.fs = {
  ...(enterpriseConfig.server.fs ?? {}),
  allow: [
    ...(enterpriseConfig.server.fs?.allow ?? []),
    path.resolve(__dirname),
    path.resolve(__dirname, '../Abu-enterprise-modules'),
  ],
};

export default enterpriseConfig;
