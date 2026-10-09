/**
 * A confirming control that is painted by itself takes no pointer press that began before it could
 * be read (AGENTS.md §6.1, Settling). Real mouse events in the real Electron shell, one journey per
 * surface:
 *   - the agent's question dock: a question that has just arrived, and the page a double press turns to;
 *   - the plugin install window, whose 「安装」 appears once the package has been read;
 *   - the app confirmation inside the app market (「使用」);
 *   - the app confirmation on the page (a scene whose plugin is gone).
 * Each early press is followed by the user's own press, which answers once.
 */
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import {
  REPO_ROOT,
  closeAbuElectron,
  configureLocalMockProvider,
  createElectronDataRoot,
  dismissFirstRunOverlays,
  launchAbuElectron,
  pressWhenSettled,
  removeElectronDataRoot,
  type ElectronDataRoot,
} from './electronHelpers';
import { CHAT_PLACEHOLDER, READY_TIMEOUT, startOpenAiMock, taskRequests, waitForApp, type OpenAiMock } from './openAiMock';

// TOAST_SETTLE_MS (src/components/ds/styles.ts).
const SETTLE_MS = 500;
const APP_NAME = '店铺运营';
const APP_ID = 'shop-ops@abu-examples';
const PLUGIN_TITLE = /店铺助手|shop-assistant/;
const EXTENSIONS = /^(扩展|Extensions)(\s.*)?$/;
const PLUGINS_TAB = /^(插件|Plugins)(\s.*)?$/;
const NEW_TASK = /^(新任务|New task)$/;
const CLOSING_REPLY = 'abu-e2e-early-press-closing-reply';

interface Watch { appeared: number | null; presses: number[] }
interface Wanted { selector: string; text?: string }

/**
 * Starts recording, in the page: when a control matching `wanted` first joins it, and when each
 * pointer press begins. Both on the clock the layers read. Called before the action that makes the
 * control appear.
 */
async function watchFor(page: Page, wanted: Wanted): Promise<void> {
  await page.evaluate(({ selector, text }) => {
    const host = window as unknown as { __earlyPress?: Watch; __earlyPressLooks?: () => void };
    const state: Watch = { appeared: null, presses: [] };
    host.__earlyPress = state;
    host.__earlyPressLooks = () => {
      if (state.appeared !== null) return;
      const found = Array.from(document.querySelectorAll(selector)).some((element) => !text || element.textContent?.includes(text));
      if (found) state.appeared = performance.now();
    };
    if (document.documentElement.hasAttribute('data-early-press-watch')) return;
    document.documentElement.setAttribute('data-early-press-watch', '');
    new MutationObserver(() => host.__earlyPressLooks?.()).observe(document.body, { childList: true, subtree: true, characterData: true });
    document.addEventListener('pointerdown', () => { host.__earlyPress?.presses.push(performance.now()); }, true);
  }, wanted);
}

/**
 * Presses the control with the mouse the moment it is on the page, the way the second press of a
 * double press arrives, and checks that the press began inside the settle interval.
 */
async function pressEarly(page: Page, wanted: Wanted): Promise<void> {
  const centre = await page.waitForFunction(({ selector, text }) => {
    const control = Array.from(document.querySelectorAll(selector)).find((element) => !text || element.textContent?.includes(text));
    if (!control) return null;
    const box = control.getBoundingClientRect();
    return box.width > 0 && box.height > 0 ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
  }, wanted, { polling: 'raf', timeout: READY_TIMEOUT });
  const { x, y } = await centre.jsonValue() as { x: number; y: number };
  await page.mouse.click(x, y);
  const watch = await page.evaluate(() => (window as unknown as { __earlyPress: Watch }).__earlyPress);
  expect(watch.appeared, 'the control was seen joining the page').not.toBeNull();
  const elapsed = watch.presses[watch.presses.length - 1] - (watch.appeared as number);
  expect(elapsed, 'the press began after the control was painted').toBeGreaterThanOrEqual(0);
  expect(elapsed, 'the press began inside the settle interval').toBeLessThan(SETTLE_MS);
}

/** The settle interval of the box around `target` has passed. */
async function settled(target: Locator): Promise<void> {
  await expect(target).toBeVisible();
  await expect(target.locator('xpath=ancestor::*[@data-ds-settling]')).toHaveCount(0);
}

