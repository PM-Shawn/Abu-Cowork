import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import type { ElectronApplication, Page } from 'playwright';
import {
  closeAbuElectron,
  launchAbuElectron,
  removeElectronDataRoot,
  REPO_ROOT,
  type ElectronDataRoot,
} from './electronHelpers';

const READY_TIMEOUT = 45_000;
const SCREENSHOT_PATH = path.join(REPO_ROOT, 'test-results', 'e2e-capabilities.png');
const COMPUTER_SETUP_SCREENSHOT_PATH = path.join(
  REPO_ROOT,
  'test-results',
  'e2e-computer-use-setup.png',
);

const WELCOME = /交给阿布就行啦|Leave it to Abu/;
const CHAT_PLACEHOLDER = /^(想让阿布帮你做点什么？|What can Abu help you with\?)$/;
const ACCOUNT = /^(我|Me)$/;
const SETTINGS = /^(设置|Settings)$/;
const CAPABILITIES = /^(能力|Capabilities)$/;
const BUILTIN_BROWSER = /^(阿布内置浏览器|Abu built-in browser)$/;
const MY_CHROME = /^(我的 Chrome|My Chrome)$/;
const COMPUTER_USE = /^(电脑操控|Computer Use)$/;
const READY = /^(已就绪|Ready)$/;
const NOT_CONNECTED = /^(未连接 · 可选|Not connected · Optional)$/;
const OFF = /^(已关闭|Off)$/;
const START_SETUP = /^(开始设置|Start setup)$/;
const ENABLE = /^(开启|Enable)$/;
const CONNECT_CHROME = /^(连接 Chrome|Connect Chrome)$/;
const CHROME_SETUP = /^(连接我的 Chrome|Connect My Chrome)$/;
const BACK_TO_CAPABILITIES = /^(返回能力|Back to Capabilities)$/;
const COMPUTER_SETUP = /^(开启电脑操控|Enable Computer Use)$/;
const QUICK_START = /^(快速入门|Quick Start)$/;

async function waitForWelcomeScreen(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await expect(
    page.getByText(WELCOME).or(page.getByPlaceholder(CHAT_PLACEHOLDER)).first(),
  ).toBeVisible({ timeout: READY_TIMEOUT });

  const quickStart = page.getByText(QUICK_START, { exact: true });
  await quickStart.waitFor({ state: 'visible', timeout: 1_500 }).catch(() => {});
  if (await quickStart.isVisible()) {
    await page.keyboard.press('Escape');
    await expect(quickStart).toBeHidden();
  }
}

function capabilityCard(page: Page, title: RegExp) {
  return page.locator('div.rounded-lg.border').filter({
    has: page.getByText(title, { exact: true }),
  }).first();
}

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;

