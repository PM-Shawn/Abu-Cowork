import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import type { ElectronApplication, Page } from 'playwright';
import { TOAST_SETTLE_MS } from '../../src/components/ds/styles';
import {
  closeAbuElectron, createElectronDataRoot, dismissFirstRunOverlays, launchAbuElectron,
  removeElectronDataRoot, type ElectronDataRoot,
} from './electronHelpers';
import { CHAT_PLACEHOLDER, READY_TIMEOUT, waitForApp } from './openAiMock';

const repo = path.resolve(import.meta.dirname, '../..');
const sourceId = 'branch-reliability-source';
const sourceText = [
  { id: 'question', role: 'user', content: 'RELIABLE-QUESTION', timestamp: 1, loopId: 'turn', runState: 'completed' },
  { id: 'answer', role: 'assistant', content: 'RELIABLE-ANSWER', timestamp: 2, loopId: 'turn', streamEnded: true },
].map(message => JSON.stringify(message) + '\n').join('');
let app: ElectronApplication | undefined;
let data: ElectronDataRoot | undefined;
let root: string;
let control: string;

test.beforeEach(() => {
  test.skip(process.platform !== 'darwin', 'Uses macOS process suspension and directory modes.');
});
test.afterEach(async () => {
  if (root && fs.existsSync(root)) fs.chmodSync(root, 0o700);
  if (app) await closeAbuElectron(app);
  app = undefined;
  if (data) removeElectronDataRoot(data);
  data = undefined;
});

async function launch(): Promise<Page> {
  if (!data) throw new Error('Missing isolated data root');
  app = (await launchAbuElectron(data, {
    mainProcessPreload: path.join(repo, 'tests/e2e/branchNativeLifecycle.cjs'),
    extraEnv: { ABU_BRANCH_LIFECYCLE_CONTROL: control },
  })).app;
  const page = await app.firstWindow({ timeout: READY_TIMEOUT });
  page.on('console', event => {
    if (event.text().includes('[conversation-branch]')) console.log(event.text());
  });
  await waitForApp(page);
  await dismissFirstRunOverlays(page);
  expect(fs.existsSync(`${control}.ready`)).toBe(true);
  return page;
}