/** The example market, with a connector that asks for no value: its confirming buttons can be pressed at once. */
function seedMarket(root: string): string {
  const dir = path.join(root, 'market');
  fs.cpSync(path.join(REPO_ROOT, 'examples', 'plugin-market'), dir, { recursive: true });
  const manifestPath = path.join(dir, 'plugins', 'shop-assistant', '.abu-plugin', 'plugin.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { mcpServers: Record<string, unknown> };
  // Loopback, closed port: nothing leaves this computer.
  manifest.mcpServers = { 'shop-api': { url: 'http://127.0.0.1:9/mcp' } };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return dir;
}

async function showSidebar(page: Page): Promise<void> {
  const toggle = page.getByRole('button', { name: /^(显示侧栏|Show sidebar)$/ });
  if (await toggle.isVisible()) await toggle.click();
  await expect(page.getByTestId('app-switcher-trigger')).toBeVisible();
}

async function openPlugins(page: Page): Promise<void> {
  await showSidebar(page);
  await page.getByLabel('Main navigation').getByRole('button', { name: EXTENSIONS }).click();
  await page.getByRole('main').getByRole('button', { name: PLUGINS_TAB }).click();
}

const APP_CONFIRM: Wanted = { selector: '[data-testid="app-add-confirm"]' };

/** Opens the app market, adds the seeded market and presses 「使用」 on its app. */
async function useAppFromMarket(page: Page, marketDir: string): Promise<void> {
  await page.getByTestId('app-switcher-trigger').click();
  await page.getByTestId('app-switcher-discover').click();
  const market = page.getByTestId('app-market-dialog');
  await expect(market).toBeVisible({ timeout: READY_TIMEOUT });
  await market.getByTestId('app-market-add-market').click();
  await page.getByTestId('plugin-marketplace-dir-input').fill(marketDir);
  await page.getByTestId('plugin-marketplace-submit').click();
  const entry = market.locator(`[data-testid="app-market-entry"][data-app-id="${APP_ID}"]`);
  await expect(entry).toBeVisible({ timeout: READY_TIMEOUT });
  await watchFor(page, APP_CONFIRM);
  await entry.getByTestId('app-market-use').click();
}

test.describe('a pointer press that began before a confirming control could be read', () => {
  let dataRoot: ElectronDataRoot | undefined;
  let app: ElectronApplication | undefined;
  let mock: OpenAiMock | undefined;
  let page: Page;
  let marketDir: string;

  test.beforeEach(async () => {
    mock = await startOpenAiMock([
      {
        kind: 'tool-call',
        toolCallId: 'call-early-press-question',
        toolName: 'ask_user_question',
        arguments: {
          questions: [
            { header: '格式', question: '输出什么格式？', multiSelect: false, options: [{ label: '详细版' }, { label: '简洁版' }] },
            { header: '语言', question: '用什么语言？', multiSelect: false, options: [{ label: '中文版' }, { label: '英文版' }] },
          ],
        },
      },
      { kind: 'complete', responseText: CLOSING_REPLY },
    ]);
    dataRoot = createElectronDataRoot();
    fs.mkdirSync(dataRoot.rootDir, { recursive: true });
    marketDir = seedMarket(dataRoot.rootDir);
    app = (await launchAbuElectron(dataRoot)).app;
    page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForApp(page);
    await dismissFirstRunOverlays(page);
    await configureLocalMockProvider(page, mock.baseUrl, { supportsTools: true });
    await waitForApp(page);
  });

  test.afterEach(async () => {
    if (app) { await closeAbuElectron(app); app = undefined; }
    if (mock) { await mock.close(); mock = undefined; }
    if (dataRoot) { removeElectronDataRoot(dataRoot); dataRoot = undefined; }
  });

  test('the question dock: a question that has just arrived, and the page a double press turns to', async () => {
    const row = (label: string) => page.getByRole('button', { name: new RegExp(label) });
    const firstOption: Wanted = { selector: '[role="group"] button', text: '详细版' };
    const input = page.getByPlaceholder(CHAT_PLACEHOLDER);
    await input.fill('abu-e2e-early-press-question');
    await watchFor(page, firstOption);
    await input.press('Enter');

    // The dock arrives by itself: a press on an option before it could be read answers nothing.
    await pressEarly(page, firstOption);
    await expect(page.getByText('1 / 2', { exact: true })).toBeVisible();
    await expect(page.getByRole('group', { name: '输出什么格式？' })).toBeVisible();

    // A double press on an option answers that question only: the second press finds the first
    // option of the next question at the same spot.
    await settled(row('详细版'));
    const box = await row('详细版').boundingBox();
    if (!box) throw new Error('The option has no box');
    await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.getByText('2 / 2', { exact: true })).toBeVisible();
    await page.waitForTimeout(SETTLE_MS + 200);
    await expect(page.getByRole('group', { name: '用什么语言？' })).toBeVisible();
    expect(taskRequests(mock!)).toHaveLength(1);

    // The user's own press answers once.
    await pressWhenSettled(row('英文版'));
    await expect(page.getByText(CLOSING_REPLY, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    expect(taskRequests(mock!)).toHaveLength(2);
    const answer = JSON.stringify(taskRequests(mock!)[1].body);
    expect(answer).toContain('详细版');
    expect(answer).toContain('英文版');
  });

  test('the plugin install window: 「安装」 painted when the package has been read', async () => {
    await openPlugins(page);
    await page.getByTestId('plugin-create-trigger').click();
    await page.getByTestId('plugin-create-menu').getByRole('menuitem', { name: /^(添加市场|Add market)$/ }).click();
    await page.getByTestId('plugin-marketplace-dir-input').fill(marketDir);
    await page.getByTestId('plugin-marketplace-submit').click();
    const entry = page.getByTestId('plugin-marketplace-entry').filter({ hasText: PLUGIN_TITLE }).first();
    await expect(entry).toBeVisible({ timeout: READY_TIMEOUT });

    const wanted: Wanted = { selector: '[data-testid="plugin-install-confirm"]' };
    const confirm = page.getByTestId('plugin-install-confirm');
    await watchFor(page, wanted);
    await entry.getByText(/^(安装|Install)$/).first().click();
    await pressEarly(page, wanted);
    await page.waitForTimeout(SETTLE_MS + 200);
    await expect(page.getByTestId('plugin-install-disclosure')).toBeVisible();
    await expect(confirm).toHaveText(/^(安装|Install)$/);
    await expect(confirm).not.toHaveAttribute('aria-disabled', 'true');

    await pressWhenSettled(confirm);
    await expect(page.getByTestId('plugin-install-disclosure')).toBeHidden({ timeout: READY_TIMEOUT });
    await page.getByTestId('extensions-source-mine').click();
    await expect(page.getByTestId('plugin-mine-row').filter({ hasText: PLUGIN_TITLE })).toHaveCount(1, { timeout: READY_TIMEOUT });
  });

  test('the app confirmation inside the app market: 「确认」 painted when the plan has been read', async () => {
    await useAppFromMarket(page, marketDir);
    const dialog = page.getByTestId('app-add-dialog');
    const confirm = dialog.getByTestId('app-add-confirm');
    await pressEarly(page, APP_CONFIRM);
    await page.waitForTimeout(SETTLE_MS + 200);
    await expect(dialog.getByTestId('app-add-plugin')).toHaveAttribute('data-plugin', 'shop-assistant');
    await expect(confirm).toHaveText(/^(确认|Confirm)$/);
    await expect(page.getByTestId('app-switcher-current')).not.toHaveText(APP_NAME);

    await pressWhenSettled(confirm);
    await expect(page.getByTestId('app-switcher-current')).toHaveText(APP_NAME, { timeout: READY_TIMEOUT });
    await expect(page.getByTestId('app-market-dialog')).toBeHidden();
  });

  test('the app confirmation on the page: a scene whose plugin was uninstalled asks for it again', async () => {
    const dialog = page.getByTestId('app-add-dialog');
    const confirm = dialog.getByTestId('app-add-confirm');
    await useAppFromMarket(page, marketDir);
    await pressWhenSettled(confirm);
    await expect(page.getByTestId('app-switcher-current')).toHaveText(APP_NAME, { timeout: READY_TIMEOUT });

    await openPlugins(page);
    await page.getByTestId('extensions-source-mine').click();
    const mine = page.getByTestId('plugin-mine-row').filter({ hasText: PLUGIN_TITLE });
    await mine.getByRole('button', { name: /^(卸载|Uninstall): / }).click();
    await pressWhenSettled(page.getByRole('alertdialog').getByRole('button', { name: /^(卸载|Uninstall)$/ }));
    await expect(mine).toHaveCount(0, { timeout: READY_TIMEOUT });

    await page.getByLabel('Main navigation').getByRole('button', { name: NEW_TASK }).click();
    await page.getByTestId('app-home-mode-sourcing').click();
    await page.getByTestId('app-home-scene-shortlist').click();
    await watchFor(page, APP_CONFIRM);
    await page.getByTestId('app-home-template-compare').click();
    await pressEarly(page, APP_CONFIRM);
    await page.waitForTimeout(SETTLE_MS + 200);
    await expect(dialog.getByTestId('app-add-plugin')).toHaveAttribute('data-plugin', 'shop-assistant');
    await expect(confirm).toHaveText(/^(确认|Confirm)$/);

    await pressWhenSettled(confirm);
    await expect(dialog).toBeHidden({ timeout: READY_TIMEOUT });
    const composer = page.locator('[data-chat-composer]');
    await expect.poll(() => composer.evaluate((element) => element instanceof HTMLTextAreaElement ? element.value : element.textContent ?? '')).toMatch(/对比这三款候选商品/);
  });
});