test.describe.serial('Electron capability overview', () => {
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

  test('shows real runtime readiness and keeps optional capabilities explicit', async () => {
    const launched = await launchAbuElectron();
    app = launched.app;
    dataRoot = launched;

    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForWelcomeScreen(page);

    await page.getByRole('button', { name: ACCOUNT }).click();
    await page.getByRole('menuitem', { name: SETTINGS }).click();
    await page.getByRole('button', { name: CAPABILITIES }).click();

    const builtinBrowser = capabilityCard(page, BUILTIN_BROWSER);
    const myChrome = capabilityCard(page, MY_CHROME);
    const computerUse = capabilityCard(page, COMPUTER_USE);

    await expect(builtinBrowser.getByText(READY)).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(myChrome.getByText(NOT_CONNECTED)).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(computerUse.getByText(OFF)).toBeVisible({ timeout: READY_TIMEOUT });

    await expect(myChrome).toContainText(/existing tabs|现有标签页|已有标签页/);
    await expect(computerUse.getByRole('button', { name: START_SETUP })).toBeVisible();

    // Let the previous navigation item's color transition finish so the visual
    // artifact reflects the stable selected state.
    await page.waitForTimeout(250);
    fs.mkdirSync(path.dirname(SCREENSHOT_PATH), { recursive: true });
    await page.screenshot({ path: SCREENSHOT_PATH });

    // Entering setup is side-effect free: installation and OS permission
    // prompts only start from explicit buttons inside each guide. Abu's
    // first-party local bridge is already prepared in the background.
    await myChrome.getByRole('button', { name: CONNECT_CHROME }).click();
    await expect(page.getByText(CHROME_SETUP, { exact: true })).toBeVisible();
    await expect(page.getByText(/local extension|本地扩展/)).toBeVisible();
    await expect(page.getByText(/Chrome Web Store|Chrome 应用商店/)).toBeVisible();
    const chromeCheckButton = page.getByRole('button', {
      name: /^(检查连接|Check connection)$/,
    });
    await expect(chromeCheckButton).toBeEnabled({ timeout: READY_TIMEOUT });
    await expect(chromeCheckButton.locator('.animate-spin')).toHaveCount(0);
    await page.waitForTimeout(2_500);
    await expect(chromeCheckButton.locator('.animate-spin')).toHaveCount(0);
    await page.getByRole('button', { name: BACK_TO_CAPABILITIES }).click();

    await computerUse.getByRole('button', { name: START_SETUP }).click();
    await expect(page.getByText(COMPUTER_SETUP, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: ENABLE })).toBeVisible();
    await expect(page.getByText(/current task needs|当前任务需要/)).toHaveCount(0);
    await page.getByRole('button', { name: ENABLE }).click();
    await expect(page.getByText(/View screen|查看屏幕/, { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/Control interface|操作界面/, { exact: true }).first()).toBeVisible();

    const computerCheckButton = page.getByRole('button', {
      name: /^(重新检查|Check again)$/,
    });
    if (await computerCheckButton.isVisible()) {
      await expect(computerCheckButton).toBeEnabled({ timeout: READY_TIMEOUT });
      await expect(computerCheckButton.locator('.animate-spin')).toHaveCount(0);
      await page.waitForTimeout(2_500);
      await expect(computerCheckButton.locator('.animate-spin')).toHaveCount(0);
    }
    await page.screenshot({ path: COMPUTER_SETUP_SCREENSHOT_PATH });
  });

  test('rejects a direct privileged Computer Use IPC call without a task token', async () => {
    const launched = await launchAbuElectron();
    app = launched.app;
    dataRoot = launched;

    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForWelcomeScreen(page);

    const result = await page.evaluate(async () => {
      try {
        const tauri = (
          globalThis as typeof globalThis & {
            __TAURI_INTERNALS__?: {
              invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
            };
          }
        ).__TAURI_INTERNALS__;
        if (!tauri) return { error: 'Tauri bridge unavailable' };
        await tauri.invoke('capture_screen', {});
        return { error: null };
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });

    expect(result.error).toMatch(
      /(?:requires an authorization token|authorization token is required)/i,
    );
  });

  // RB-04, in the real shell. The 30-step cap used to live only in the
  // renderer, where `setComputerUseActive(true, …)` zeroed it at the top of
  // every computer batch — so a multi-batch task never reached it. The
  // budget now rides on the host task lease, and this drives the real main
  // process over that lease to prove the cap holds outside unit tests.
  //
  // Deliberately asserts on WHICH error comes back rather than on success:
  // the budget is consumed before target resolution and the OS permission
  // probe, so the outcome is the same whether or not this machine has
  // screen-recording permission — no environment dependency, and that
  // ordering is itself part of what makes the cap unskippable.
  test('enforces the Computer Use step budget in the main process, across batches', async () => {
    const launched = await launchAbuElectron();
    app = launched.app;
    dataRoot = launched;

    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForWelcomeScreen(page);

    const errors = await page.evaluate(async () => {
      const tauri = (
        globalThis as typeof globalThis & {
          __TAURI_INTERNALS__?: {
            invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
          };
        }
      ).__TAURI_INTERNALS__;
      if (!tauri) return ['Tauri bridge unavailable'];

      await tauri.invoke('computer_use_set_enabled', { enabled: true });

      const collected: string[] = [];
      // 31 actions spread over what the renderer would treat as many
      // separate batches — same conversation and loop, i.e. one task.
      for (let i = 0; i < 31; i++) {
        try {
          await tauri.invoke('computer_use_begin_session', {
            conversationId: 'e2ecuconv',
            loopId: 'e2eculoop',
            toolCallId: `e2ecutool${i}`,
            interactionMode: 'foreground',
            scope: 'screen-read',
            permissionMode: 'standard',
            actionIntent: { action: 'screenshot', category: 'none', summary: '' },
          });
          collected.push('');
        } catch (error) {
          collected.push(error instanceof Error ? error.message : String(error));
        }
      }
      return collected;
    });

    expect(errors).toHaveLength(31);
    // None of the first 30 may be refused for budget — that is the exact
    // regression: a per-batch reset would let this run forever.
    for (const [index, message] of errors.slice(0, 30).entries()) {
      expect(message, `step ${index + 1}`).not.toMatch(/step limit/i);
    }
    expect(errors[30]).toMatch(/30-step limit/i);
  });
});
