/**
 * Offline diagnostic export through the real Electron renderer/main bridge.
 * The isolated E2E app-data root also owns Electron's Downloads directory, so
 * this journey cannot leave a bundle in the developer's real home directory.
 */
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import type { ElectronApplication, Page } from 'playwright';
import {
  closeAbuElectron,
  createElectronDataRoot,
  dismissFirstRunOverlays,
  launchAbuElectron,
  removeElectronDataRoot,
  type ElectronDataRoot,
} from './electronHelpers';

const READY_TIMEOUT = 45_000;
const CHAT_PLACEHOLDER = '想让阿布帮你做点什么？';

async function waitForApp(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible({ timeout: READY_TIMEOUT });
}

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;

test.describe.serial('Electron diagnostic export', () => {
  test.afterEach(async () => {
    if (app) {
      await closeAbuElectron(app);
      app = undefined;
    }
    if (dataRoot) {
      removeElectronDataRoot(dataRoot);
      dataRoot = undefined;
    }
  });

  test('rechecks live state and exports a manifest plus run timeline', async () => {
    dataRoot = createElectronDataRoot();
    const launched = await launchAbuElectron(dataRoot);
    app = launched.app;
    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForApp(page);
    await dismissFirstRunOverlays(page);

    await page.getByRole('button', { name: /^(我|Me)$/ }).first().click();
    await page.getByRole('menuitem', { name: /^(设置|Settings)$/ }).click();
    await page.getByRole('button', { name: /^(反馈|Feedback)$/ }).click();

    await expect(page.getByText(/提交时会实时重检|Rechecked at submission/)).toBeVisible();
    await page.getByRole('button', { name: /导出离线诊断包|Save offline bundle/ }).click();
    await expect(page.getByText(/已导出诊断包|Bundle exported/)).toBeVisible({ timeout: READY_TIMEOUT });

    await page.getByRole('button', { name: /查看包内清单|View contents/ }).click();
    await expect(page.getByText('manifest.json', { exact: true })).toBeVisible();
    await expect(page.getByText('diagnostic-snapshot.json', { exact: true })).toBeVisible();
    await expect(page.getByText('runtime/run-timeline.json', { exact: true })).toBeVisible();

    const exportDir = path.join(dataRoot.appDataDir, 'Downloads', 'Abu-Diagnostic');
    await expect.poll(() => {
      try {
        return fs.readdirSync(exportDir).filter((name) => name.endsWith('.zip')).length;
      } catch {
        return 0;
      }
    }, { timeout: READY_TIMEOUT }).toBe(1);

    const bundleName = fs.readdirSync(exportDir).find((name) => name.endsWith('.zip'));
    expect(bundleName).toBeTruthy();
    const archive = unzipSync(new Uint8Array(fs.readFileSync(path.join(exportDir, bundleName!))));
    const manifest = JSON.parse(strFromU8(archive['manifest.json'])) as {
      schemaVersion?: unknown;
      missingRequiredFiles?: unknown;
    };
    const snapshot = JSON.parse(strFromU8(archive['diagnostic-snapshot.json'])) as {
      schemaVersion?: unknown;
      checkStartedAt?: unknown;
      freshness?: unknown;
    };
    const timeline = JSON.parse(strFromU8(archive['runtime/run-timeline.json'])) as {
      schemaVersion?: unknown;
      runs?: unknown;
    };

    expect(manifest).toMatchObject({ schemaVersion: 1, missingRequiredFiles: [] });
    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.checkStartedAt).toEqual(expect.any(Number));
    expect(['fresh', 'unknown']).toContain(snapshot.freshness);
    expect(timeline.schemaVersion).toBe(1);
    expect(Array.isArray(timeline.runs)).toBe(true);
  });
});
