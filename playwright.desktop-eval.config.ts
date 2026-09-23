import { defineConfig } from '@playwright/test';
import electronConfig from './playwright.electron.config';

// Keep per-attempt evidence, including attachments for passing safety tests.
// The ordinary list reporter alone does not persist those report bodies.
export default defineConfig(electronConfig, {
  testMatch: 'windows-desktop-computer-use.spec.ts',
  reporter: [['list'], ['json', { outputFile: 'test-results/windows-desktop-evaluation.json' }]],
});
