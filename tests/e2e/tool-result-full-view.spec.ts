/**
 * Real-Electron acceptance for seeing a step's whole result in the work
 * process: a long result folds to its first and last lines with a button that
 * shows all of it, a result Abu read only partly says where and how much it
 * left out, a long error folds the same way, and all of it holds while the turn
 * runs and after a restart.
 *
 * A loopback model scripts each turn; the commands run for real in a project
 * folder inside the test's own data root. With ABU_E2E_SCREENSHOT_DIR set, the
 * folded and unfolded states are saved there for review.
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

const PROJECT_NAME = 'E2E 工具结果';
const PROMPT = '请运行命令';
const FINAL_TEXT = '命令都运行完了。';
const REPLY_TIMEOUT = 60_000;
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

function commandCall(id: string, command: string): MockReplyPlan {
  return { kind: 'tool-call', toolCallId: id, toolName: 'run_command', arguments: { command } };
}

function finalReply(): MockReplyPlan {
  return { kind: 'complete', responseText: FINAL_TEXT };
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SCREENSHOT_DIR) return;
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}.png`), animations: 'disabled' });
}

/** Launch the app with a project whose folder is `workspace` and a new task open in it. */
async function launchInProject(
  plansFor: (workspace: string) => MockReplyPlan[],
  seed: (workspace: string) => void = () => {},
): Promise<Page> {
  const root = createElectronDataRoot();
  dataRoot = root;
  const workspace = path.join(root.rootDir, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  seed(workspace);
  const startedMock = await startOpenAiMock(plansFor(workspace));
  mock = startedMock;

  app = (await launchAbuElectron(root)).app;
  const page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(page);
  await page.evaluate(({ name, workspacePath, version }) => {
    window.localStorage.setItem('abu-projects', JSON.stringify({
      state: {
        projects: {
          'project-results': {
            id: 'project-results', name, workspacePath, pinned: false, archived: false,
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
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible();
  return page;
}

async function send(page: Page): Promise<void> {
  const composer = page.getByPlaceholder(CHAT_PLACEHOLDER);
  await composer.fill(PROMPT);
  await composer.press('Enter');
}

/** Send the prompt and wait until the turn has ended: the reply is there and the work process has folded. */
async function runTurn(page: Page): Promise<void> {
  await send(page);
  await expect(page.getByText(FINAL_TEXT)).toBeVisible({ timeout: REPLY_TIMEOUT });
  await expect(page.getByRole('button', { name: /^用时/ }).last()).toBeVisible({ timeout: REPLY_TIMEOUT });
}

/** Unfold a group of steps; it folds by itself once the reply starts after it. */
async function openGroup(page: Page): Promise<void> {
  const group = page.getByRole('button', { name: /^(修改了|执行了|调用了)/ }).first();
  await expect(group).toBeVisible();
  if ((await group.getAttribute('aria-expanded')) === 'false') await group.click();
}

/** Unfold the finished turn's work process and its group of steps. */
async function showSteps(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^用时/ }).first().click();
  await openGroup(page);
}

/**
 * Wait until `target` has stopped moving. Opening the work process or a group
 * of steps animates the boxes around the rows, and the conversation scrolls
 * along with it.
 */
async function waitUntilAtRest(target: Locator): Promise<void> {
  await expect.poll(() => target.evaluate((element) => document.getAnimations()
    .filter((animation) => (animation.effect as KeyframeEffect | null)?.target?.contains(element))
    .length)).toBe(0);
}

/** The content column of the step whose label is `label`. */
function stepRow(page: Page, label: string): Locator {
  return page.getByText(label, { exact: true }).locator('xpath=..');
}

/** Open the step's result (or error) block and return the area that shows it. */
async function openBlock(row: Locator, name: '结果' | '错误'): Promise<Locator> {
  await waitUntilAtRest(row);
  const chip = row.getByRole('button', { name, exact: true });
  if ((await chip.getAttribute('aria-expanded')) === 'false') await chip.click();
  const area = row.locator('[data-tool-result]');
  await expect(area).toBeVisible();
  return area;
}

async function shownLines(area: Locator): Promise<string[]> {
  return area.evaluate((element) => (element.textContent ?? '').split('\n'));
}

async function reopenConversation(): Promise<Page> {
  await closeAbuElectron(app!);
  app = (await launchAbuElectron(dataRoot!)).app;
  const reopened = await app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(reopened);
  const project = reopened.getByRole('group', { name: PROJECT_NAME })
    .getByRole('button', { name: PROJECT_NAME, exact: true });
  const showSidebar = reopened.getByRole('button', { name: '显示侧栏', exact: true });
  // The sidebar comes back open or folded, depending on how the last run left it.
  await expect(project.or(showSidebar)).toBeVisible();
  if (await showSidebar.isVisible()) await showSidebar.click();
  await project.click();
  await reopened.getByRole('button', { name: new RegExp(`^${PROMPT}`) }).click();
  await expect(reopened.getByText(FINAL_TEXT)).toBeVisible();
  return reopened;
}

test('a long result folds to its first and last lines and shows all of it, a short one shows whole, also after a restart', async () => {
  test.setTimeout(240_000);
  const page = await launchInProject(() => [
    commandCall('call-sixty', 'seq 1 60'),
    commandCall('call-short', 'echo hi'),
    finalReply(),
  ]);
  await runTurn(page);
  await showSteps(page);

  const long = await openBlock(stepRow(page, '执行 seq 1 60'), '结果');
  const showAll = long.getByRole('button', { name: '显示全部 63 行', exact: true });
  await expect(showAll).toBeVisible();
  expect(await shownLines(long)).not.toContain('30');
  await shot(page, '01-folded');
  await showAll.click();
  expect(await shownLines(long)).toContain('30');
  await expect(showAll).toHaveCount(0);
  await shot(page, '02-all');

  const short = await openBlock(stepRow(page, '执行 echo hi'), '结果');
  await expect(short).toContainText('hi');
  await expect(short.getByRole('button', { name: /^显示全部/ })).toHaveCount(0);

  const reopened = await reopenConversation();
  await showSteps(reopened);
  const afterRestart = await openBlock(stepRow(reopened, '执行 seq 1 60'), '结果');
  await afterRestart.getByRole('button', { name: '显示全部 63 行', exact: true }).click();
  expect(await shownLines(afterRestart)).toContain('30');
  await shot(reopened, '03-all-after-restart');
});

test('one long line folds by characters and shows all of it', async () => {
  test.setTimeout(180_000);
  const page = await launchInProject(() => [
    commandCall('call-line', "head -c 3000 /dev/zero | tr '\\0' a"),
    finalReply(),
  ]);
  await runTurn(page);
  await showSteps(page);

  const area = await openBlock(stepRow(page, "执行 head -c 3000 /dev/ze..."), '结果');
  const showAll = area.getByRole('button', { name: /^显示全部 \d+ 个字符$/ });
  await expect(showAll).toBeVisible();
  await shot(page, '04-chars-folded');
  await showAll.click();
  await expect(area).toContainText('a'.repeat(3000));
});

test('where Abu read only the start and end of a long output, the result says how many lines it left out', async () => {
  test.setTimeout(180_000);
  const page = await launchInProject(() => [
    commandCall('call-many', 'seq 1 5000'),
    finalReply(),
  ]);
  await runTurn(page);
  await showSteps(page);

  const area = await openBlock(stepRow(page, '执行 seq 1 5000'), '结果');
  await area.getByRole('button', { name: '显示全部 180 行', exact: true }).click();
  // "stdout:", 5000 numbers, a blank line and "exit code: 0" make 5003 lines; Abu kept 150 + 30.
  await expect(area.getByText('内容过长，阿布没有读取中间的 4823 行', { exact: true })).toBeVisible();
  expect(await shownLines(area)).toContain('4999');
  await expect(area).not.toContainText('omitted');
  await shot(page, '05-lines-not-read');
});

test('a long error folds and shows all of it', async () => {
  test.setTimeout(180_000);
  const longLine = '目'.repeat(3000);
  const page = await launchInProject((workspace) => [
    {
      kind: 'tool-call', toolCallId: 'call-edit', toolName: 'edit_file',
      arguments: { path: path.join(workspace, 'notes.md'), old_content: `${'目'.repeat(2999)}标`, new_content: '新内容' },
    },
    finalReply(),
  ], (workspace) => fs.writeFileSync(path.join(workspace, 'notes.md'), `标题\n${longLine}\n`));
  await runTurn(page);
  await showSteps(page);

  const area = await openBlock(stepRow(page, '修改 notes.md'), '错误');
  const showAll = area.getByRole('button', { name: /^显示全部 \d+ 个字符$/ });
  await expect(showAll).toBeVisible();
  await shot(page, '06-error-folded');
  await showAll.click();
  await expect(area).toContainText(longLine);
});

test('a finished step shows all of its result while the turn is still running', async () => {
  test.setTimeout(180_000);
  const page = await launchInProject(() => [
    commandCall('call-sixty', 'seq 1 60'),
    { kind: 'hold-open', partialText: '正在整理结果' },
  ]);
  await send(page);
  await expect(page.getByText('正在整理结果')).toBeVisible({ timeout: REPLY_TIMEOUT });
  await openGroup(page);

  const area = await openBlock(stepRow(page, '执行 seq 1 60'), '结果');
  await area.getByRole('button', { name: '显示全部 63 行', exact: true }).click();
  expect(await shownLines(area)).toContain('30');
  await shot(page, '07-all-while-running');
});