async function prepare(): Promise<Page> {
  data = createElectronDataRoot();
  control = path.join(data.rootDir, 'native-startup');
  let page = await launch();
  const appData = await page.evaluate(async () =>
    await window.__TAURI_INTERNALS__.invoke('plugin:path|resolve_directory', { directory: 14 }) as string);
  await closeAbuElectron(app!);
  app = undefined;
  root = path.join(appData, 'conversations');
  fs.mkdirSync(path.join(root, sourceId), { recursive: true });
  fs.writeFileSync(path.join(root, sourceId, 'messages.jsonl'), sourceText);
  fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify({ version: 1, entries: {
    [sourceId]: { id: sourceId, title: 'Reliability source', createdAt: 1, updatedAt: 2, messageCount: 2 },
  } }));
  page = await launch();
  const showSidebar = page.getByRole('button', { name: '显示侧栏', exact: true });
  if (await showSidebar.isVisible()) await showSidebar.click();
  await page.locator(`[data-conversation-row="${sourceId}"]`).click();
  await expect(page.getByText('RELIABLE-ANSWER', { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
  return page;
}

async function armStartup(): Promise<void> {
  await app!.evaluate((_electron, modulePath) => {
    const require = process.getBuiltinModule('module').createRequire(modulePath);
    require(modulePath).killNativeHelper('branch-lifecycle-acceptance');
  }, path.join(repo, 'electron/nativeHelperManager.cjs'));
  fs.rmSync(`${control}.status`, { force: true });
  fs.writeFileSync(control, 'pause');
}

async function heldPid(): Promise<number> {
  await expect.poll(() => fs.existsSync(`${control}.status`)).toBe(true);
  const status = JSON.parse(fs.readFileSync(`${control}.status`, 'utf8'));
  expect(status.state).toBe('paused');
  return status.pid;
}

async function resumeHelper(): Promise<void> {
  await app!.evaluate(() => {
    const resume = Reflect.get(globalThis, 'resumeBranchNativeHelper');
    if (typeof resume !== 'function') throw new Error('Missing native lifecycle controller');
    resume();
  });
}

function children(): Array<{ id: string }> {
  const index = JSON.parse(fs.readFileSync(path.join(root, 'index.json'), 'utf8'));
  return Object.values(index.entries).filter((entry) =>
    (entry as { branchOrigin?: { sourceConversationId: string } }).branchOrigin?.sourceConversationId === sourceId) as Array<{ id: string }>;
}

async function assertCreated(page: Page): Promise<string> {
  await expect(page.getByTestId('branch-origin')).toBeVisible({ timeout: READY_TIMEOUT });
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeEmpty();
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeFocused();
  await expect.poll(() => children().length).toBe(1);
  expect(fs.readFileSync(path.join(root, sourceId, 'messages.jsonl'), 'utf8')).toBe(sourceText);
  await expect(page.getByText('RELIABLE-ANSWER', { exact: true })).toBeVisible();
  return children()[0].id;
}

test('waits for a six-second real helper startup, reports progress and ignores repeated activation', async () => {
  const page = await prepare();
  await armStartup();
  const button = page.getByRole('button', { name: '分支到新聊天', exact: true });
  const start = performance.now();
  await button.click();
  await heldPid();
  await expect(page.getByRole('status')).toHaveText('正在创建新聊天…');
  await expect(button).toHaveAttribute('aria-disabled', 'true');
  for (let press = 0; press < 5; press += 1) await button.press('Enter');
  // Real time is intentional: the production deadline and the actual child process run together.
  await delay(6_000);
  expect(children()).toHaveLength(0);
  await expect(page.getByText('无法创建新聊天', { exact: true })).toHaveCount(0);
  await resumeHelper();
  await assertCreated(page);
  console.log(JSON.stringify({ scenario: 'delayed-startup', clickToReadyMs: performance.now() - start }));
});

test('shows a startup deadline failure and creates exactly one branch after an explicit retry', async () => {
  test.setTimeout(100_000);
  const page = await prepare();
  await page.getByPlaceholder(CHAT_PLACEHOLDER).fill('UNSENT-SOURCE-DRAFT');
  await armStartup();
  const start = performance.now();
  await page.getByRole('button', { name: '分支到新聊天', exact: true }).click();
  await heldPid();
  const notices = page.getByRole('region', { name: '通知', exact: true });
  await expect(notices.getByText('暂时无法创建新聊天，请重试', { exact: true })).toBeVisible({ timeout: 40_000 });
  expect(performance.now() - start).toBeGreaterThanOrEqual(29_000);
  await expect.poll(() => JSON.parse(fs.readFileSync(`${control}.status`, 'utf8')).state).toBe('exited');
  expect(children()).toHaveLength(0);
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toHaveValue('UNSENT-SOURCE-DRAFT');
  await notices.getByRole('button', { name: '重试', exact: true }).press('Enter');
  await assertCreated(page);
  await expect(notices.getByText('无法创建新聊天', { exact: true })).toHaveCount(0);
});

test('keeps the source and its draft through a real write denial and retry', async () => {
  const page = await prepare();
  await page.getByPlaceholder(CHAT_PLACEHOLDER).fill('UNSENT-SOURCE-DRAFT');
  fs.chmodSync(root, 0o500);
  await page.getByRole('button', { name: '分支到新聊天', exact: true }).click();
  const notices = page.getByRole('region', { name: '通知', exact: true });
  await expect(notices.getByText('暂时无法创建新聊天，请重试', { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
  expect(children()).toHaveLength(0);
  expect(fs.readFileSync(path.join(root, sourceId, 'messages.jsonl'), 'utf8')).toBe(sourceText);
  fs.chmodSync(root, 0o700);
  // Pointer activation waits for the notification's real entrance guard.
  await delay(TOAST_SETTLE_MS);
  await notices.getByRole('button', { name: '重试', exact: true }).click();
  await assertCreated(page);
  await page.getByRole('button', { name: '从聊天中继续', exact: true }).click();
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toHaveValue('UNSENT-SOURCE-DRAFT');
});

test('finishes in the sidebar while preserving a draft typed after navigating away', async () => {
  const page = await prepare();
  await armStartup();
  await page.getByRole('button', { name: '分支到新聊天', exact: true }).click();
  await heldPid();
  await page.getByRole('button', { name: '新任务', exact: true }).click();
  await page.getByPlaceholder(CHAT_PLACEHOLDER).fill('UNRELATED-DRAFT');
  await resumeHelper();
  await expect.poll(() => children().length).toBe(1);
  const row = page.locator(`[data-conversation-row="${children()[0].id}"]`);
  await expect(row).toBeVisible({ timeout: READY_TIMEOUT });
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toHaveValue('UNRELATED-DRAFT');
  await expect(page.getByTestId('branch-origin')).toHaveCount(0);
  await row.click();
  await assertCreated(page);
});

test('quitting during startup leaves the source usable after reopening', async () => {
  let page = await prepare();
  await armStartup();
  await page.getByRole('button', { name: '分支到新聊天', exact: true }).click();
  await heldPid();
  const closed = app!.waitForEvent('close', { timeout: 10_000 });
  await app!.evaluate(({ app: electronApp }) => { setTimeout(() => electronApp.quit(), 100); });
  await closed;
  app = undefined;
  await expect.poll(() => JSON.parse(fs.readFileSync(`${control}.status`, 'utf8')).state).toBe('exited');
  expect(fs.readFileSync(path.join(root, sourceId, 'messages.jsonl'), 'utf8')).toBe(sourceText);
  expect(children()).toHaveLength(0);
  page = await launch();
  await page.locator(`[data-conversation-row="${sourceId}"]`).click();
  await page.getByRole('button', { name: '分支到新聊天', exact: true }).click();
  await assertCreated(page);
});
