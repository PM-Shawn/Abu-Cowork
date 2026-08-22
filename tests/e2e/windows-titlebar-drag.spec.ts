/**
 * Real-Electron guard for the Windows title-bar lane being clipped when the
 * chat shares the window with a wide workspace panel. The drag geometry must
 * cover the whole Window Controls Overlay safe area rather than a flex item's
 * leftover width. Win32 WM_NCHITTEST then verifies the OS sees HTCAPTION across
 * both the chat and preview columns.
 */
import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ElectronApplication, Page } from 'playwright';
import {
  appRegionAt,
  closeAbuElectron,
  createElectronDataRoot,
  launchAbuElectron,
  removeElectronDataRoot,
  type ElectronDataRoot,
} from './electronHelpers';

const READY_TIMEOUT = 45_000;
const CHAT_PLACEHOLDER = '想让阿布帮你做点什么？';

function nativeHitTest(x: number, y: number): { point: number; root: number } {
  const script = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class AbuHitTest {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
}
'@
$point = New-Object AbuHitTest+POINT
$point.X = ${Math.round(x)}
$point.Y = ${Math.round(y)}
$hwnd = [AbuHitTest]::WindowFromPoint($point)
$root = [AbuHitTest]::GetAncestor($hwnd, 2)
$packed = [IntPtr](($point.Y -shl 16) -bor ($point.X -band 0xffff))
$pointResult = [AbuHitTest]::SendMessage($hwnd, 0x84, [IntPtr]::Zero, $packed).ToInt64()
$rootResult = [AbuHitTest]::SendMessage($root, 0x84, [IntPtr]::Zero, $packed).ToInt64()
[Console]::Write((@{ point = $pointResult; root = $rootResult } | ConvertTo-Json -Compress))
`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (result.status !== 0) throw new Error(result.stderr || 'native hit test failed');
  return JSON.parse(result.stdout) as { point: number; root: number };
}

async function waitForApp(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible({ timeout: READY_TIMEOUT });
}

async function dismissFirstRunOverlays(page: Page): Promise<void> {
  await page.evaluate(() => {
    const raw = window.localStorage.getItem('abu-settings');
    if (!raw) throw new Error('abu-settings was not initialized before E2E configuration');
    const persisted = JSON.parse(raw) as { state: Record<string, unknown>; version: number };
    Object.assign(persisted.state, {
      guideShown: true,
      guideOpen: false,
      hasAcknowledgedDisclaimer: true,
      hasRunSensitiveAudit_v015: true,
    });
    window.localStorage.setItem('abu-settings', JSON.stringify(persisted));
  });
  await page.reload();
  await waitForApp(page);
}

async function configureLocalProvider(page: Page): Promise<void> {
  await page.evaluate(() => {
    const raw = window.localStorage.getItem('abu-settings');
    if (!raw) throw new Error('abu-settings was not initialized before E2E configuration');
    const persisted = JSON.parse(raw) as { state: Record<string, unknown>; version: number };
    persisted.state.providers = [{
      id: 'windows-titlebar-e2e',
      source: 'custom',
      name: 'Windows titlebar E2E',
      enabled: true,
      apiFormat: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'not-a-real-secret',
      models: [{ id: 'e2e-model', label: 'E2E model', isCustom: true }],
      defaultModelId: 'e2e-model',
      status: 'verified',
      sortOrder: 0,
      userAdded: true,
    }];
    persisted.state.activeModel = { providerId: 'windows-titlebar-e2e', modelId: 'e2e-model' };
    window.localStorage.setItem('abu-settings', JSON.stringify(persisted));
  });
  await page.reload();
  await waitForApp(page);
}

async function openHtmlPreview(page: Page, filePath: string): Promise<void> {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const fileName = path.basename(filePath);
  const input = page.getByPlaceholder(CHAT_PLACEHOLDER);
  await input.fill(`[Attachment: \`${normalizedPath}\`]`);
  await input.press('Enter');
  const attachment = page.getByText(fileName, { exact: true }).first();
  await expect(attachment).toBeVisible({ timeout: READY_TIMEOUT });
  await attachment.click();
  await expect(page.locator('[data-abu-right-panel]')).toBeVisible({ timeout: READY_TIMEOUT });
}

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;

