import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ElectronApplication } from 'playwright';
import { invokeHost } from './computerUseEvalHelpers';
import {
  closeAbuElectron,
  launchAbuElectron,
  removeElectronDataRoot,
  type ElectronDataRoot,
} from './electronHelpers';

test.skip(process.platform !== 'win32', 'Windows screen capture behavior');

test('main window capture protection follows the Windows capture capability', async () => {
  let app: ElectronApplication | undefined;
  let dataRoot: ElectronDataRoot | undefined;
  try {
    const launched = await launchAbuElectron();
    app = launched.app;
    dataRoot = launched;
    const page = await app.firstWindow({ timeout: 45_000 });
    await expect(page.getByPlaceholder('想让阿布帮你做点什么？')).toBeVisible({ timeout: 45_000 });
    const state = await app.evaluate(async ({ BrowserWindow }, managerPath) => {
      const main = BrowserWindow.getAllWindows().find((window) =>
        !window.isDestroyed() && window.webContents.getURL().includes('index.html'),
      );
      if (!main) throw new Error('Main window is unavailable');
      const mainModule = (process as NodeJS.Process & { mainModule?: { require: NodeRequire } }).mainModule;
      if (!mainModule) throw new Error('Main module is unavailable');
      const manager = mainModule.require(managerPath) as { readCaptureSessionExclusionCapability: () => Promise<boolean> };
      return { id: main.id, protectedFromCapture: main.isContentProtected(), supported: await manager.readCaptureSessionExclusionCapability() };
    }, path.join(process.cwd(), 'electron/nativeHelperManager.cjs'));
    expect(state.protectedFromCapture).toBe(!state.supported);
    await app.evaluate(({ app, BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('index.html'));
      if (!main) throw new Error('Main window is unavailable');
      new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
      main.destroy();
      app.emit('activate');
    });
    await expect.poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL().includes('index.html'))?.id ?? 0)).toBeGreaterThan(state.id);
    const replacement = app.windows().find((window) => window.url().includes('index.html'));
    if (!replacement) throw new Error('Recreated main window is unavailable');
    await expect(replacement.getByPlaceholder('想让阿布帮你做点什么？')).toBeVisible({ timeout: 45_000 });
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL().includes('index.html'))?.isContentProtected())).toBe(!state.supported);
  } finally {
    if (app) await closeAbuElectron(app);
    if (dataRoot) removeElectronDataRoot(dataRoot);
  }
});

