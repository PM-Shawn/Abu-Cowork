/**
 * Real-Electron acceptance: a touch held on a task row of the sidebar opens the row menu of that
 * row, also after another row was right-clicked, and 删除会话 chosen there deletes that task.
 *
 * The touch is Chromium's own touch input (`Input.dispatchTouchEvent`): the page gets real touch
 * pointer events and waits the real 700 ms. No touch screen is involved.
 *
 * Deterministic: a loopback mock provider answers each prompt with a fixed reply.
 */
import { expect, test } from '@playwright/test';
import type { Locator, Page } from 'playwright';
import { createServer } from 'node:http';
import {
  closeAbuElectron,
  configureLocalMockProvider,
  createElectronDataRoot,
  dismissFirstRunOverlays,
  launchAbuElectron,
  removeElectronDataRoot,
  type LaunchedApp,
} from './electronHelpers';

const READY_TIMEOUT = 45_000;
const FIRST_PROMPT = 'E2E长按第一个任务';
const SECOND_PROMPT = 'E2E长按第二个任务';
const REPLY = 'E2E长按答复';

function chunk(delta: Record<string, unknown>, finish: string | null): string {
  return `data: ${JSON.stringify({ id: 'long-press', object: 'chat.completion.chunk', created: 0, model: 'mock', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

async function startMock() {
  const server = createServer(async (req, res) => {
    // The request body is read to its end before the reply is written.
    for await (const part of req) void part;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(chunk({ role: 'assistant', content: REPLY }, null));
    res.write(chunk({}, 'stop'));
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing loopback address');
  return {
    baseUrl: `http://2130706433:${address.port}/v1`,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

async function showSidebar(page: Page) {
  const toggle = page.getByRole('button', { name: '显示侧栏', exact: true });
  if (await toggle.isVisible()) await toggle.click();
}

async function ask(page: Page, prompt: string) {
  const composer = page.getByRole('textbox').first();
  await composer.fill(prompt);
  await composer.press('Enter');
  await expect(page.getByText(REPLY)).toBeVisible({ timeout: 60_000 });
}

/** A touch that goes down on the row's title and stays down. */
async function touchAndHold(page: Page, row: Locator) {
  const box = await row.boundingBox();
  if (!box) throw new Error('The row has no box on the page');
  const session = await page.context().newCDPSession(page);
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: Math.round(box.x + 24), y: Math.round(box.y + box.height / 2) }],
  });
  return () => session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

test('a touch held on a task row opens the menu of that row after another row was right-clicked, and 删除会话 deletes that task', async () => {
  test.setTimeout(240_000);
  const dataRoot = createElectronDataRoot();
  const mock = await startMock();
  let launched: LaunchedApp | undefined;
  try {
    launched = await launchAbuElectron(dataRoot);
    const page = await launched.app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('[data-chat-composer]').first()).toBeVisible({ timeout: READY_TIMEOUT });
    await dismissFirstRunOverlays(page);
    await configureLocalMockProvider(page, mock.baseUrl);
    await ask(page, FIRST_PROMPT);
    await showSidebar(page);
    await page.getByLabel('Main navigation').getByRole('button', { name: '新任务', exact: true }).click();
    await expect(page.getByText(REPLY)).toHaveCount(0);
    await ask(page, SECOND_PROMPT);
    await showSidebar(page);

    const firstRow = page.locator('[data-conversation-row]').filter({ hasText: FIRST_PROMPT });
    const secondRow = page.locator('[data-conversation-row]').filter({ hasText: SECOND_PROMPT });
    const menu = page.getByRole('menu');
    await expect(firstRow).toHaveCount(1);
    await expect(secondRow).toHaveCount(1);

    await firstRow.click({ button: 'right' });
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);

    const release = await touchAndHold(page, secondRow);
    await expect(menu).toBeVisible();
    await expect(menu).toHaveCount(1);
    await release();
    await menu.getByRole('menuitem', { name: '删除会话', exact: true }).click();

    await expect(secondRow).toHaveCount(0);
    await expect(firstRow).toHaveCount(1);
    await expect(page.getByRole('region', { name: '通知' }).getByText('会话已删除')).toBeVisible();
  } finally {
    if (launched) await closeAbuElectron(launched.app);
    await mock.close();
    removeElectronDataRoot(dataRoot);
  }
});
