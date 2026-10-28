/**
 * Real-Electron acceptance for the order of the sidebar lists: the tasks outside
 * any project sit under 「任务」, and both that list and a project's list put the
 * task the user last wrote in first, whenever it was created. The order is the
 * one written to disk, so it survives a restart.
 *
 * Deterministic per TESTING.md: the replies come from a loopback mock model.
 * Completed replies share one sentence; held requests exercise concurrent
 * tasks and their stop state through the real conversation runner.
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import {
  REPO_ROOT,
  closeAbuElectron,
  configureLocalMockProvider,
  createElectronDataRoot,
  launchAbuElectron,
  removeElectronDataRoot,
  type ElectronDataRoot,
} from './electronHelpers';
import { CHAT_PLACEHOLDER, READY_TIMEOUT, startOpenAiMock, taskRequests, waitForApp, type OpenAiMock } from './openAiMock';

const PROJECT_NAME = '季度报告';
const PROJECT_FIRST = '整理一月销售数据';
const PROJECT_SECOND = '整理二月销售数据';
const TASK_FIRST = '周末出行计划';
const TASK_SECOND = '读书笔记整理';
const REPLY = '已经处理完成';
const SCREENSHOT_DIR = path.join(REPO_ROOT, '.agent', 'sidebar-task-order');

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;
let mock: OpenAiMock | undefined;

test.afterEach(async () => {
  if (app) await closeAbuElectron(app);
  app = undefined;
  if (mock) await mock.close();
  mock = undefined;
  if (dataRoot) removeElectronDataRoot(dataRoot);
  dataRoot = undefined;
});

/** Send a message and wait for its reply, the `replies`-th of the conversation in view. */
async function sendTurn(page: Page, text: string, replies: number): Promise<void> {
  const input = page.getByPlaceholder(CHAT_PLACEHOLDER);
  await input.fill(text);
  await input.press('Enter');
  await expect(page.getByText(REPLY, { exact: true })).toHaveCount(replies, { timeout: READY_TIMEOUT });
}

/** The first message of a task started on the new-task page hides the sidebar. */
async function showSidebar(page: Page): Promise<void> {
  const show = page.getByRole('button', { name: '显示侧栏', exact: true });
  if (await show.count()) await show.click();
}

const row = (page: Page, title: string) => page.locator('[data-conversation-row]').filter({ hasText: title });

/** Titles of the sidebar's conversation rows, top to bottom. */
const rowTitles = (page: Page) => page.locator('[data-conversation-row]').allInnerTexts();

async function expectAbove(page: Page, upper: string, lower: string): Promise<void> {
  await expect(async () => {
    const titles = await rowTitles(page);
    const at = (title: string) => titles.findIndex((text) => text.includes(title));
    expect(at(upper)).toBeGreaterThanOrEqual(0);
    expect(at(lower)).toBeGreaterThan(at(upper));
  }).toPass({ timeout: READY_TIMEOUT });
}