test.describe.serial('Electron Windows title-bar drag lane', () => {
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

  test('the lane remains natively draggable over the wide workspace column', async () => {
    test.skip(process.platform !== 'win32', 'the Window Controls Overlay lane only exists on Windows');

    dataRoot = createElectronDataRoot();
    const launched = await launchAbuElectron(dataRoot);
    app = launched.app;
    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForApp(page);
    await dismissFirstRunOverlays(page);
    await configureLocalProvider(page);

    await app.evaluate(({ BrowserWindow }) => {
      const [mainWindow] = BrowserWindow.getAllWindows();
      if (!mainWindow) throw new Error('main window missing');
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      mainWindow.setContentSize(1200, 800);
    });
    const chromeBeforeSplit = await page.evaluate(() => {
      const lane = document.querySelector('[data-abu-windows-drag-region="titlebar"]');
      const safeArea = document.querySelector('[data-abu-windows-titlebar-safe-area]');
      if (!lane || !safeArea) throw new Error('Windows title-bar geometry is incomplete');
      const laneRect = lane.getBoundingClientRect();
      const safeRect = safeArea.getBoundingClientRect();
      return {
        laneLeft: laneRect.left,
        laneRight: laneRect.right,
        safeLeft: safeRect.left,
        safeRight: safeRect.right,
      };
    });
    const reportPath = path.join(dataRoot.rootDir, 'windows-titlebar-report.html');
    fs.writeFileSync(reportPath, '<!doctype html><title>Windows titlebar E2E</title>');
    await openHtmlPreview(page, reportPath);

    const sample = await page.evaluate(() => {
      const lane = document.querySelector('[data-abu-windows-drag-region="titlebar"]');
      const safeArea = document.querySelector('[data-abu-windows-titlebar-safe-area]');
      const panel = document.querySelector('[data-abu-right-panel]');
      if (!lane || !safeArea || !panel) throw new Error('Windows split layout is incomplete');
      const laneRect = lane.getBoundingClientRect();
      const safeRect = safeArea.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      const x = Math.min(laneRect.right - 24, panelRect.left + panelRect.width / 2);
      if (x <= panelRect.left || x >= panelRect.right) {
        throw new Error('the drag sample is not horizontally inside the workspace panel');
      }
      return {
        x,
        y: laneRect.top + laneRect.height / 2,
        laneWidth: laneRect.width,
        laneLeft: laneRect.left,
        laneRight: laneRect.right,
        panelLeft: panelRect.left,
        safeLeft: safeRect.left,
        safeRight: safeRect.right,
      };
    });

    expect(chromeBeforeSplit.laneLeft).toBeCloseTo(chromeBeforeSplit.safeLeft, 0);
    expect(chromeBeforeSplit.laneRight).toBeCloseTo(chromeBeforeSplit.safeRight, 0);
    expect(sample.laneLeft).toBeCloseTo(sample.safeLeft, 0);
    expect(sample.laneRight).toBeCloseTo(sample.safeRight, 0);
    expect(sample.laneWidth).toBeCloseTo(sample.safeRight - sample.safeLeft, 0);
    expect(await appRegionAt(page, sample.x, sample.y)).toBe('drag');

    // Reproduce the real failure mode: after entering a long conversation, a
    // scrolled message descendant retains a large un-clipped layout rectangle.
    // A blanket `[data-electron-no-drag] *` selector lets that rectangle subtract
    // the native title bar even though the card clips it visually.
    const clippedProbe = await page.evaluate(({ x, y }) => {
      const card = document.querySelector('main[data-electron-no-drag]');
      if (!(card instanceof HTMLElement)) throw new Error('conversation card missing');
      const cardRect = card.getBoundingClientRect();
      const probe = document.createElement('div');
      probe.dataset.abuE2eClippedConversationProbe = 'true';
      Object.assign(probe.style, {
        position: 'absolute',
        left: `${Math.max(0, x - cardRect.left - 40)}px`,
        top: `${y - cardRect.top - 40}px`,
        width: '80px',
        height: '80px',
      });
      card.appendChild(probe);
      const rect = probe.getBoundingClientRect();
      return {
        region: getComputedStyle(probe).webkitAppRegion,
        coversSample: x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom,
      };
    }, { x: sample.x, y: sample.y });
    expect(clippedProbe.coversSample).toBe(true);
    expect(clippedProbe.region).toBe('none');
    expect(await appRegionAt(page, sample.x, sample.y)).toBe('drag');

    const windowPlan = await app.evaluate(({ BrowserWindow }) => {
      const [mainWindow] = BrowserWindow.getAllWindows();
      if (!mainWindow) throw new Error('main window missing');
      const contentBounds = mainWindow.getContentBounds();
      mainWindow.focus();
      mainWindow.moveTop();
      return {
        contentX: contentBounds.x,
        contentY: contentBounds.y,
      };
    });
    const sampleXs = [
      sample.laneLeft + 20,
      sample.panelLeft - 20,
      sample.panelLeft + 20,
      sample.x,
      sample.laneRight - 20,
    ];
    for (const x of sampleXs) {
      const hitTest = nativeHitTest(
        windowPlan.contentX + x,
        windowPlan.contentY + sample.y,
      );
      expect([hitTest.point, hitTest.root], `x=${x}: ${JSON.stringify(hitTest)}`).toContain(2);
    }
  });
});
