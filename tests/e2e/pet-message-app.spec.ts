/**
 * A message from the pet window while the main window shows an app's home and
 * no conversation is open: the conversation it starts belongs to the general
 * shell. Runs the real Electron shell with the example market and a loopback
 * mock LLM (to read the system prompt of the run the message starts).
 *
 * The pet's reply field shows only under a notice of a conversation that is
 * waiting, and such a reply goes to that conversation. The message is
 * therefore sent from the pet window's own page through the bridge its field
 * uses (`pet-send-message`), so the pet's preload, the host's event allowlist
 * and the main window's listener are the real ones.
 */
import { createServer, type Server } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import {
  REPO_ROOT,
  closeAbuElectron,
  configureLocalMockProvider,
  dismissFirstRunOverlays,
  launchAbuElectron,
  removeElectronDataRoot,
} from './electronHelpers';

const READY_TIMEOUT = 45_000;
const APP_NAME = '店铺运营';
const APP_ID = 'shop-ops@abu-examples';
const TEAM_NAME = '店铺运营小组';
const MESSAGE = '帮我记一下：周五前交周报';

interface MockRequest { system: string; user: string }

function sse(text: string): string {
  const chunk = (delta: Record<string, unknown>, finish: string | null) => `data: ${JSON.stringify({ id: 'chatcmpl-abu-e2e-pet', object: 'chat.completion.chunk', created: 0, model: 'abu-e2e-local-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  return chunk({ content: text }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n';
}

/** Loopback OpenAI-compatible mock: answers every request with one line and records the prompts. */
async function startLlmMock(): Promise<{ baseUrl: string; requests: MockRequest[]; close: () => Promise<void> }> {
  const requests: MockRequest[] = [];
  const server: Server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    const body = JSON.parse(raw) as { messages?: Array<{ role: string; content: unknown }> };
    const messages = body.messages ?? [];
    const system = messages.filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n');
    const user = messages.filter((m) => m.role === 'user').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
    requests.push({ system, user });
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.end(sse('Abu E2E pet reply.'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    baseUrl: `http://2130706433:${port}/v1`,
    requests,
    close: () => new Promise((resolve, reject) => {
      server.closeAllConnections?.();
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

/** Unlock the pet experiment and open the pet, the way App.tsx boot restores it. */
async function enablePet(page: Page): Promise<void> {
  await page.evaluate(() => {
    const raw = window.localStorage.getItem('abu-settings');
    if (!raw) throw new Error('abu-settings was not initialized before enabling the pet');
    const persisted = JSON.parse(raw) as { state: Record<string, unknown>; version: number };
    persisted.state.labs = { ...(persisted.state.labs as Record<string, boolean> | undefined), pet: true };
    persisted.state.petOpen = true;
    window.localStorage.setItem('abu-settings', JSON.stringify(persisted));
  });
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
}

test('a pet message with the app home in view and no conversation open starts a conversation of the general shell', async () => {
  const llm = await startLlmMock();
  const launched = await launchAbuElectron();
  try {
    // A private copy of the example market, removed with the test's data root.
    const marketDir = path.join(launched.appDataDir, 'example-market');
    fs.cpSync(path.join(REPO_ROOT, 'examples', 'plugin-market'), marketDir, { recursive: true });
    const page = await launched.app.firstWindow();
    await expect(page.getByTestId('app-switcher-trigger')).toBeVisible({ timeout: READY_TIMEOUT });
    await dismissFirstRunOverlays(page);
    await configureLocalMockProvider(page, llm.baseUrl);

    // Add the example app from its market and enter it.
    await page.getByTestId('app-switcher-trigger').click();
    await page.getByTestId('app-switcher-discover').click();
    const market = page.getByTestId('app-market-dialog');
    await expect(market).toBeVisible({ timeout: READY_TIMEOUT });
    await market.getByTestId('app-market-add-market').click();
    await page.getByTestId('plugin-marketplace-dir-input').fill(marketDir);
    await page.getByTestId('plugin-marketplace-submit').click();
    await market.locator(`[data-testid="app-market-entry"][data-app-id="${APP_ID}"]`).getByTestId('app-market-use').click({ timeout: READY_TIMEOUT });
    const dialog = page.getByTestId('app-add-dialog');
    await dialog.getByLabel('SHOP_TOKEN', { exact: true }).fill('e2e-shop-token-placeholder');
    await dialog.getByTestId('app-add-confirm').click();
    await expect(page.getByTestId('app-switcher-current')).toHaveText(APP_NAME, { timeout: READY_TIMEOUT });

    await enablePet(page);
    // The app's home is in view and holds its binding and its team for the next conversation.
    await expect(page.getByTestId('app-switcher-current')).toHaveText(APP_NAME, { timeout: READY_TIMEOUT });
    await expect(page.getByTestId('app-home-title')).toHaveText(APP_NAME);
    await expect(page.getByTestId('composer-team-chip')).toContainText(TEAM_NAME, { timeout: READY_TIMEOUT });
    await expect.poll(() => launched.app.windows().some((win) => win.url().endsWith('/pet.html')), { timeout: READY_TIMEOUT }).toBe(true);
    const pet = launched.app.windows().find((win) => win.url().endsWith('/pet.html'))!;
    await pet.waitForLoadState('domcontentloaded');

    const before = llm.requests.length;
    await pet.evaluate(async (text) => {
      const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
      await internals.invoke('plugin:event|emit', { event: 'pet-send-message', payload: { text, conversationId: null } });
    }, MESSAGE);

    // The general shell, on the conversation the message started, which carries no app and no team.
    await expect(page.getByTestId('app-switcher-current')).toHaveText(/发现应用|Discover apps/, { timeout: READY_TIMEOUT });
    await expect(page.getByRole('main').getByText(MESSAGE, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    await expect.poll(() => llm.requests.slice(before).some((request) => request.user.includes(MESSAGE)), { timeout: READY_TIMEOUT }).toBe(true);
    const run = llm.requests.slice(before).find((request) => request.user.includes(MESSAGE))!;
    expect(run.system).not.toContain('## App Context');
    expect(run.system).not.toContain(`inside the app "${APP_NAME}"`);
    await expect(page.getByTestId('chat-title-app-badge')).toHaveCount(0);
    await expect(page.getByTestId('chat-title-team-badge')).toHaveCount(0);
    await expect(page.getByTestId('app-home-title')).toHaveCount(0);
    await expect(page.getByTestId('conversation-app-icon')).toHaveCount(0);
  } finally {
    await closeAbuElectron(launched.app);
    removeElectronDataRoot(launched);
    await llm.close();
  }
});
