import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { createElectronDataRoot, launchAbuElectron, closeAbuElectron, removeElectronDataRoot } from './electronHelpers';

test('six consecutive launches configure the temporary path before creating a native window', async () => {
  for (let index = 0; index < 6; index++) {
    const dataRoot = createElectronDataRoot();
    const custom = path.join(dataRoot.rootDir, 'custom temporary directory');
    const overridden = path.join(dataRoot.rootDir, 'environment override');
    fs.mkdirSync(custom);
    fs.mkdirSync(overridden);
    const expected = index % 2 === 0 ? dataRoot.rootDir : custom;
    const launched = await launchAbuElectron(dataRoot, {
      temporaryDirectory: index % 2 === 0 ? undefined : custom,
      extraEnv: { TEMP: overridden, ABU_E2E_TEMP_DIRECTORY: overridden },
      mainProcessPreload: path.resolve('tests/e2e/electronStartupRecorder.cjs'),
    });
    try {
      const page = await launched.app.firstWindow();
      await page.waitForLoadState('domcontentloaded');
      const observed = await launched.app.evaluate(({ app }) => ({
        current: app.getPath('temp'),
        created: (globalThis as typeof globalThis & { __abuStartupTemporaryDirectories: string[] }).__abuStartupTemporaryDirectories,
      }));
      expect(observed.current).toBe(expected);
      expect(observed.created.length).toBeGreaterThan(0);
      expect(observed.created.every(directory => directory === expected)).toBe(true);
    } finally {
      await closeAbuElectron(launched.app);
      removeElectronDataRoot(launched);
    }
  }
});
