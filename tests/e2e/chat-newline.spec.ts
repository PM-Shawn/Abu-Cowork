/**
 * Real-Electron regression for composer newlines.
 *
 * Users reported "阿布的聊天框不能换行". Shift+Enter turned out to work; what
 * did not exist was any test proving it, in a shell where a stray global
 * keydown listener or an accelerator could silently take Enter away. jsdom
 * cannot cover this — a textarea's own newline insertion and the auto-grow
 * that makes it *visible* are real-browser behaviors — so it is pinned here,
 * against the actual Electron window.
 *
 * See tests/e2e/electronHelpers.ts for the launch story.
 */
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import {
  closeAbuElectron,
  createElectronDataRoot,
  launchAbuElectron,
  removeElectronDataRoot,
  type ElectronDataRoot,
} from './electronHelpers';

const READY_TIMEOUT = 45_000;
const CHAT_PLACEHOLDER = '想让阿布帮你做点什么？';
const QUICK_START_TITLE = '快速入门';

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;

/** Resolve the composer, with the fresh-profile quick-start guide dismissed. */
async function openComposer(page: Page) {
  await page.waitForLoadState('domcontentloaded');
  const input = page.getByPlaceholder(CHAT_PLACEHOLDER).first();
  await expect(input).toBeVisible({ timeout: READY_TIMEOUT });

  const quickStart = page.getByText(QUICK_START_TITLE, { exact: true });
  await quickStart.waitFor({ state: 'visible', timeout: 1_500 }).catch(() => {});
  if (await quickStart.isVisible()) {
    await page.keyboard.press('Escape');
    await expect(quickStart).toBeHidden();
  }

  await input.click();
  await input.fill('');
  return input;
}

const heightOf = (input: ReturnType<Page['getByPlaceholder']>) =>
  input.evaluate((el) => (el as HTMLTextAreaElement).clientHeight);


test.describe.serial('Composer newlines — real Electron', () => {
  test.beforeEach(async () => {
    const launched = await launchAbuElectron(createElectronDataRoot());
    app = launched.app;
    dataRoot = launched;
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

  test('shift-enter-inserts-a-newline', async () => {
    const page = await app!.firstWindow({ timeout: READY_TIMEOUT });
    const input = await openComposer(page);

    await page.keyboard.type('第一行');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('第二行');

    expect(await input.inputValue()).toBe('第一行\n第二行');
  });

  test('alt-enter-inserts-a-newline-without-reordering-what-follows', async () => {
    // The bug this pins: the newline used to be applied via React state with
    // the caret restored in a requestAnimationFrame. Characters typed before
    // that frame ran landed at the stale offset, so 第三行 came out as 三行第.
    const page = await app!.firstWindow({ timeout: READY_TIMEOUT });
    const input = await openComposer(page);

    await page.keyboard.type('第一行');
    await page.keyboard.press('Alt+Enter');
    await page.keyboard.type('第二行');

    expect(await input.inputValue()).toBe('第一行\n第二行');
  });

  test('composer-grows-as-lines-are-added', async () => {
    // A newline the box never grows to show reads to users as "no newline".
    const page = await app!.firstWindow({ timeout: READY_TIMEOUT });
    const input = await openComposer(page);

    await page.keyboard.type('行1');
    const singleLine = await heightOf(input);

    for (const line of ['行2', '行3', '行4']) {
      await page.keyboard.press('Shift+Enter');
      await page.keyboard.type(line);
    }

    expect(await input.inputValue()).toBe('行1\n行2\n行3\n行4');
    expect(await heightOf(input)).toBeGreaterThan(singleLine);
  });

  test('send-button-spells-out-both-shortcuts', async () => {
    // The composer itself stays free of standing hint text, so the button's
    // accessible name is the only place the shortcuts are written down.
    const page = await app!.firstWindow({ timeout: READY_TIMEOUT });
    await openComposer(page);
    await page.keyboard.type('你好');

    await expect(
      page.getByLabel('发送（Enter）· 换行（Shift + Enter）'),
    ).toBeVisible();
  });
});
