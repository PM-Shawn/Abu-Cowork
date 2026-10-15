/**
 * Real-Electron acceptance for the record of kept copies, which the renderer
 * and the sidecar both read and write. The renderer reads the record first
 * (a file of the first turn is gone, so its row falls back to the record);
 * the sidecar then keeps a copy of a file the second turn writes; that file
 * leaves its folder too. In the same launch, the files list opens the copy of
 * the second file.
 *
 * A loopback model scripts both turns.
 */
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import type { ElectronApplication, Locator, Page } from 'playwright';
import {
  closeAbuElectron,
  configureLocalMockProvider,
  createElectronDataRoot,
  dismissFirstRunOverlays,
  launchAbuElectron,
  removeElectronDataRoot,
  type ElectronDataRoot,
} from './electronHelpers';
import {
  CHAT_PLACEHOLDER,
  READY_TIMEOUT,
  startOpenAiMock,
  waitForApp,
  type MockReplyPlan,
} from './openAiMock';
import { persistedStoreVersion } from './storeVersions';

const PROJECT_NAME = 'E2E 两份记录';
const FIRST_PROMPT = '请写一份会议纪要';
const FIRST_TEXT = '会议纪要写好了。';
const FIRST_FILE = '会议纪要.md';
const SECOND_PROMPT = '再写一份报价单';
const SECOND_TEXT = '报价单写好了。';
const SECOND_FILE = '报价单.md';
const SECOND_CONTENT = '# 报价单\n\n合计一万二千元。\n';
const KEPT_COPY_NOTICE = '原文件已经不在，这是阿布保留的副本';
const REPLY_TIMEOUT = 60_000;
const RECORD_TIMEOUT = 30_000;

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;
let mock: { close: () => Promise<void> } | undefined;

test.afterEach(async () => {
  if (app) await closeAbuElectron(app);
  app = undefined;
  if (mock) await mock.close();
  mock = undefined;
  if (dataRoot) removeElectronDataRoot(dataRoot);
  dataRoot = undefined;
});

/** The copies of `fileName` kept under a conversation's `outputs/files` folder. */
function keptCopies(dir: string, fileName: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return keptCopies(entryPath, fileName);
    const folders = path.dirname(entryPath).split(path.sep);
    return entry.name === fileName && folders.at(-2) === 'files' && folders.at(-3) === 'outputs' ? [entryPath] : [];
  });
}

/** The tab panel in view. */
function panel(page: Page): Locator {
  return page.locator('[role="tabpanel"]:not([hidden])');
}

function fileRow(page: Page, fileName: string): Locator {
  return panel(page).getByRole('button', { name: new RegExp(`^${fileName.replace('.', '\\.')}`) });
}

async function openTask(page: Page, prompt: string): Promise<void> {
  await page.getByRole('group', { name: PROJECT_NAME })
    .getByRole('button', { name: PROJECT_NAME, exact: true })
    .click();
  await page.getByRole('button', { name: new RegExp(`^${prompt}`) }).click();
}

