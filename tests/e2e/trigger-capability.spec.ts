/**
 * Real-Electron coverage for the user-owned trigger capability boundary.
 *
 * The model-facing manage_trigger tool cannot choose a capability level; this
 * journey proves that a person can choose it in the actual desktop shell and
 * that a later edit does not silently downgrade the saved value.
 */
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import type { ElectronApplication, Locator, Page } from 'playwright';
import {
  closeAbuElectron,
  launchAbuElectron,
  removeElectronDataRoot,
  REPO_ROOT,
  type ElectronDataRoot,
} from './electronHelpers';

const READY_TIMEOUT = 45_000;
const SCREENSHOT_PATH = path.join(REPO_ROOT, 'test-results', 'e2e-trigger-capability.png');
const EDITOR_SCREENSHOT_PATH = path.join(REPO_ROOT, 'test-results', 'e2e-trigger-capability-editor.png');

const CHAT_PLACEHOLDER = /^(想让阿布帮你做点什么？|What can Abu help you with\?)$/;
const QUICK_START = /^(快速入门|Quick Start)$/;
const AUTOMATION = /^(自动化|Automation)$/;
const TRIGGERS = /^(监听事件|Triggers)$/;
const NEW_TRIGGER = /^(新建监听|New Trigger)$/;
const EDIT_TRIGGER = /^(编辑监听|Edit Trigger)$/;
const EDIT = /^(编辑|Edit)$/;
const SAVE = /^(保存|Save)$/;
const AUTONOMY = /^(自主程度|Autonomy Level)$/;
const FULL = /^(完全放开|Fully open)$/;
/**
 * What the closed autonomy list shows. Left unanchored because the zh option
 * label carries a `（默认）` suffix the assertion has no reason to restate.
 */
const READ_ONLY = /只看不动|Read only/;

async function waitForApp(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER).first()).toBeVisible({ timeout: READY_TIMEOUT });

  const quickStart = page.getByText(QUICK_START, { exact: true });
  await quickStart.waitFor({ state: 'visible', timeout: 1_500 }).catch(() => {});
  if (await quickStart.isVisible()) {
    await page.keyboard.press('Escape');
    await expect(quickStart).toBeHidden();
  }
}

/** The editor window: a dialog named after what it does. */
function triggerEditor(page: Page): Locator {
  return page.getByRole('dialog', { name: NEW_TRIGGER }).or(page.getByRole('dialog', { name: EDIT_TRIGGER }));
}

/** The autonomy level: a list that is closed until it is asked for. */
function autonomyField(editor: Locator): Locator {
  return editor.getByRole('combobox', { name: AUTONOMY });
}

/**
 * The list the autonomy control has just opened.
 *
 * The list is drawn outside the editor window, above it, and while it is open
 * the window behind it is hidden from the accessibility tree. So the list is
 * resolved at page scope by its role, and the control is not asked anything
 * until the list has closed again. One list is open at a time.
 */
function openedList(page: Page): Locator {
  return page.getByRole('listbox');
}

async function persistedCapability(page: Page, triggerName: string): Promise<string | undefined> {
  return page.evaluate((name) => {
    const raw = window.localStorage.getItem('abu-triggers');
    if (!raw) throw new Error('abu-triggers was not persisted');
    const persisted = JSON.parse(raw) as {
      state?: {
        triggers?: Record<string, { name: string; action: { capability?: string } }>;
      };
    };
    const trigger = Object.values(persisted.state?.triggers ?? {}).find((candidate) => candidate.name === name);
    return trigger?.action.capability;
  }, triggerName);
}

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;

test.describe.serial('Trigger autonomy — real Electron', () => {
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

  test('selects full access, shows the risk, and preserves it through editing', async () => {
    const launched = await launchAbuElectron();
    app = launched.app;
    dataRoot = launched;

    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForApp(page);

    await page.getByRole('button', { name: AUTOMATION }).first().click();
    await page.getByRole('button', { name: TRIGGERS }).first().click();
    await page.getByRole('button', { name: NEW_TRIGGER }).click();

    let editor = triggerEditor(page);
    await expect(editor).toBeVisible();
    const autonomyTrigger = autonomyField(editor);
    await expect(autonomyTrigger).toBeVisible();
    await expect(autonomyTrigger).toHaveText(READ_ONLY);
    await autonomyTrigger.click();
    const autonomyList = openedList(page);
    await expect(autonomyList).toBeVisible();
    await autonomyList.getByRole('option', { name: FULL }).click();
    await expect(autonomyList).toBeHidden();
    await expect(autonomyTrigger).toHaveText(FULL);
    await expect(editor.getByText(/完全放开只适合可信输入源|trusted event sources only/)).toBeVisible();

    const triggerName = 'Electron capability E2E';
    await editor.getByPlaceholder(/例如：群消息告警处理|e\.g\., Group Alert Handler/).fill(triggerName);
    await editor.getByPlaceholder(/收到事件后阿布要执行的指令|Instructions for Abu when event is received/).fill('Summarize $EVENT_DATA');
    fs.mkdirSync(path.dirname(EDITOR_SCREENSHOT_PATH), { recursive: true });
    await page.screenshot({ path: EDITOR_SCREENSHOT_PATH });
    await editor.getByRole('button', { name: SAVE }).click();
    await expect(editor).toBeHidden();

    const detailCapability = page.getByText(AUTONOMY, { exact: true }).locator('..');
    await expect(detailCapability.getByText(FULL, { exact: true })).toBeVisible();
    expect(await persistedCapability(page, triggerName)).toBe('full');

    fs.mkdirSync(path.dirname(SCREENSHOT_PATH), { recursive: true });
    await page.screenshot({ path: SCREENSHOT_PATH });

    await page.getByRole('button', { name: EDIT }).click();
    editor = triggerEditor(page);
    await expect(editor).toBeVisible();
    await expect(autonomyField(editor)).toHaveText(FULL);
    await editor.getByRole('button', { name: SAVE }).click();
    await expect(editor).toBeHidden();

    expect(await persistedCapability(page, triggerName)).toBe('full');
  });
});
