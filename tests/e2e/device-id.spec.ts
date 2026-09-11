import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import type { ElectronApplication } from 'playwright';
import {
  closeAbuElectron,
  createElectronDataRoot,
  launchAbuElectron,
  removeElectronDataRoot,
  type ElectronDataRoot,
} from './electronHelpers';

/**
 * Real-Electron coverage for the file-backed analytics device_id.
 *
 * The unit tests (electron/deviceIdStore.test.ts) prove the precedence rules
 * over temp dirs. What only a real launch can prove is the part that actually
 * broke the console's device counts: that preload reconciles localStorage
 * against the file BEFORE any renderer module evaluates, and that the id
 * therefore survives losing the Chromium profile.
 */

const READY_TIMEOUT = 45_000;
const STORAGE_KEY = 'abu_device_id';
// Non-packaged builds — see appEnv.cjs's abuAppDataDir().
const APP_DATA_FOLDER = 'com.abu.app.electron-dev';

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;

function deviceIdFile(root: ElectronDataRoot): string {
  return path.join(root.appDataDir, APP_DATA_FOLDER, 'device-id.json');
}

function deviceIdRecord(root: ElectronDataRoot): { deviceId: string; source: string } {
  return JSON.parse(fs.readFileSync(deviceIdFile(root), 'utf8'));
}

/** The id the renderer's synchronous getDeviceId() would return right now. */
async function rendererDeviceId(instance: ElectronApplication): Promise<string | null> {
  const page = await instance.firstWindow({ timeout: READY_TIMEOUT });
  await page.waitForLoadState('domcontentloaded');
  return page.evaluate((key) => globalThis.localStorage.getItem(key), STORAGE_KEY);
}

/**
 * Simulate "reinstalled the app / cleared the cache": drop the whole Chromium
 * Local Storage tree while the app is closed. The profile path is read back
 * from the live app rather than assumed, because main.cjs redirects userData
 * for E2E runs on top of Playwright's own --user-data-dir switch.
 */
async function wipeChromiumLocalStorage(instance: ElectronApplication): Promise<void> {
  const userDataDir = await instance.evaluate(({ app: electronApp }) =>
    electronApp.getPath('userData'),
  );
  await closeAbuElectron(instance);
  const localStorageDir = path.join(userDataDir, 'Local Storage');
  fs.rmSync(localStorageDir, { recursive: true, force: true });
  expect(fs.existsSync(localStorageDir)).toBe(false);
}

test.describe.serial('analytics device id persistence', () => {
  test.beforeEach(() => {
    dataRoot = createElectronDataRoot();
  });

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

  test('keeps the same id after the Chromium profile is wiped', async () => {
    const root = dataRoot!;
    app = (await launchAbuElectron(root)).app;

    const firstId = await rendererDeviceId(app);
    expect(firstId).toBeTruthy();
    // Written on this very first launch, not deferred to the next one.
    expect(fs.existsSync(deviceIdFile(root))).toBe(true);
    expect(deviceIdRecord(root).deviceId).toBe(firstId);

    await wipeChromiumLocalStorage(app);
    app = undefined;

    app = (await launchAbuElectron(root)).app;

    // localStorage was genuinely empty at boot, so the only possible source of
    // this value is the file preload reconciled against.
    expect(await rendererDeviceId(app)).toBe(firstId);
    expect(deviceIdRecord(root).deviceId).toBe(firstId);
  });

  test('MIGRATION: an existing localStorage-only user keeps their id', async () => {
    const root = dataRoot!;
    app = (await launchAbuElectron(root)).app;

    const existingId = await rendererDeviceId(app);
    expect(existingId).toBeTruthy();

    // Reproduce the pre-change world exactly: the id lives in localStorage and
    // nowhere else. Anything other than adopting it would show up in the
    // console as the whole install base turning over in a single release.
    await closeAbuElectron(app);
    app = undefined;
    fs.rmSync(deviceIdFile(root), { force: true });
    expect(fs.existsSync(deviceIdFile(root))).toBe(false);

    app = (await launchAbuElectron(root)).app;

    expect(await rendererDeviceId(app)).toBe(existingId);
    expect(deviceIdRecord(root)).toMatchObject({
      deviceId: existingId,
      source: 'local-storage',
    });
  });
});
