import { defineConfig } from '@playwright/test';
import electronConfig from './playwright.electron.config';

export default defineConfig({
  ...electronConfig,
  testDir: './tests/performance',
  testMatch: 'multimedia.spec.ts',
  testIgnore: [],
});
