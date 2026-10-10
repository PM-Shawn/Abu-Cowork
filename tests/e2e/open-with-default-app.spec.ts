/**
 * Opening a file with its default application, in the real shell.
 *
 * The main process decides which local paths reach `shell.openPath`
 * (electron/openPathPolicy.cjs). Its own tests walk the rules; what they cannot
 * reach is the path a request really takes: the renderer's bridge, the
 * `tauri:invoke` channel, the desktop host's dispatch, and the file card that
 * reads the answer. This launches the actual app with the system opener
 * replaced by a recorder, so nothing is opened on the machine running it.
 */
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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
import { CHAT_PLACEHOLDER, READY_TIMEOUT, startOpenAiMock, waitForApp, type OpenAiMock } from './openAiMock';

const REFUSAL = 'open-refused:runs-by-default';
const SYMLINKS = process.platform !== 'win32';

interface OpenerRecord { opened: string[]; revealed: string[]; external: string[] }

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;
let mock: OpenAiMock | undefined;

/** Replaces only the calls that leave the app; the dispatch and the policy in front of them stay real. */
async function recordSystemOpener(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ shell }) => {
    const record: OpenerRecord = { opened: [], revealed: [], external: [] };
    (globalThis as typeof globalThis & { openerRecord?: OpenerRecord }).openerRecord = record;
    shell.openPath = async (target) => { record.opened.push(target); return ''; };
    shell.showItemInFolder = (target) => { record.revealed.push(target); };
    shell.openExternal = async (url) => { record.external.push(url); };
  });
}

function openerRecord(electronApp: ElectronApplication): Promise<OpenerRecord> {
  return electronApp.evaluate(() => (globalThis as typeof globalThis & { openerRecord: OpenerRecord }).openerRecord);
}

/** Sends one command over the renderer's bridge and returns `'ok'` or the rejection's message. */
function invokeFromPage(page: Page, command: string, args: Record<string, unknown>): Promise<string> {
  return page.evaluate(async ([cmd, payload]) => {
    const internals = (window as unknown as {
      __TAURI_INTERNALS__?: { invoke(cmd: string, args: unknown): Promise<unknown> };
    }).__TAURI_INTERNALS__;
    if (!internals) throw new Error('the preload exposed no invoke bridge');
    return internals.invoke(cmd, payload).then(() => 'ok', (error: unknown) => (error instanceof Error ? error.message : String(error)));
  }, [command, args] as const);
}

function makeFixtures(root: ElectronDataRoot) {
  const dir = path.join(root.appDataDir, 'open-fixtures');
  fs.mkdirSync(dir, { recursive: true });
  const notes = path.join(dir, 'notes.txt');
  const script = path.join(dir, 'setup.command');
  const linked = path.join(dir, 'report.pdf');
  const python = path.join(dir, 'job.py');
  fs.writeFileSync(notes, 'notes\n');
  fs.writeFileSync(script, 'exit 0\n');
  fs.writeFileSync(python, 'pass\n');
  if (SYMLINKS) fs.symlinkSync(script, linked);
  return { dir: fs.realpathSync(dir), notes, script, linked, python };
}

/** The file card that shows this file name. */
function fileCard(page: Page, fileName: string): Locator {
  return page.locator('div', { has: page.getByTitle(fileName, { exact: true }) }).last();
}

