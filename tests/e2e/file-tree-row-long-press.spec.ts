/**
 * Real-Electron acceptance: a touch held on a row of the project file tree opens the row menu of
 * that row, also after another row was right-clicked. 删除 chosen there asks about that file, and
 * 重命名 chosen there renames that file on the disk. A touch held on a line that is no row opens
 * nothing.
 *
 * The touch is Chromium's own touch input (`Input.dispatchTouchEvent`): the page gets real touch
 * pointer events and waits the real 700 ms. No touch screen is involved.
 *
 * The tree is opened from a seeded sidebar project, so no model is asked anything.
 */
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from 'playwright';
import {
  closeAbuElectron,
  createElectronDataRoot,
  dismissFirstRunOverlays,
  launchAbuElectron,
  removeElectronDataRoot,
  type LaunchedApp,
} from './electronHelpers';
import { persistedStoreVersion } from './storeVersions';

const READY_TIMEOUT = 45_000;
const LONG_PRESS_MS = 700;
const PROJECT_NAME = 'E2E长按项目';
const FIRST_FILE = 'e2e-first.md';
const SECOND_FILE = 'e2e-second.md';
const RENAMED_FILE = 'e2e-renamed.md';
const EMPTY_FOLDER = 'e2e-empty';

/** A touch that goes down on the row's name and stays down. */
async function touchAndHold(page: Page, row: Locator) {
  const box = await row.boundingBox();
  if (!box) throw new Error('The row has no box on the page');
  const session = await page.context().newCDPSession(page);
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }],
  });
  return () => session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

test('a touch held on a file row opens the menu of that file after another file was right-clicked; 删除 asks about it and 重命名 renames it', async () => {
  test.setTimeout(180_000);
  const dataRoot = createElectronDataRoot();
  const workspace = path.join(dataRoot.rootDir, 'long-press-workspace');
  fs.mkdirSync(path.join(workspace, EMPTY_FOLDER), { recursive: true });
  fs.writeFileSync(path.join(workspace, FIRST_FILE), 'first\n');
  fs.writeFileSync(path.join(workspace, SECOND_FILE), 'second\n');
  let launched: LaunchedApp | undefined;
  try {
    launched = await launchAbuElectron(dataRoot);
    const page = await launched.app.firstWindow();
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

    const firstRow = page.getByRole('button', { name: FIRST_FILE, exact: true });
    const secondRow = page.getByRole('button', { name: SECOND_FILE, exact: true });
    const menu = page.getByRole('menu');
    await expect(firstRow).toHaveCount(1);
    await expect(secondRow).toHaveCount(1);

    await firstRow.click({ button: 'right' });
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);

    let release = await touchAndHold(page, secondRow);
    await expect(menu).toBeVisible();
    await expect(menu).toHaveCount(1);
    await release();
    await menu.getByRole('menuitem', { name: '删除', exact: true }).click();

    const question = page.getByRole('alertdialog');
    await expect(question).toContainText(SECOND_FILE);
    await expect(question).not.toContainText(FIRST_FILE);
    await question.getByRole('button', { name: '取消', exact: true }).click();
    await expect(question).toHaveCount(0);
    expect(fs.readdirSync(workspace).sort()).toEqual([EMPTY_FOLDER, FIRST_FILE, SECOND_FILE]);

    await firstRow.click({ button: 'right' });
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);

    release = await touchAndHold(page, secondRow);
    await expect(menu).toBeVisible();
    await release();
    await menu.getByRole('menuitem', { name: '重命名', exact: true }).click();

    const field = page.locator('input:focus');
    await expect(field).toHaveValue(SECOND_FILE);
    await field.fill(RENAMED_FILE);
    await field.press('Enter');

    await expect(page.getByRole('button', { name: RENAMED_FILE, exact: true })).toHaveCount(1);
    await expect(firstRow).toHaveCount(1);
    expect(fs.readdirSync(workspace).sort()).toEqual([EMPTY_FOLDER, FIRST_FILE, RENAMED_FILE]);
    expect(fs.readFileSync(path.join(workspace, RENAMED_FILE), 'utf8')).toBe('second\n');

    // A touch held on an open folder's 空文件夹 line, which is no row, opens nothing.
    await page.getByRole('button', { name: EMPTY_FOLDER, exact: true }).click();
    const hint = page.getByText('空文件夹', { exact: true });
    await expect(hint).toBeVisible();
    // The page records what the touch went down on: a touch near a button can be given to it.
    await page.evaluate(() => {
      document.addEventListener('pointerdown', (event) => {
        if (event.pointerType === 'touch') document.body.dataset.e2eTouchedText = (event.target as HTMLElement).textContent ?? '';
      }, true);
    });
    release = await touchAndHold(page, hint);
    await expect(page.locator('body')).toHaveAttribute('data-e2e-touched-text', '空文件夹');
    // Nothing happens when the menu stays closed, so the clock is all there is to wait for.
    await page.waitForTimeout(LONG_PRESS_MS * 2);
    await expect(menu).toHaveCount(0);
    await release();
  } finally {
    if (launched) await closeAbuElectron(launched.app);
    removeElectronDataRoot(dataRoot);
  }
});
