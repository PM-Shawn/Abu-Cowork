/**
 * Real-Electron acceptance for the preview of a kept copy: a file Abu wrote
 * is removed from its folder, and the files list of the conversation opens
 * the copy Abu kept. The preview says so, takes no typing and writes nothing
 * to the copy.
 *
 * A loopback model scripts the turn that writes the file. With
 * ABU_E2E_SCREENSHOT_DIR set, the read-only preview is saved there as a
 * picture, after the assertions that establish it.
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

const PROJECT_NAME = 'E2E 保留的副本';
const PROMPT = '请写一份会议纪要';
const FINAL_TEXT = '会议纪要写好了。';
const FILE_NAME = '会议纪要.md';
const FILE_CONTENT = '# 会议纪要\n\n下周三之前给出报价。\n';
const KEPT_COPY_NOTICE = '原文件已经不在，这是阿布保留的副本';
const REPLY_TIMEOUT = 60_000;
const RECORD_TIMEOUT = 30_000;
const AUTOSAVE_WAIT_MS = 2_500;
const SCREENSHOT_DIR = process.env.ABU_E2E_SCREENSHOT_DIR;

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

/** The copies of the file kept under a conversation's `outputs/files` folder. */
function keptCopies(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return keptCopies(entryPath);
    const folders = path.dirname(entryPath).split(path.sep);
    return entry.name === FILE_NAME && folders.at(-2) === 'files' && folders.at(-3) === 'outputs' ? [entryPath] : [];
  });
}

/** The tab panel in view. */
function panel(page: Page): Locator {
  return page.locator('[role="tabpanel"]:not([hidden])');
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SCREENSHOT_DIR) return;
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}.png`), animations: 'disabled' });
}

test('the kept copy of a file that is gone opens read-only, with a line that says what it is', async () => {
  test.setTimeout(300_000);
  const root = createElectronDataRoot();
  dataRoot = root;
  const workspace = path.join(root.rootDir, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const originalPath = path.join(workspace, FILE_NAME);
  const plans: MockReplyPlan[] = [
    { kind: 'tool-call', toolCallId: 'call-write-minutes', toolName: 'write_file', arguments: { path: originalPath, content: FILE_CONTENT } },
    { kind: 'tool-call', toolCallId: 'call-present-minutes', toolName: 'present_files', arguments: { files: [{ path: FILE_NAME }] } },
    { kind: 'complete', responseText: FINAL_TEXT },
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
          'project-kept-copy': {
            id: 'project-kept-copy', name, workspacePath, pinned: false, archived: false,
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
  await expect(composer).toBeVisible();
  await composer.fill(PROMPT);
  await composer.press('Enter');
  await expect(page.getByText(FINAL_TEXT)).toBeVisible({ timeout: REPLY_TIMEOUT });
  await expect(page.getByRole('button', { name: /^用时/ }).first()).toBeVisible({ timeout: REPLY_TIMEOUT });
  expect(fs.readFileSync(originalPath, 'utf8')).toBe(FILE_CONTENT);

  // The file at its own path opens as before: no line about a copy, and its history is offered.
  await expect(page.getByRole('tab', { name: FILE_NAME, exact: true })).toBeVisible();
  await expect(panel(page).getByRole('button', { name: '历史版本', exact: true })).toBeVisible();
  await expect(panel(page).getByText(KEPT_COPY_NOTICE)).toHaveCount(0);

  await expect.poll(() => keptCopies(root.rootDir), { timeout: RECORD_TIMEOUT }).toHaveLength(1);
  const [copyPath] = keptCopies(root.rootDir);
  expect(fs.readFileSync(copyPath, 'utf8')).toBe(FILE_CONTENT);

  // The file leaves its folder while the app is closed.
  await closeAbuElectron(app);
  fs.rmSync(originalPath);
  app = (await launchAbuElectron(root)).app;
  const reopened = await app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(reopened);
  // The side preview folded the sidebar away, and the project's tasks are folded after a restart.
  await reopened.getByRole('button', { name: '显示侧栏', exact: true }).click();
  await reopened.getByRole('group', { name: PROJECT_NAME })
    .getByRole('button', { name: PROJECT_NAME, exact: true })
    .click();
  await reopened.getByRole('button', { name: new RegExp(`^${PROMPT}`) }).click();
  await expect(reopened.getByText(FINAL_TEXT)).toBeVisible();

  // The files list of the task summary opens the copy.
  await panel(reopened).getByRole('button', { name: new RegExp(`^${FILE_NAME.replace('.', '\\.')}`) }).click();
  await expect(reopened.getByRole('tab', { name: FILE_NAME, exact: true })).toHaveAttribute('aria-selected', 'true');
  const preview = panel(reopened);
  await expect(preview.getByRole('status').filter({ hasText: KEPT_COPY_NOTICE })).toBeVisible();
  await expect(preview.getByRole('heading', { name: '会议纪要', exact: true })).toBeVisible();
  await expect(preview.getByRole('button', { name: '历史版本', exact: true })).toHaveCount(0);
  await expect(preview.getByText('已保存', { exact: true })).toHaveCount(0);
  await shot(reopened, 'kept-copy-read-only');

  // The source view shows the text and takes no typing.
  await preview.getByRole('button', { name: '源码', exact: true }).click();
  const source = preview.locator('.cm-content');
  await expect(source).toContainText('下周三之前给出报价。');
  await expect(source).toHaveAttribute('contenteditable', 'false');
  await expect(preview.getByRole('status').filter({ hasText: KEPT_COPY_NOTICE })).toBeVisible();
  await source.click();
  await reopened.keyboard.type('这一行不应当被写入');
  await reopened.waitForTimeout(AUTOSAVE_WAIT_MS);
  await expect(source).not.toContainText('这一行不应当被写入');
  expect(fs.readFileSync(copyPath, 'utf8')).toBe(FILE_CONTENT);
  expect(fs.existsSync(originalPath)).toBe(false);
});
