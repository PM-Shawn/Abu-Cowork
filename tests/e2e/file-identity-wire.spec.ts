/**
 * The file id an upload approval pins, measured where only the real shell can
 * measure it.
 *
 * Upload approval freezes a file's identity in the renderer and re-checks it
 * in the main process after the user has answered, so the two tiers have to
 * agree on the SAME 64-bit number. An NTFS file id packs a record sequence
 * number above the record index and passes 2^53 once records have been reused
 * enough, and the only number JSON has is the double — so `electron/fsHost.cjs`
 * puts `ino` and `dev` on the wire as exact decimal strings.
 *
 * Every tier's own tests pin its own half against a stat it takes itself. What
 * none of them can reach is the hop between them — the real preload's
 * `tauri:invoke` channel, whose argument serializer and structured clone sit
 * between the main process and the renderer. If that hop narrowed the value to
 * a number, upload approval would go back to comparing files only as finely as
 * a rounding step and no unit test would notice. So this launches the actual
 * app and reads the field back through the renderer's real bridge.
 *
 * The probe file lives in the launched app's own data directory, which is
 * inside the fs host's capability scope on every platform (`allowedRoots`
 * covers the temp root the E2E data root is made under).
 */
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import type { ElectronApplication } from 'playwright';
import {
  closeAbuElectron,
  launchAbuElectron,
  removeElectronDataRoot,
  type ElectronDataRoot,
} from './electronHelpers';

const READY_TIMEOUT = 45_000;

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;

test.describe('file identity on the Electron fs wire', () => {
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

  test('hands the renderer the whole 64-bit file id, not the nearest double', async () => {
    const launched = await launchAbuElectron();
    app = launched.app;
    dataRoot = launched;

    const probe = path.join(launched.appDataDir, 'upload-identity-probe.txt');
    fs.writeFileSync(probe, 'PUBLIC!!');
    // The value the OS actually reports, read the one way that cannot lose a
    // bit. Whatever the renderer gets back has to be this, exactly.
    const exact = fs.lstatSync(probe, { bigint: true });

    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await page.waitForLoadState('domcontentloaded');

    const wire = await page.evaluate(async (target) => {
      const internals = (window as unknown as {
        __TAURI_INTERNALS__?: { invoke(cmd: string, args: unknown): Promise<unknown> };
      }).__TAURI_INTERNALS__;
      if (!internals) throw new Error('the preload exposed no invoke bridge');
      // The command plugin-fs's own `lstat` sends, over the same channel the
      // renderer uses. `parseFileInfo` copies `ino` and `dev` across untouched
      // after this, which `electron/browserHost.downloads.test.cjs` walks.
      const info = await internals.invoke('plugin:fs|lstat', { path: target }) as {
        ino: unknown; dev: unknown; size: unknown;
      };
      return { ino: info.ino, dev: info.dev, size: info.size };
    }, probe);

    expect(wire.ino).toBe(String(exact.ino));
    expect(wire.dev).toBe(String(exact.dev));
    // The rest of FileInfo stays numeric, so only identity is text.
    expect(wire.size).toBe(8);
  });
});
