import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, test } from '@playwright/test';
import { WebSocket } from 'ws';
import {
  closeAbuElectron, configureLocalMockProvider, dismissFirstRunOverlays,
  launchAbuElectron, removeElectronDataRoot,
} from './electronHelpers';

test('deleting a conversation sends a dedicated whole-conversation notification through the real bridge', async () => {
  const model = createServer(async (request, response) => {
    for await (const part of request) void part;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const delta of [{ role: 'assistant', content: 'Release test answer' }, {}]) {
      response.write(`data: ${JSON.stringify({ id: 'release-test', object: 'chat.completion.chunk',
        created: 0, model: 'mock', choices: [{ index: 0, delta, finish_reason: Object.keys(delta).length ? null : 'stop' }],
      })}\n\n`);
    }
    response.end('data: [DONE]\n\n');
  });
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
  const address = model.address();
  if (!address || typeof address === 'string') throw new Error('Missing model server address');
  const launched = await launchAbuElectron();
  let extension: WebSocket | undefined;
  try {
    const page = await launched.app.firstWindow();
    await expect(page.locator('[data-chat-composer]').first()).toBeVisible({ timeout: 45_000 });
    await dismissFirstRunOverlays(page);
    await page.evaluate(() => {
      localStorage.setItem('abu-mcp-store', JSON.stringify({ version: 1, state: { servers: {
        'abu-browser-bridge': { config: { name: 'abu-browser-bridge', transport: 'stdio',
          command: 'abu-chrome-bridge-runtime', args: [], enabled: true }, status: 'disconnected', tools: [] },
      } } }));
    });
    await configureLocalMockProvider(page, `http://2130706433:${address.port}/v1`);
    let status: { wsPort: number; token: string } | undefined;
    await expect.poll(async () => {
      const response = await fetch('http://127.0.0.1:9875/status').catch(() => undefined);
      if (!response?.ok) return false;
      status = await response.json() as typeof status;
      return !!status?.token;
    }, { timeout: 30_000 }).toBe(true);
    extension = new WebSocket(`ws://127.0.0.1:${status!.wsPort}`, [status!.token]);
    const controls: unknown[] = [];
    extension.on('message', data => controls.push(JSON.parse(String(data))));
    await once(extension, 'open');
    const prompt = 'E2E browser conversation release';
    await page.locator('[data-chat-composer]').first().fill(prompt);
    await page.locator('[data-chat-composer]').first().press('Enter');
    await expect(page.getByText('Release test answer')).toBeVisible({ timeout: 45_000 });
    const conversationId = await page.evaluate(() => Object.keys(
      JSON.parse(localStorage.getItem('abu-chat')!).state.conversationIndex,
    )[0]);
    expect(conversationId).toBeTruthy();
    const showSidebar = page.getByRole('button', { name: '显示侧栏', exact: true });
    if (await showSidebar.isVisible()) await showSidebar.click();
    const row = page.locator(`[data-conversation-row="${conversationId}"]`);
    await row.click({ button: 'right' });
    await page.getByRole('menuitem', { name: '删除会话', exact: true }).click();
    await expect(row).toHaveCount(0);
    await expect.poll(() => controls).toContainEqual({ type: 'conversation-deleted', ownerId: conversationId });
    const notices = page.getByRole('region', { name: '通知' });
    await notices.getByRole('button', { name: '撤销', exact: true }).press('Enter');
    await expect(page.locator('[data-conversation-row]')).toHaveCount(1);
    const restoredIds = await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('abu-chat')!).state.conversationIndex));
    expect(restoredIds).toHaveLength(1);
    expect(restoredIds[0]).not.toBe(conversationId);
  } finally {
    extension?.terminate();
    await closeAbuElectron(launched.app);
    model.closeAllConnections();
    await new Promise<void>(resolve => model.close(() => resolve()));
    removeElectronDataRoot(launched);
  }
});