test('a copy the sidecar keeps after the renderer has read the record opens in the same launch', async () => {
  test.setTimeout(300_000);
  const root = createElectronDataRoot();
  dataRoot = root;
  const workspace = path.join(root.rootDir, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const firstPath = path.join(workspace, FIRST_FILE);
  const secondPath = path.join(workspace, SECOND_FILE);
  const plans: MockReplyPlan[] = [
    { kind: 'tool-call', toolCallId: 'call-write-minutes', toolName: 'write_file', arguments: { path: firstPath, content: '# 会议纪要\n' } },
    { kind: 'tool-call', toolCallId: 'call-present-minutes', toolName: 'present_files', arguments: { files: [{ path: FIRST_FILE }] } },
    { kind: 'complete', responseText: FIRST_TEXT },
    { kind: 'tool-call', toolCallId: 'call-write-quote', toolName: 'write_file', arguments: { path: secondPath, content: SECOND_CONTENT } },
    { kind: 'tool-call', toolCallId: 'call-present-quote', toolName: 'present_files', arguments: { files: [{ path: SECOND_FILE }] } },
    { kind: 'complete', responseText: SECOND_TEXT },
    // The conversation summary the app asks for after a second turn.
    { kind: 'complete', responseText: '摘要' },
  ];
  const startedMock = await startOpenAiMock(plans);
  mock = startedMock;

  app = (await launchAbuElectron(root)).app;
  const page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(page);
  await page.evaluate(({ name, workspacePath, version }) => {
    window.localStorage.setItem('abu-projects', JSON.stringify({
      state: {
        projects: {
          'project-two-records': {
            id: 'project-two-records', name, workspacePath, pinned: false, archived: false,
            createdAt: 1_800_000_000_000, updatedAt: 1_800_000_000_000, lastActiveAt: 1_800_000_000_000,
          },
        },
      },
      version,
    }));
  }, { name: PROJECT_NAME, workspacePath: workspace, version: persistedStoreVersion('abu-projects') });
  await dismissFirstRunOverlays(page);
  await configureLocalMockProvider(page, startedMock.baseUrl, { supportsTools: true, permissionMode: 'standard' });

  await page.getByRole('button', { name: PROJECT_NAME, exact: true })
    .locator('xpath=..')
    .getByRole('button', { name: '新任务', exact: true })
    .click();
  const composer = page.getByPlaceholder(CHAT_PLACEHOLDER);
  await composer.fill(FIRST_PROMPT);
  await composer.press('Enter');
  await expect(page.getByText(FIRST_TEXT)).toBeVisible({ timeout: REPLY_TIMEOUT });
  await expect(page.getByRole('button', { name: /^用时/ }).first()).toBeVisible({ timeout: REPLY_TIMEOUT });
  await expect.poll(() => keptCopies(root.rootDir, FIRST_FILE), { timeout: RECORD_TIMEOUT }).toHaveLength(1);

  // The first file leaves its folder while the app is closed.
  await closeAbuElectron(app);
  fs.rmSync(firstPath);
  app = (await launchAbuElectron(root)).app;
  const reopened = await app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(reopened);
  await reopened.getByRole('button', { name: '显示侧栏', exact: true }).click();
  await openTask(reopened, FIRST_PROMPT);
  await expect(reopened.getByText(FIRST_TEXT)).toBeVisible();

  // The renderer reads the record here: the first file's row falls back to its copy.
  await fileRow(reopened, FIRST_FILE).click();
  await expect(panel(reopened).getByRole('status').filter({ hasText: KEPT_COPY_NOTICE })).toBeVisible();

  // The second turn runs in the sidecar, which keeps a copy of the second file.
  const reopenedComposer = reopened.getByPlaceholder(CHAT_PLACEHOLDER);
  await reopenedComposer.fill(SECOND_PROMPT);
  await reopenedComposer.press('Enter');
  await expect(reopened.getByText(SECOND_TEXT)).toBeVisible({ timeout: REPLY_TIMEOUT });
  await expect.poll(() => keptCopies(root.rootDir, SECOND_FILE), { timeout: RECORD_TIMEOUT }).toHaveLength(1);

  // The second file leaves its folder while the app runs; the task is opened again.
  fs.rmSync(secondPath);
  await reopened.getByRole('button', { name: '显示侧栏', exact: true }).click();
  await reopened.getByRole('group', { name: PROJECT_NAME })
    .getByRole('button', { name: '新任务', exact: true })
    .click();
  await expect(reopened.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible();
  await reopened.getByRole('button', { name: new RegExp(`^${FIRST_PROMPT}`) }).click();
  await expect(reopened.getByText(SECOND_TEXT)).toBeVisible();

  // The second turn opened its file in a preview tab; the files list is on the summary tab.
  await reopened.getByRole('tab', { name: '任务摘要', exact: true }).click();
  await fileRow(reopened, SECOND_FILE).click();
  const preview = panel(reopened);
  await expect(preview.getByRole('status').filter({ hasText: KEPT_COPY_NOTICE })).toBeVisible();
  await expect(preview.getByRole('heading', { name: '报价单', exact: true })).toBeVisible();
  expect(fs.existsSync(secondPath)).toBe(false);
});
