/**
 * Real-Electron acceptance: the preview panel follows the file on disk.
 *
 * A PDF, a Word document and a workbook that are rewritten while their preview is open show the
 * new content. A Word document and a text file that are removed say 「文件不存在: 文件名」 and show
 * their content again once the file is back. A TSV file is a table, and a file type with no
 * preview offers 「用本地应用打开」.
 *
 * The files live in a seeded sidebar project and are opened from its file tree, so no model is
 * asked anything. The host reports a change about two seconds after it happens; every wait here
 * is an assertion that retries.
 */
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import type { ElectronApplication, Locator, Page } from 'playwright';
import {
  closeAbuElectron,
  createElectronDataRoot,
  dismissFirstRunOverlays,
  launchAbuElectron,
  removeElectronDataRoot,
  type ElectronDataRoot,
} from './electronHelpers';
import { docxBytes, marker, pdfBytes, textBytes, tsvBytes, xlsxBytes } from './previewFixtures';
import { persistedStoreVersion } from './storeVersions';

const READY_TIMEOUT = 45_000;
const FOLLOW_TIMEOUT = 20_000;
const PROJECT_NAME = 'E2E预览项目';

test.describe.serial('preview panel and the file on disk', () => {
  let dataRoot: ElectronDataRoot;
  let app: ElectronApplication;
  let page: Page;
  let workspace: string;

  const file = (name: string) => path.join(workspace, name);
  const treeRow = (name: string) => page.getByRole('button', { name, exact: true }).first();
  /** The preview in view: the one tab panel that is not hidden. */
  const panel = (): Locator => page.locator('[role="tabpanel"]:not([hidden])');

  async function open(name: string) {
    await treeRow(name).click();
    await expect(panel().getByText(name, { exact: true }).first()).toBeVisible({ timeout: READY_TIMEOUT });
  }

  test.beforeAll(async () => {
    dataRoot = createElectronDataRoot();
    workspace = path.join(dataRoot.rootDir, 'preview-workspace');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(file('rewrite.pdf'), pdfBytes(1));
    fs.writeFileSync(file('rewrite.docx'), docxBytes(1));
    fs.writeFileSync(file('rewrite.xlsx'), xlsxBytes(1));
    fs.writeFileSync(file('remove.docx'), docxBytes(1));
    fs.writeFileSync(file('remove.txt'), textBytes(1));
    fs.writeFileSync(file('table.tsv'), tsvBytes(1));
    fs.writeFileSync(file('legacy.doc'), Buffer.from('not a Word document the preview reads'));

    const launched = await launchAbuElectron(dataRoot);
    app = launched.app;
    page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('[data-chat-composer]').first()).toBeVisible({ timeout: READY_TIMEOUT });
    // A sidebar project bound to the fixture folder: no native folder dialog.
    await page.evaluate(({ ws, name, version }) => {
      const at = 1_800_000_000_000;
      window.localStorage.setItem('abu-projects', JSON.stringify({
        state: { projects: { e2e: { id: 'e2e', name, workspacePath: ws, pinned: false, archived: false, createdAt: at, updatedAt: at, lastActiveAt: at } } },
        version,
      }));
    }, { ws: workspace, name: PROJECT_NAME, version: persistedStoreVersion('abu-projects') });
    await dismissFirstRunOverlays(page);

    await page.getByRole('button', { name: PROJECT_NAME, exact: true }).locator('xpath=..')
      .getByRole('button', { name: '项目文件', exact: true }).click();
    await expect(treeRow('rewrite.pdf')).toBeVisible({ timeout: READY_TIMEOUT });
  });

  test.afterAll(async () => {
    if (app) await closeAbuElectron(app);
    if (dataRoot) removeElectronDataRoot(dataRoot);
  });

  test('a PDF that is rewritten shows its new pages', async () => {
    await open('rewrite.pdf');
    await expect(panel()).toContainText(marker('PDF', 1), { timeout: READY_TIMEOUT });
    await expect(panel()).toContainText('第 1 / 1 页');

    fs.writeFileSync(file('rewrite.pdf'), pdfBytes(2));
    await expect(panel()).toContainText(marker('PDF', 2), { timeout: FOLLOW_TIMEOUT });
    await expect(panel()).toContainText('第 1 / 2 页');
    await expect(panel()).not.toContainText(marker('PDF', 1));
  });

  test('a Word document that is rewritten shows its new text', async () => {
    await open('rewrite.docx');
    await expect(panel()).toContainText(marker('DOCX', 1), { timeout: READY_TIMEOUT });

    fs.writeFileSync(file('rewrite.docx'), docxBytes(2));
    await expect(panel()).toContainText(marker('DOCX', 2), { timeout: FOLLOW_TIMEOUT });
    await expect(panel()).not.toContainText(marker('DOCX', 1));
  });

  test('a workbook that is rewritten shows its new cells', async () => {
    await open('rewrite.xlsx');
    await expect(panel().getByRole('cell', { name: marker('XLSX', 1), exact: true })).toBeVisible({ timeout: READY_TIMEOUT });

    fs.writeFileSync(file('rewrite.xlsx'), xlsxBytes(2));
    await expect(panel().getByRole('cell', { name: marker('XLSX', 2), exact: true })).toBeVisible({ timeout: FOLLOW_TIMEOUT });
    await expect(panel().getByRole('cell', { name: marker('XLSX', 1), exact: true })).toHaveCount(0);
  });

  test('a Word document that is removed says 文件不存在, and shows its text again once it is back', async () => {
    await open('remove.docx');
    await expect(panel()).toContainText(marker('DOCX', 1), { timeout: READY_TIMEOUT });

    fs.unlinkSync(file('remove.docx'));
    await expect(panel().getByRole('alert')).toHaveText('文件不存在: remove.docx', { timeout: FOLLOW_TIMEOUT });
    await expect(panel()).not.toContainText(marker('DOCX', 1));
    await expect(panel().getByRole('button', { name: '用 PowerPoint 打开' })).toHaveCount(0);

    fs.writeFileSync(file('remove.docx'), docxBytes(3));
    await expect(panel()).toContainText(marker('DOCX', 3), { timeout: FOLLOW_TIMEOUT });
    await expect(panel().getByRole('alert')).toHaveCount(0);
  });

  test('a text file that is removed says 文件不存在, and shows its text again once it is back', async () => {
    await open('remove.txt');
    await expect(panel()).toContainText(marker('TXT', 1), { timeout: READY_TIMEOUT });

    fs.unlinkSync(file('remove.txt'));
    await expect(panel().getByRole('alert')).toHaveText('文件不存在: remove.txt', { timeout: FOLLOW_TIMEOUT });
    await expect(panel()).not.toContainText(marker('TXT', 1));

    fs.writeFileSync(file('remove.txt'), textBytes(3));
    await expect(panel()).toContainText(marker('TXT', 3), { timeout: FOLLOW_TIMEOUT });
    await expect(panel().getByRole('alert')).toHaveCount(0);
  });

  test('a TSV file is a table split on tabs', async () => {
    await open('table.tsv');
    await expect(panel().getByRole('columnheader', { name: '姓名', exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(panel().getByRole('columnheader', { name: 'value', exact: true })).toBeVisible();
    await expect(panel().getByRole('cell', { name: marker('TSV', 1), exact: true })).toBeVisible();
    await expect(panel().getByRole('cell')).toHaveCount(2);
    await expect(panel()).not.toContainText('此文件类型暂不支持预览');
  });

  test('a .doc file has no preview and offers 用本地应用打开', async () => {
    await open('legacy.doc');
    await expect(panel()).toContainText('此文件类型暂不支持预览', { timeout: READY_TIMEOUT });
    // One in the toolbar, named by its label, and one beside 在文件管理器中显示 with its words on it.
    const openInApp = panel().getByRole('button', { name: '用本地应用打开', exact: true });
    await expect(openInApp).toHaveCount(2);
    await expect(openInApp.filter({ hasText: '用本地应用打开' })).toHaveCount(1);
    await expect(panel().getByRole('button', { name: '在文件管理器中显示', exact: true })).toBeVisible();
  });
});
