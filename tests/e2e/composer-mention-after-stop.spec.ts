/**
 * Real-Electron repro for "@ 弹窗在停止后不再出现" (user report 2026-09-01):
 * send a delegated message, stop the run, type `@` again — the suggestion
 * popup must open. `/` kept working in the same composer, so the suspect is
 * the caret-tracking path that only `@` depends on.
 *
 * Deterministic: the only model endpoint is a loopback SSE mock that holds
 * every completion open (never answers) so the conversation stays `running`
 * until the user stops it.
 */
import { expect, test } from '@playwright/test';
import { createServer, type Server, type ServerResponse } from 'node:http';
import {
  closeAbuElectron,
  configureLocalMockProvider,
  createElectronDataRoot,
  dismissFirstRunOverlays,
  launchAbuElectron,
  removeElectronDataRoot,
} from './electronHelpers';

const READY_TIMEOUT = 45_000;
const CHAT_PLACEHOLDER = '想让阿布帮你做点什么？';

async function startHoldingMock(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const active = new Set<ServerResponse>();
  const server: Server = createServer(async (req, res) => {
    active.add(res);
    res.once('close', () => active.delete(res));
    for await (const _chunk of req) { /* drain */ }
    res.writeHead(200, {
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'content-type': 'text/event-stream; charset=utf-8',
    });
    // Never ends — the conversation stays running until the user stops it.
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock got no port');
  return {
    baseUrl: `http://2130706433:${address.port}/v1`,
    close: () => new Promise<void>((resolve) => {
      for (const res of active) res.destroy();
      server.close(() => resolve());
    }),
  };
}

test.describe('composer @ suggestions after stopping a run', () => {
  for (const viaNewTaskButton of [false, true]) {
  test(`typing @ after 停止 opens the suggestion popup again (via 新建任务 button: ${viaNewTaskButton})`, async () => {
    test.setTimeout(180_000);
    const mock = await startHoldingMock();
    const dataRoot = createElectronDataRoot();
    try {
      const launched = await launchAbuElectron(dataRoot);
      const page = await launched.app.firstWindow();
      await page.waitForLoadState('domcontentloaded');
      await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible({ timeout: READY_TIMEOUT });
      await dismissFirstRunOverlays(page);
      await configureLocalMockProvider(page, mock.baseUrl, { supportsTools: true, permissionMode: 'standard' });

      if (viaNewTaskButton) await page.getByRole('button', { name: '新建任务' }).first().click();

      // Delegate to a builtin agent exactly the way the user did: @ → pick → text → Enter.
      // Placeholder changes once an agent chip is selected — locate by role.
      const textbox = page.getByRole('textbox').first();
      await textbox.click();
      await textbox.type('@');
      await expect(page.getByRole('listbox')).toBeVisible();
      await page.getByRole('option', { name: /产品经理/ }).click();
      await textbox.type('出一版周报');
      await textbox.press('Enter');

      // The run is held open by the mock → 停止 appears; press it.
      const stop = page.getByRole('button', { name: '停止' });
      await expect(stop).toBeVisible({ timeout: 30_000 });
      await stop.click();
      await expect(stop).toHaveCount(0, { timeout: 30_000 });

      // Regression: `@` must open the popup again in the same composer.
      const chatBox = page.getByRole('textbox').first();
      await chatBox.click();
      await chatBox.type('@');
      await expect(page.getByRole('listbox')).toBeVisible({ timeout: 5_000 });

      await closeAbuElectron(launched.app);
    } finally {
      await mock.close();
      removeElectronDataRoot(dataRoot);
    }
  });
  }
});
