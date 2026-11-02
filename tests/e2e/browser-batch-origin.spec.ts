import { expect, test } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { runBatch, type BatchDeps } from '../../abu-browser-bridge/src/batch';
import type { BatchStep } from '../../abu-browser-bridge/src/types';
import {
  closeAbuElectron,
  createElectronDataRoot,
  dismissFirstRunOverlays,
  launchAbuElectron,
  removeElectronDataRoot,
  type ElectronDataRoot,
} from './electronHelpers';

test('stops an approved batch before any step when its native tab has no web origin', async () => {
  let app: ElectronApplication | undefined;
  const dataRoot: ElectronDataRoot = createElectronDataRoot();
  try {
    app = (await launchAbuElectron(dataRoot)).app;
    const page = await app.firstWindow();
    await expect(page.getByPlaceholder('想让阿布帮你做点什么？')).toBeVisible({ timeout: 45_000 });
    await expect.poll(() => page.evaluate(() => Boolean(localStorage.getItem('abu-settings')))).toBe(true);
    await dismissFirstRunOverlays(page);
    const transport = await app.evaluate(async ({ app }) => {
      const require = process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/main.cjs`);
      return require('./browserAutomationHost.cjs').ensureBrowserAutomationServer();
    });
    const ownerId = 'batch-origin-acceptance';
    const send: BatchDeps['send'] = async (action, payload) => {
      const response = await fetch(transport.endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${transport.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, payload: { ...payload, ownerId } }),
      });
      expect(response.ok).toBe(true);
      return response.json();
    };
    const tabs = await send('get_tabs', {});
    expect(tabs.success).toBe(true);
    const listing = tabs.data as { windows: Array<{ tabs: Array<{ tabId: number; url: string }> }> };
    const tab = listing.windows.flatMap(window => window.tabs)[0];
    expect(tab).toBeDefined();
    await app.evaluate(async ({ webContents }, id) => {
      const target = webContents.fromId(id);
      if (!target) throw new Error('The native batch tab is missing');
      await target.loadURL('about:blank');
    }, tab.tabId);
    expect(await app.evaluate(({ webContents }, id) => webContents.fromId(id)?.getURL(), tab.tabId)).toBe('about:blank');

    const batches: BatchStep[][] = [
      [{ action: 'read' }, { action: 'find', query: { text: 'Submit' } }],
      [{ action: 'click', locator: { css: 'button' } }],
    ];
    for (const steps of batches) {
      const sent: string[] = [];
      const result = await runBatch({
        now: () => 0,
        send: async (action, payload) => { sent.push(action); return send(action, payload); },
      }, tab.tabId, steps, 'https://approved.example');
      expect(result.stopped).toBe('origin-unverifiable');
      expect(result.origin).toBe('https://approved.example');
      expect(result.completedSteps).toEqual([]);
      expect(result.failedStep).toBeUndefined();
      expect(result.remainingSteps).toBe(steps.length);
      expect(sent).toEqual(['get_tabs']);
    }
  } finally {
    if (app) await closeAbuElectron(app);
    removeElectronDataRoot(dataRoot);
  }
});