const shot = (page: Page, name: string) => page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}.png`) });

async function expectStableWhileAnotherTaskRuns(page: Page, running: string, latest: string, requests: number): Promise<void> {
  await row(page, running).click();
  const input = page.getByPlaceholder(CHAT_PLACEHOLDER);
  await input.fill('继续核对，等待我停止');
  await input.press('Enter');
  await expect.poll(() => taskRequests(mock!).length, { timeout: READY_TIMEOUT }).toBe(requests);
  await expect(page.getByLabel(/^(停止|Stop)$/)).toBeVisible();
  await expectAbove(page, running, latest);

  await row(page, latest).click();
  await sendTurn(page, '补充一条新的要求', 2);
  await expectAbove(page, latest, running);
  await row(page, running).click();
  const stop = page.getByLabel(/^(停止|Stop)$/);
  await expect(stop).toBeVisible();
  await stop.click();
  await expect(stop).toBeHidden({ timeout: READY_TIMEOUT });
  await expectAbove(page, latest, running);
}

test('the task the user last wrote in comes first, in 「任务」 and in a project, and stays first after a restart', async () => {
  test.setTimeout(300_000);
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  mock = await startOpenAiMock([
    ...Array.from({ length: 6 }, () => ({ kind: 'complete' as const, responseText: REPLY })),
    { kind: 'hold-open', partialText: '继续处理中' },
    { kind: 'complete', responseText: REPLY },
    { kind: 'hold-open', partialText: '继续处理中' },
    { kind: 'complete', responseText: REPLY },
  ]);
  dataRoot = createElectronDataRoot();
  const workspace = path.join(dataRoot.appDataDir, 'Home', 'order-workspace');
  fs.mkdirSync(workspace, { recursive: true });
  app = (await launchAbuElectron(dataRoot)).app;
  let page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(page);
  // A sidebar project bound to the fixture workspace: no native folder dialog.
  await page.evaluate(({ ws, name }) => {
    const at = 1_700_000_000_000;
    window.localStorage.setItem('abu-projects', JSON.stringify({
      state: { projects: { e2e: { id: 'e2e', name, workspacePath: ws, pinned: false, archived: false, createdAt: at, updatedAt: at, lastActiveAt: at } } },
      version: 1,
    }));
  }, { ws: workspace, name: PROJECT_NAME });
  await configureLocalMockProvider(page, mock.baseUrl);

  // ---- Two tasks in the project, then two outside it --------------------------
  const projectRow = page.getByRole('button', { name: PROJECT_NAME, exact: true });
  for (const title of [PROJECT_FIRST, PROJECT_SECOND]) {
    await showSidebar(page);
    await projectRow.hover();
    await projectRow.locator('xpath=..').getByRole('button', { name: '新任务', exact: true }).click();
    await sendTurn(page, title, 1);
  }
  for (const title of [TASK_FIRST, TASK_SECOND]) {
    await showSidebar(page);
    await page.getByLabel('Main navigation').getByRole('button', { name: '新任务', exact: true }).click();
    await sendTurn(page, title, 1);
  }
  await showSidebar(page);

  await expect(page.getByRole('button', { name: '任务', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '最近', exact: true })).toHaveCount(0);
  await expectAbove(page, PROJECT_SECOND, PROJECT_FIRST);
  await expectAbove(page, TASK_SECOND, TASK_FIRST);
  // Project tasks are listed in their project only.
  await expect(row(page, PROJECT_FIRST)).toHaveCount(1);
  for (const item of [projectRow, row(page, PROJECT_FIRST), row(page, TASK_FIRST)]) {
    await expect(item).toHaveCSS('font-size', '14px');
    await expect(item).toHaveCSS('line-height', '20px');
    await expect(item).toHaveCSS('height', '30px');
  }
  await shot(page, '1-created');

  // ---- Writing in the older task moves it up, in both lists -------------------
  await row(page, TASK_FIRST).click();
  await sendTurn(page, '再补充一下预算', 2);
  await expectAbove(page, TASK_FIRST, TASK_SECOND);

  await row(page, PROJECT_FIRST).click();
  await sendTurn(page, '再核对一下退货', 2);
  await expectAbove(page, PROJECT_FIRST, PROJECT_SECOND);
  await shot(page, '2-after-writing');

  await expectStableWhileAnotherTaskRuns(page, TASK_FIRST, TASK_SECOND, 7);
  await expectStableWhileAnotherTaskRuns(page, PROJECT_FIRST, PROJECT_SECOND, 9);
  await shot(page, '3-after-status-changes');

  // ---- The order is read back from disk after a restart -----------------------
  await closeAbuElectron(app);
  app = (await launchAbuElectron(dataRoot)).app;
  page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(page);
  await showSidebar(page);
  const restartedProjectRow = page.getByRole('button', { name: PROJECT_NAME, exact: true });
  if (await row(page, PROJECT_FIRST).count() === 0) await restartedProjectRow.click();
  await expectAbove(page, TASK_SECOND, TASK_FIRST);
  await expectAbove(page, PROJECT_SECOND, PROJECT_FIRST);
  await shot(page, '4-after-restart');

  for (const title of [TASK_FIRST, PROJECT_FIRST]) {
    await row(page, title).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
    const nameField = page.getByRole('textbox', { name: '重命名', exact: true });
    await expect(nameField).toHaveCSS('font-size', '14px');
    await expect(nameField).toHaveCSS('line-height', '20px');
    await nameField.press('Escape');
    await expect(nameField).toHaveCount(0);
  }
});