test.describe('open with the default application', () => {
  test.afterEach(async () => {
    if (app) {
      await closeAbuElectron(app);
      app = undefined;
    }
    if (mock) {
      await mock.close();
      mock = undefined;
    }
    if (dataRoot) {
      removeElectronDataRoot(dataRoot);
      dataRoot = undefined;
    }
  });

  test('the main process opens a document and refuses a file the system would run', async () => {
    dataRoot = createElectronDataRoot();
    const launched = await launchAbuElectron(dataRoot);
    app = launched.app;
    await recordSystemOpener(app);
    const files = makeFixtures(dataRoot);
    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await page.waitForLoadState('domcontentloaded');

    expect(await invokeFromPage(page, 'plugin:opener|open_path', { path: files.notes })).toBe('ok');
    expect(await invokeFromPage(page, 'plugin:opener|open_path', { path: files.dir })).toBe('ok');

    expect(await invokeFromPage(page, 'plugin:opener|open_path', { path: files.script })).toContain(REFUSAL);
    expect(await invokeFromPage(page, 'plugin:shell|open', { path: files.script })).toContain(REFUSAL);
    expect(await invokeFromPage(page, 'plugin:shell|open', { path: pathToFileURL(files.script).href })).toContain(REFUSAL);
    expect(await invokeFromPage(page, 'plugin:opener|open_url', { url: pathToFileURL(files.script).href })).toContain(REFUSAL);
    if (SYMLINKS) {
      expect(await invokeFromPage(page, 'plugin:opener|open_path', { path: files.linked })).toContain(REFUSAL);
    }

    expect(await invokeFromPage(page, 'plugin:opener|open_url', { url: 'https://example.com/setup.command' })).toBe('ok');

    expect(await openerRecord(app)).toEqual({
      opened: [path.join(files.dir, 'notes.txt'), files.dir],
      revealed: [],
      external: ['https://example.com/setup.command'],
    });
  });

  test('a file card opens a document and only shows a file the system would run in the file manager', async () => {
    dataRoot = createElectronDataRoot();
    const files = makeFixtures(dataRoot);
    const mentioned = [files.notes, files.script, files.python, ...(SYMLINKS ? [files.linked] : [])];
    mock = await startOpenAiMock([{ kind: 'complete', responseText: mentioned.map((file) => `文件位置: \`${file}\``).join('\n\n') }]);
    const launched = await launchAbuElectron(dataRoot);
    app = launched.app;
    await recordSystemOpener(app);
    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForApp(page);
    await dismissFirstRunOverlays(page);
    await configureLocalMockProvider(page, mock.baseUrl);

    const input = page.getByPlaceholder(CHAT_PLACEHOLDER);
    await expect(input).toBeEditable({ timeout: READY_TIMEOUT });
    await input.fill('列出刚才的文件');
    await input.press('Enter');

    const notesCard = fileCard(page, 'notes.txt');
    await expect(notesCard).toBeVisible({ timeout: READY_TIMEOUT });
    await notesCard.getByRole('button', { name: '打开', exact: true }).click();
    await expect.poll(async () => (await openerRecord(app!)).opened).toEqual([path.join(files.dir, 'notes.txt')]);

    const scriptCard = fileCard(page, 'setup.command');
    await expect(scriptCard.getByRole('button', { name: '打开', exact: true })).toHaveCount(0);
    await scriptCard.getByRole('button', { name: '在文件管理器中显示', exact: true }).click();
    await expect.poll(async () => (await openerRecord(app!)).revealed).toEqual([files.script]);

    if (SYMLINKS) {
      const linkedCard = fileCard(page, 'report.pdf');
      await linkedCard.getByRole('button', { name: '用 预览 打开', exact: true }).click();
      await expect(linkedCard.getByRole('button', { name: '在文件管理器中显示', exact: true })).toBeVisible();
      await expect(linkedCard.getByRole('button', { name: '用 预览 打开', exact: true })).toHaveCount(0);
      const notices = page.getByRole('region', { name: '通知' });
      await expect(notices.getByText('无法打开文件', { exact: true })).toBeVisible();
      await expect(notices.getByText('无法用本地应用打开该文件', { exact: true })).toBeVisible();
    }

    // The preview toolbar: a script the system would run has no open-in-app button, a document has one.
    const openInApp = page.getByRole('button', { name: '用本地应用打开', exact: true });
    await fileCard(page, 'job.py').getByTitle('点击预览', { exact: true }).click();
    await expect(page.getByRole('button', { name: '历史版本', exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(openInApp).toHaveCount(0);
    await notesCard.getByTitle('点击预览', { exact: true }).click();
    await expect(openInApp).toBeVisible({ timeout: READY_TIMEOUT });

    expect((await openerRecord(app)).opened).toEqual([path.join(files.dir, 'notes.txt')]);
  });
});