test('Computer Use captures through the visible main window', async () => {
  let app: ElectronApplication | undefined;
  let dataRoot: ElectronDataRoot | undefined;
  let backgroundId: number | undefined;
  try {
    const launched = await launchAbuElectron(undefined, { extraEnv: { ABU_E2E_DECLINE_CU_APPROVALS: '0', ABU_E2E_QUIET_WINDOW: '0' } });
    app = launched.app;
    dataRoot = launched;
    const page = await app.firstWindow({ timeout: 45_000 });
    await expect(page.getByPlaceholder('想让阿布帮你做点什么？')).toBeVisible({ timeout: 45_000 });
    await invokeHost(page, 'computer_use_set_enabled', { enabled: true });
    const processId = await app.evaluate(() => process.pid);
    const sessionPromise = invokeHost<{ status: string; token: string }>(page, 'computer_use_begin_session', {
      conversationId: 'capture-e2e', toolCallId: 'screen-capture', loopId: 'capture-e2e-loop',
      interactionMode: 'foreground', scope: 'screen-read', permissionMode: 'standard',
      actionIntent: { action: 'screenshot', category: 'none', summary: '' },
    });
    const approvalPromise = promisify(execFile)('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-File', path.join(process.cwd(), 'tests/e2e/allow-screen-capture.ps1'),
      '-ProcessId', String(processId), '-DialogTitle', '允许 Abu 查看当前屏幕？', '-AcceptLabel', '允许本任务',
    ], { timeout: 25_000, env: { ...process.env, TEMP: launched.rootDir, TMP: launched.rootDir } });
    const [session] = await Promise.all([sessionPromise, approvalPromise]);
    expect(session.status).toBe('authorized');
    await page.evaluate(async () => {
      const cover = document.createElement('div');
      cover.style.cssText = 'position:fixed;inset:0;background:#ff0000;z-index:2147483647';
      document.body.append(cover);
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    const fixture = await app.evaluate(async ({ BrowserWindow, screen }) => {
      const main = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('index.html'));
      if (!main) throw new Error('Main window is unavailable');
      const bounds = main.getBounds();
      const background = new BrowserWindow({
        ...bounds, frame: false, show: false, focusable: false, alwaysOnTop: true,
        backgroundColor: '#00ff00', webPreferences: { sandbox: true },
      });
      await background.loadURL('data:text/html,<body style="margin:0;background:lime"></body>');
      background.showInactive();
      main.setAlwaysOnTop(true);
      main.show();
      main.moveTop();
      return {
        backgroundId: background.id,
        backgroundHandle: `0x${background.getNativeWindowHandle().readBigUInt64LE().toString(16)}`,
        point: screen.dipToScreenPoint({ x: bounds.x + Math.floor(bounds.width / 2), y: bounds.y + Math.floor(bounds.height / 2) }),
        protectedFromCapture: main.isContentProtected(),
      };
    });
    backgroundId = fixture.backgroundId;
    const readPixel = async (screenshot: CaptureResult) => app!.evaluate(({ nativeImage }, { screenshot, point }) => {
      const image = nativeImage.createFromBuffer(Buffer.from(screenshot.base64, 'base64'));
      const size = image.getSize();
      const bitmap = image.toBitmap();
      const x = Math.floor((point.x - screenshot.origin_x) / screenshot.scale_factor);
      const y = Math.floor((point.y - screenshot.origin_y) / screenshot.scale_factor);
      if (x < 0 || y < 0 || x >= size.width || y >= size.height) throw new Error('Test pixel is outside the capture');
      const offset = (y * size.width + x) * 4;
      return [bitmap[offset + 2], bitmap[offset + 1], bitmap[offset]];
    }, { screenshot, point: fixture.point });
    const ordinaryCapture = () => app!.evaluate(async (_electron, managerPath) => {
      const mainModule = (process as NodeJS.Process & { mainModule?: { require: NodeRequire } }).mainModule;
      if (!mainModule) throw new Error('Main module is unavailable');
      const manager = mainModule.require(managerPath) as { nativeHelperDispatch: (command: string, args: Record<string, unknown>) => Promise<CaptureResult> };
      return manager.nativeHelperDispatch('capture_screen', {});
    }, path.join(process.cwd(), 'electron/nativeHelperManager.cjs'));
    await expect.poll(async () => readPixel(await ordinaryCapture())).toEqual(
      fixture.protectedFromCapture ? [0, 255, 0] : [255, 0, 0],
    );
    for (const command of ['capture_screen', 'capture_screen_excluding', 'capture_screen']) {
      const screenshot = await invokeHost<CaptureResult>(page, command, {
        __abuComputerUseToken: session.token,
        excludeWindowId: 0,
        excludedMainWindow: fixture.backgroundHandle,
        excluded_main_window: fixture.backgroundHandle,
      });
      expect(await readPixel(screenshot)).toEqual([0, 255, 0]);
    }
    await expect(invokeHost(page, 'capture_screen', {
      __abuComputerUseToken: session.token, x: 2147483647,
    })).rejects.toThrow('capture region origin is outside the target monitor');
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL().includes('index.html'))?.isContentProtected())).toBe(fixture.protectedFromCapture);
    await invokeHost(page, 'computer_use_end_session', { __abuComputerUseToken: session.token });
    await invokeHost(page, 'computer_use_end_task', { conversationId: 'capture-e2e', loopId: 'capture-e2e-loop' });
  } finally {
    if (app && backgroundId) await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.destroy(), backgroundId);
    if (app) await closeAbuElectron(app);
    if (dataRoot) removeElectronDataRoot(dataRoot);
  }
});

interface CaptureResult {
  base64: string;
  origin_x: number;
  origin_y: number;
  scale_factor: number;
}

test('main window opens with content protection when the native helper is missing', async () => {
  const helper = path.join(process.cwd(), 'electron/native-helper/target/release/native-helper.exe');
  const savedHelper = path.join(process.cwd(), '.agent/capture-startup-native-helper.exe');
  expect(fs.existsSync(savedHelper)).toBe(false);
  fs.renameSync(helper, savedHelper);
  let app: ElectronApplication | undefined;
  let dataRoot: ElectronDataRoot | undefined;
  try {
    const launched = await launchAbuElectron();
    app = launched.app;
    dataRoot = launched;
    const page = await app.firstWindow({ timeout: 45_000 });
    await expect(page.getByPlaceholder('想让阿布帮你做点什么？')).toBeVisible({ timeout: 45_000 });
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL().includes('index.html'))?.isContentProtected())).toBe(true);
  } finally {
    try {
      if (app) await closeAbuElectron(app);
      if (dataRoot) removeElectronDataRoot(dataRoot);
    } finally {
      fs.renameSync(savedHelper, helper);
    }
  }
});
