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
    resolve: {
      alias: {
        '@enterprise-modules': path.resolve(__dirname, '../Abu-enterprise-modules/src'),
        '@tauri-apps/plugin-fs': path.resolve(__dirname, 'node_modules/@tauri-apps/plugin-fs/dist-js/index.js'),
        // Private component tests are authored in the enterprise repository but
        // intentionally execute with the public host's single React/test stack.
        '@testing-library/react': path.resolve(__dirname, 'node_modules/@testing-library/react/dist/index.js'),
        'react/jsx-dev-runtime': path.resolve(__dirname, 'node_modules/react/jsx-dev-runtime.js'),
        'react/jsx-runtime': path.resolve(__dirname, 'node_modules/react/jsx-runtime.js'),
        react: path.resolve(__dirname, 'node_modules/react/index.js'),
        'lucide-react': path.resolve(__dirname, 'node_modules/lucide-react/dist/cjs/lucide-react.js'),
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
enterpriseConfig.test.include = ['enterprise-tests/**/*.test.{ts,tsx}'];

export default enterpriseConfig;
