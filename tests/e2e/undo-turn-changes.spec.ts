/**
 * Real-Electron acceptance for undoing the file changes of one turn and
 * putting them back: the button on the card under the reply, the question
 * that lists what will be restored and what will not, the card of an undone
 * turn, and the line on top of the changes tab.
 *
 * A loopback model scripts each turn with file tools and commands. Every case
 * runs in a project whose folder sits in the test's own data root, and reads
 * the files on disk after the undo or the put-back. With
 * ABU_E2E_SCREENSHOT_DIR set, the states named in the cases are saved there
 * as pictures, each after the assertions that establish the state.
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
  pressWhenSettled,
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

const PROJECT_NAME = 'E2E 撤销改动';
const PROMPT = '请修改方案';
const FINAL_TEXT = '已经改好了。';
const REPLY_TIMEOUT = 60_000;
const RECORD_TIMEOUT = 30_000;
const SCREENSHOT_DIR = process.env.ABU_E2E_SCREENSHOT_DIR;

const PLAN_BEFORE = [
  '# 方案', '', '第一行', '第二行', '第三行', '目标甲', '目标乙', '目标丙', '第七行', '第八行', '第九行', '',
].join('\n');
const PLAN_GOALS_BEFORE = '目标甲\n目标乙\n目标丙';
const PLAN_GOALS_AFTER = '目标一\n目标二\n目标三';
const PLAN_AFTER = PLAN_BEFORE.replace(PLAN_GOALS_BEFORE, PLAN_GOALS_AFTER);
const BUDGET_BEFORE = '# 预算\n\n合计 100\n';
const BUDGET_AFTER = '# 预算\n\n合计 120\n备注 已复核\n';
const OUTLINE = '一、背景\n二、目标\n';
const DRAFT = '草稿一\n草稿二\n草稿三\n';

const UNDO_QUESTION = '撤销这一轮的文件改动？';
const REAPPLY_QUESTION = '把这一轮的改动放回来？';

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

function writeFileCall(id: string, filePath: string, content: string): MockReplyPlan {
  return { kind: 'tool-call', toolCallId: id, toolName: 'write_file', arguments: { path: filePath, content } };
}

function editFileCall(id: string, filePath: string, oldContent: string, newContent: string): MockReplyPlan {
  return {
    kind: 'tool-call', toolCallId: id, toolName: 'edit_file',
    arguments: { path: filePath, old_content: oldContent, new_content: newContent },
  };
}

function deleteFileCall(id: string, filePath: string): MockReplyPlan {
  return { kind: 'tool-call', toolCallId: id, toolName: 'delete_file', arguments: { path: filePath } };
}

function commandCall(id: string, command: string): MockReplyPlan {
  return { kind: 'tool-call', toolCallId: id, toolName: 'run_command', arguments: { command } };
}

function finalReply(): MockReplyPlan {
  return { kind: 'complete', responseText: FINAL_TEXT };
}

/** A turn that edits 方案.md and 预算.md and creates 提纲.md. */
function twoEditsAndOneNewFile(folder: string): MockReplyPlan[] {
  return [
    editFileCall('call-edit-plan', path.join(folder, '方案.md'), PLAN_GOALS_BEFORE, PLAN_GOALS_AFTER),
    editFileCall('call-edit-budget', path.join(folder, '预算.md'), '合计 100', '合计 120\n备注 已复核'),
    writeFileCall('call-write-outline', path.join(folder, '提纲.md'), OUTLINE),
    finalReply(),
  ];
}

function seedPlanAndBudget(folder: string): void {
  fs.writeFileSync(path.join(folder, '方案.md'), PLAN_BEFORE);
  fs.writeFileSync(path.join(folder, '预算.md'), BUDGET_BEFORE);
}

/** A turn that edits 方案.md, creates 提纲.md and deletes 草稿.md. */
function editCreateAndDelete(folder: string): MockReplyPlan[] {
  return [
    editFileCall('call-edit-plan', path.join(folder, '方案.md'), PLAN_GOALS_BEFORE, PLAN_GOALS_AFTER),
    writeFileCall('call-write-outline', path.join(folder, '提纲.md'), OUTLINE),
    deleteFileCall('call-delete-draft', path.join(folder, '草稿.md')),
    finalReply(),
  ];
}

function seedPlanAndDraft(folder: string): void {
  fs.writeFileSync(path.join(folder, '方案.md'), PLAN_BEFORE);
  fs.writeFileSync(path.join(folder, '草稿.md'), DRAFT);
}

/**
 * Launch the app with a project whose folder is `workspace`, the loopback
 * model answering with `plans` in order, and a new task open in that project.
 */
async function launchInProject(
  plansFor: (workspace: string) => MockReplyPlan[],
  seed: (workspace: string) => void,
): Promise<{ page: Page; workspace: string }> {
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
          'project-undo': {
            id: 'project-undo', name, workspacePath, pinned: false, archived: false,
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
  return { page, workspace };
}

/** Send the prompt and wait until its turn has ended and the card of its changed files is there. */
async function runTurn(page: Page): Promise<Locator> {
  const composer = page.getByPlaceholder(CHAT_PLACEHOLDER);
  await composer.fill(PROMPT);
  await composer.press('Enter');
  await expect(page.getByText(FINAL_TEXT)).toBeVisible({ timeout: REPLY_TIMEOUT });
  await expect(page.getByRole('button', { name: /^用时/ }).last()).toBeVisible({ timeout: REPLY_TIMEOUT });
  const card = page.getByTestId('changed-files-card');
  await expect(card).toHaveCount(1, { timeout: RECORD_TIMEOUT });
  return card;
}

function undoButton(card: Locator): Locator {
  return card.getByRole('button', { name: '撤销', exact: true });
}

function reapplyButton(card: Locator): Locator {
  return card.getByRole('button', { name: '放回改动', exact: true });
}

function willLines(dialog: Locator): Locator {
  return dialog.getByTestId('turn-undo-will').getByRole('listitem');
}

function notices(page: Page): Locator {
  return page.getByRole('region', { name: '通知' }).getByRole('listitem');
}

/** The tab panel in view. */
function panel(page: Page): Locator {
  return page.locator('[role="tabpanel"]:not([hidden])');
}

function read(workspace: string, name: string): string {
  return fs.readFileSync(path.join(workspace, name), 'utf8');
}

function has(workspace: string, name: string): boolean {
  return fs.existsSync(path.join(workspace, name));
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SCREENSHOT_DIR) return;
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}.png`), animations: 'disabled' });
}

/** Open the question from the card, answer it with its confirming button, and wait until it has gone. */
async function confirmFromCard(page: Page, opener: Locator, question: string, confirmLabel: string): Promise<void> {
  await opener.click();
  const dialog = page.getByRole('alertdialog', { name: question });
  await pressWhenSettled(dialog.getByRole('button', { name: confirmLabel, exact: true }));
  await expect(dialog).toHaveCount(0);
}

/** The `changes` folders of the conversations in the test's data root. */
function changesDirs(): string[] {
  return fs.readdirSync(dataRoot!.rootDir, { recursive: true, encoding: 'utf8' })
    .filter((entry) => path.basename(entry) === 'changes' && fs.existsSync(path.join(dataRoot!.rootDir, entry, 'index.json')))
    .map((entry) => path.join(dataRoot!.rootDir, entry));
}

/** The one turn of the conversation that has an undo record: its folder in the conversation's `changes` folder. */
function onlyTurnDir(): { changes: string; loopId: string } {
  const [changes] = changesDirs();
  const turns = fs.readdirSync(changes).filter((name) => fs.existsSync(path.join(changes, name, 'undo.json')));
  expect(turns).toHaveLength(1);
  return { changes, loopId: turns[0] };
}

/** Restarts the app and opens the conversation again; `whileClosed` runs between the two. */
async function reopenConversation(whileClosed?: () => void): Promise<Page> {
  await closeAbuElectron(app!);
  whileClosed?.();
  app = (await launchAbuElectron(dataRoot!)).app;
  const reopened = await app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(reopened);
  // The right panel folded the sidebar away, and the project's tasks are folded after a restart.
  await reopened.getByRole('button', { name: '显示侧栏', exact: true }).click();
  await reopened.getByRole('group', { name: PROJECT_NAME })
    .getByRole('button', { name: PROJECT_NAME, exact: true })
    .click();
  await reopened.getByRole('button', { name: new RegExp(`^${PROMPT}`) }).click();
  await expect(reopened.getByText(FINAL_TEXT)).toBeVisible();
  return reopened;
}

test.describe('story 1: putting the files of a turn back to how they were', () => {
  test('undoing a turn that edited two files and created one restores both, moves the new file to the trash and says so on the card', async () => {
    test.setTimeout(200_000);
    const { page, workspace } = await launchInProject(twoEditsAndOneNewFile, seedPlanAndBudget);
    const posix = process.platform !== 'win32';
    if (posix) fs.chmodSync(path.join(workspace, '方案.md'), 0o640);
    const card = await runTurn(page);
    expect(read(workspace, '方案.md')).toBe(PLAN_AFTER);
    expect(read(workspace, '预算.md')).toBe(BUDGET_AFTER);
    expect(read(workspace, '提纲.md')).toBe(OUTLINE);

    await expect(card.getByRole('button', { name: /^已编辑 3 个文件/ })).toBeVisible();
    await expect(undoButton(card)).toBeVisible();
    await expect(undoButton(card)).not.toHaveAttribute('aria-disabled', 'true');
    await expect(reapplyButton(card)).toHaveCount(0);
    await shot(page, '01-card-with-undo');

    await undoButton(card).click();
    const dialog = page.getByRole('alertdialog', { name: UNDO_QUESTION });
    await expect(dialog).toContainText('3 个文件会恢复到这一轮开始之前');
    await expect(willLines(dialog)).toHaveText(['提纲.md移到废纸篓', '方案.md恢复为修改前的内容', '预算.md恢复为修改前的内容']);
    await expect(dialog.getByTestId('turn-undo-wont')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
    await pressWhenSettled(dialog.getByRole('button', { name: '撤销', exact: true }));

    await expect(card.getByRole('button', { name: /^已撤销 3 个文件的改动/ })).toBeVisible();
    expect(read(workspace, '方案.md')).toBe(PLAN_BEFORE);
    expect(read(workspace, '预算.md')).toBe(BUDGET_BEFORE);
    expect(has(workspace, '提纲.md')).toBe(false);
    // The restored file is a new file on disk that took the old one's place, with its permissions.
    if (posix) expect(fs.statSync(path.join(workspace, '方案.md')).mode & 0o777).toBe(0o640);
    expect(fs.readdirSync(workspace).filter((name) => name.includes('.tmp.'))).toEqual([]);
    await expect(reapplyButton(card)).toBeVisible();
    await expect(undoButton(card)).toHaveCount(0);
    // The rows stay, none of them marked, and nothing failed, so there is no notice.
    await expect(card.getByRole('listitem')).toHaveText(['提纲.md+2−0', '方案.md+3−3', '预算.md+2−1']);
    await expect(notices(page)).toHaveCount(0);

    // A row still opens the comparison of that time, under the line that says the turn is undone.
    await card.getByRole('button', { name: /^方案\.md/ }).click();
    const tab = panel(page).getByTestId('changes-tab');
    await expect(tab.getByText('这一轮的改动已经撤销')).toBeVisible();
    await expect(tab.getByTestId('changes-diff')).toContainText('目标甲');
    await expect(tab.getByTestId('changes-diff')).toContainText('目标一');
    await shot(page, '05-changes-tab-of-an-undone-turn');
  });

  test('undoing a turn that deleted a file with delete_file brings the file back where it was, with its content', async () => {
    test.setTimeout(200_000);
    const { page, workspace } = await launchInProject(
      (folder) => [deleteFileCall('call-delete-draft', path.join(folder, '草稿.md')), finalReply()],
      (folder) => fs.writeFileSync(path.join(folder, '草稿.md'), DRAFT),
    );
    const card = await runTurn(page);
    expect(has(workspace, '草稿.md')).toBe(false);
    await expect(card.getByRole('button', { name: /^已编辑 草稿\.md/ })).toBeVisible();

    await undoButton(card).click();
    const dialog = page.getByRole('alertdialog', { name: UNDO_QUESTION });
    await expect(dialog).toContainText('1 个文件会恢复到这一轮开始之前');
    await expect(willLines(dialog)).toHaveText(['草稿.md恢复到原来的位置']);
    await pressWhenSettled(dialog.getByRole('button', { name: '撤销', exact: true }));

    await expect(card.getByRole('button', { name: /^已撤销 草稿\.md 的改动/ })).toBeVisible();
    expect(read(workspace, '草稿.md')).toBe(DRAFT);
  });

  test('Cancel and Escape close the question without touching a file or the card', async () => {
    test.setTimeout(200_000);
    const { page, workspace } = await launchInProject(twoEditsAndOneNewFile, seedPlanAndBudget);
    const card = await runTurn(page);
    const dialog = page.getByRole('alertdialog', { name: UNDO_QUESTION });
    const unchanged = async (): Promise<void> => {
      await expect(dialog).toHaveCount(0);
      await expect(card.getByRole('button', { name: /^已编辑 3 个文件/ })).toBeVisible();
      await expect(undoButton(card)).toBeVisible();
      await expect(reapplyButton(card)).toHaveCount(0);
      expect(read(workspace, '方案.md')).toBe(PLAN_AFTER);
      expect(read(workspace, '预算.md')).toBe(BUDGET_AFTER);
      expect(read(workspace, '提纲.md')).toBe(OUTLINE);
    };

    await undoButton(card).click();
    await pressWhenSettled(dialog.getByRole('button', { name: '取消', exact: true }));
    await unchanged();

    await undoButton(card).click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await unchanged();
  });

  test('a turn is undone the same way after the app was restarted, and stays undone over another restart', async () => {
    test.setTimeout(300_000);
    const { page, workspace } = await launchInProject(twoEditsAndOneNewFile, seedPlanAndBudget);
    const card = await runTurn(page);
    // The changes tab opens the right panel, which is the state `reopenConversation` starts from.
    await card.getByRole('button', { name: /^已编辑 3 个文件/ }).click();
    await expect(panel(page).getByTestId('changes-tab')).toBeVisible();

    const reopened = await reopenConversation();
    const reopenedCard = reopened.getByTestId('changed-files-card');
    await expect(reopenedCard).toHaveCount(1, { timeout: RECORD_TIMEOUT });
    await expect(undoButton(reopenedCard)).toBeVisible();
    expect(read(workspace, '方案.md')).toBe(PLAN_AFTER);

    await confirmFromCard(reopened, undoButton(reopenedCard), UNDO_QUESTION, '撤销');

    await expect(reopenedCard.getByRole('button', { name: /^已撤销 3 个文件的改动/ })).toBeVisible();
    expect(read(workspace, '方案.md')).toBe(PLAN_BEFORE);
    expect(read(workspace, '预算.md')).toBe(BUDGET_BEFORE);
    expect(has(workspace, '提纲.md')).toBe(false);

    await reopenedCard.getByRole('button', { name: /^已撤销 3 个文件的改动/ }).click();
    await expect(panel(reopened).getByTestId('changes-tab').getByText('这一轮的改动已经撤销')).toBeVisible();
    const again = await reopenConversation();
    const cardAgain = again.getByTestId('changed-files-card');
    await expect(cardAgain.getByRole('button', { name: /^已撤销 3 个文件的改动/ })).toBeVisible({ timeout: RECORD_TIMEOUT });
    await expect(reapplyButton(cardAgain)).toBeVisible();
    await expect(reapplyButton(cardAgain)).not.toHaveAttribute('aria-disabled', 'true');
    await expect(undoButton(cardAgain)).toHaveCount(0);
  });
});

test.describe('story 2: seeing beforehand which files change and which do not', () => {
  test('files a command changed are listed as not restored, with the reason, and stay as they are', async () => {
    test.setTimeout(200_000);
    const { page, workspace } = await launchInProject(
      (folder) => [
        commandCall('call-make-sheet', "printf 'sheet' > 报表.xlsx"),
        commandCall('call-change-contract', "printf 'second version' > 合同.docx"),
        editFileCall('call-edit-plan', path.join(folder, '方案.md'), PLAN_GOALS_BEFORE, PLAN_GOALS_AFTER),
        finalReply(),
      ],
      (folder) => {
        fs.writeFileSync(path.join(folder, '方案.md'), PLAN_BEFORE);
        fs.writeFileSync(path.join(folder, '合同.docx'), 'v1');
      },
    );
    const card = await runTurn(page);
    await expect(card.getByRole('listitem')).toHaveText(['合同.docx已修改', '报表.xlsx新建', '方案.md+3−3']);

    await undoButton(card).click();
    const dialog = page.getByRole('alertdialog', { name: UNDO_QUESTION });
    await expect(dialog).toContainText('1 个文件会恢复到这一轮开始之前');
    await expect(willLines(dialog)).toHaveText(['方案.md恢复为修改前的内容']);
    await expect(dialog.getByRole('list', { name: '不会恢复' }).getByRole('listitem')).toHaveText([
      '合同.docx这份文件是用命令改动的，没有保存修改前的内容',
      '报表.xlsx这份文件是用命令改动的，没有保存修改前的内容',
    ]);
    await shot(page, '02-undo-question-with-files-not-restored');
    await pressWhenSettled(dialog.getByRole('button', { name: '撤销', exact: true }));

    await expect(card.getByRole('button', { name: /^已撤销 方案\.md 的改动/ })).toBeVisible();
    await expect(card.getByRole('listitem')).toHaveText(['合同.docx没有恢复已修改', '报表.xlsx没有恢复新建', '方案.md+3−3']);
    expect(read(workspace, '方案.md')).toBe(PLAN_BEFORE);
    expect(read(workspace, '合同.docx')).toBe('second version');
    expect(read(workspace, '报表.xlsx')).toBe('sheet');
    // Files left alone by the plan are no failure: there is no notice.
    await expect(notices(page)).toHaveCount(0);
  });

  test('a file changed again after the turn is listed as not restored, with the reason, and keeps its content', async () => {
    test.setTimeout(200_000);
    const mine = '# 预算\n\n我自己改过的合计 150\n';
    const { page, workspace } = await launchInProject(twoEditsAndOneNewFile, seedPlanAndBudget);
    const card = await runTurn(page);
    fs.writeFileSync(path.join(workspace, '预算.md'), mine);

    await undoButton(card).click();
    const dialog = page.getByRole('alertdialog', { name: UNDO_QUESTION });
    await expect(dialog).toContainText('2 个文件会恢复到这一轮开始之前');
    await expect(willLines(dialog)).toHaveText(['提纲.md移到废纸篓', '方案.md恢复为修改前的内容']);
    await expect(dialog.getByRole('list', { name: '不会恢复' }).getByRole('listitem')).toHaveText([
      '预算.md这份文件在这一轮之后又被改过',
    ]);
    await pressWhenSettled(dialog.getByRole('button', { name: '撤销', exact: true }));

    await expect(card.getByRole('button', { name: /^已撤销 2 个文件的改动/ })).toBeVisible();
    await expect(card.getByRole('listitem')).toHaveText(['提纲.md+2−0', '方案.md+3−3', '预算.md没有恢复+2−1']);
    expect(read(workspace, '预算.md')).toBe(mine);
    expect(read(workspace, '方案.md')).toBe(PLAN_BEFORE);
    expect(has(workspace, '提纲.md')).toBe(false);
    await shot(page, '03-undone-card-with-a-file-not-restored');
  });

  test('a file over 2 MB is listed as not restored, with the reason', async () => {
    test.setTimeout(200_000);
    const bigBefore = `标记甲\n${'a'.repeat(2 * 1024 * 1024)}\n`;
    const { page, workspace } = await launchInProject(
      (folder) => [
        editFileCall('call-edit-big', path.join(folder, '大文件.log'), '标记甲', '标记乙'),
        editFileCall('call-edit-plan', path.join(folder, '方案.md'), PLAN_GOALS_BEFORE, PLAN_GOALS_AFTER),
        finalReply(),
      ],
      (folder) => {
        fs.writeFileSync(path.join(folder, '大文件.log'), bigBefore);
        fs.writeFileSync(path.join(folder, '方案.md'), PLAN_BEFORE);
      },
    );
    const card = await runTurn(page);
    expect(read(workspace, '大文件.log').startsWith('标记乙\n')).toBe(true);

    await undoButton(card).click();
    const dialog = page.getByRole('alertdialog', { name: UNDO_QUESTION });
    await expect(willLines(dialog)).toHaveText(['方案.md恢复为修改前的内容']);
    await expect(dialog.getByRole('list', { name: '不会恢复' }).getByRole('listitem')).toHaveText([
      '大文件.log这份文件过大，没有保存修改前的内容',
    ]);
    await pressWhenSettled(dialog.getByRole('button', { name: '撤销', exact: true }));

    await expect(card.getByRole('button', { name: /^已撤销 方案\.md 的改动/ })).toBeVisible();
    expect(read(workspace, '大文件.log').startsWith('标记乙\n')).toBe(true);
    expect(read(workspace, '方案.md')).toBe(PLAN_BEFORE);
  });

  test('a turn whose files can none of them be restored has no undo on its card', async () => {
    test.setTimeout(200_000);
    const { page, workspace } = await launchInProject(
      () => [commandCall('call-make-sheet', "printf 'sheet' > 报表.xlsx"), finalReply()],
      () => {},
    );
    const card = await runTurn(page);
    expect(read(workspace, '报表.xlsx')).toBe('sheet');

    await expect(card.getByRole('button', { name: /^已编辑 报表\.xlsx/ })).toBeVisible();
    await expect(undoButton(card)).toHaveCount(0);
    await expect(reapplyButton(card)).toHaveCount(0);
  });

  test('a file where Abu has no write authorization now is listed as not restored, with the reason, and stays as it is', async () => {
    // The turn writes a file beside the project folder. Both sit in the system's temporary
    // folder, which macOS reaches through a link: the turn records the file's resolved path,
    // and the write check refuses that spelling outside the project folder.
    test.skip(process.platform !== 'darwin', 'the temporary folder is reached through a link on macOS only');
    test.setTimeout(200_000);
    const memo = '备忘一\n备忘二\n';
    const { page, workspace } = await launchInProject(
      (folder) => [
        editFileCall('call-edit-plan', path.join(folder, '方案.md'), PLAN_GOALS_BEFORE, PLAN_GOALS_AFTER),
        writeFileCall('call-write-memo', path.join(path.dirname(folder), 'elsewhere', '备忘.md'), memo),
        finalReply(),
      ],
      (folder) => {
        fs.writeFileSync(path.join(folder, '方案.md'), PLAN_BEFORE);
        fs.mkdirSync(path.join(path.dirname(folder), 'elsewhere'));
      },
    );
    const memoPath = path.join(path.dirname(workspace), 'elsewhere', '备忘.md');
    const card = await runTurn(page);
    expect(fs.readFileSync(memoPath, 'utf8')).toBe(memo);
    const recordedMemoPath = fs.realpathSync(memoPath);
    expect(recordedMemoPath).not.toBe(memoPath);
    await expect(card.getByRole('button', { name: /^已编辑 2 个文件/ })).toBeVisible();

    await undoButton(card).click();
    const dialog = page.getByRole('alertdialog', { name: UNDO_QUESTION });
    await expect(dialog).toContainText('1 个文件会恢复到这一轮开始之前');
    await expect(willLines(dialog)).toHaveText(['方案.md恢复为修改前的内容']);
    await expect(dialog.getByRole('list', { name: '不会恢复' }).getByRole('listitem')).toHaveText([
      `${recordedMemoPath}阿布现在没有这个位置的写入授权`,
    ]);
    await shot(page, '06-undo-question-not-authorized');
    await pressWhenSettled(dialog.getByRole('button', { name: '撤销', exact: true }));

    await expect(card.getByRole('button', { name: /^已撤销 方案\.md 的改动/ })).toBeVisible();
    expect(read(workspace, '方案.md')).toBe(PLAN_BEFORE);
    expect(fs.readFileSync(memoPath, 'utf8')).toBe(memo);
    await expect(card.getByRole('listitem').filter({ hasText: '备忘.md' })).toContainText('没有恢复');
    // The question already said this file is not restored, so no notice repeats it.
    await expect(notices(page)).toHaveCount(0);
  });

  test('a file that cannot be written is marked as not restored and counted in a notice, and the others are restored', async () => {
    test.setTimeout(200_000);
    const { page, workspace } = await launchInProject(twoEditsAndOneNewFile, seedPlanAndBudget);
    const card = await runTurn(page);
    fs.chmodSync(path.join(workspace, '预算.md'), 0o444);

    await confirmFromCard(page, undoButton(card), UNDO_QUESTION, '撤销');

    await expect(card.getByRole('button', { name: /^已撤销 2 个文件的改动/ })).toBeVisible();
    await expect(notices(page)).toHaveText([/已恢复 2 个，1 个没有恢复/]);
    await expect(card.getByRole('listitem')).toHaveText(['提纲.md+2−0', '方案.md+3−3', '预算.md没有恢复+2−1']);
    expect(read(workspace, '预算.md')).toBe(BUDGET_AFTER);
    expect(read(workspace, '方案.md')).toBe(PLAN_BEFORE);
    expect(has(workspace, '提纲.md')).toBe(false);
  });
});

test.describe('story 3: putting the changes back after an undo', () => {
  test('putting the changes back gives every file what it held before the undo, and the card reads as before', async () => {
    test.setTimeout(200_000);
    const { page, workspace } = await launchInProject(editCreateAndDelete, seedPlanAndDraft);
    const card = await runTurn(page);
    await confirmFromCard(page, undoButton(card), UNDO_QUESTION, '撤销');
    await expect(card.getByRole('button', { name: /^已撤销 3 个文件的改动/ })).toBeVisible();
    expect(read(workspace, '方案.md')).toBe(PLAN_BEFORE);
    expect(has(workspace, '提纲.md')).toBe(false);
    expect(read(workspace, '草稿.md')).toBe(DRAFT);

    await reapplyButton(card).click();
    const dialog = page.getByRole('alertdialog', { name: REAPPLY_QUESTION });
    await expect(dialog).toContainText('3 个文件会回到撤销之前的样子');
    await expect(willLines(dialog)).toHaveText(['提纲.md放回原来的位置', '方案.md放回阿布改完的内容', '草稿.md移到废纸篓']);
    await expect(dialog.getByTestId('turn-undo-wont')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
    await shot(page, '04-put-back-question');
    await pressWhenSettled(dialog.getByRole('button', { name: '放回改动', exact: true }));

    await expect(card.getByRole('button', { name: /^已编辑 3 个文件/ })).toBeVisible();
    await expect(undoButton(card)).toBeVisible();
    await expect(reapplyButton(card)).toHaveCount(0);
    await expect(card.getByRole('listitem')).toHaveText(['提纲.md+2−0', '方案.md+3−3', '草稿.md+0−3']);
    expect(read(workspace, '方案.md')).toBe(PLAN_AFTER);
    expect(read(workspace, '提纲.md')).toBe(OUTLINE);
    expect(has(workspace, '草稿.md')).toBe(false);
    await expect(notices(page)).toHaveCount(0);

    // The line on top of the changes tab is gone with the undo.
    await card.getByRole('button', { name: /^方案\.md/ }).click();
    const tab = panel(page).getByTestId('changes-tab');
    await expect(tab.getByTestId('changes-diff')).toContainText('目标一');
    await expect(tab.getByText('这一轮的改动已经撤销')).toHaveCount(0);
  });

  test('a file changed again after the undo is listed as not put back, with the reason, and keeps its content', async () => {
    test.setTimeout(200_000);
    const mine = `${PLAN_BEFORE}撤销之后我补的一行\n`;
    const { page, workspace } = await launchInProject(editCreateAndDelete, seedPlanAndDraft);
    const card = await runTurn(page);
    await confirmFromCard(page, undoButton(card), UNDO_QUESTION, '撤销');
    await expect(reapplyButton(card)).toBeVisible();
    fs.writeFileSync(path.join(workspace, '方案.md'), mine);

    await reapplyButton(card).click();
    const dialog = page.getByRole('alertdialog', { name: REAPPLY_QUESTION });
    await expect(dialog).toContainText('2 个文件会回到撤销之前的样子');
    await expect(willLines(dialog)).toHaveText(['提纲.md放回原来的位置', '草稿.md移到废纸篓']);
    await expect(dialog.getByRole('list', { name: '不会放回' }).getByRole('listitem')).toHaveText([
      '方案.md这份文件在撤销之后又被改过',
    ]);
    await pressWhenSettled(dialog.getByRole('button', { name: '放回改动', exact: true }));

    await expect(card.getByRole('button', { name: /^已编辑 3 个文件/ })).toBeVisible();
    await expect(card.getByRole('listitem')).toHaveText(['提纲.md+2−0', '方案.md没有放回+3−3', '草稿.md+0−3']);
    expect(read(workspace, '方案.md')).toBe(mine);
    expect(read(workspace, '提纲.md')).toBe(OUTLINE);
    expect(has(workspace, '草稿.md')).toBe(false);
  });
});

test.describe('a turn whose undo record is damaged, or whose copies were removed', () => {
  test('an undo record cut off halfway costs that turn its undo, and its card and changes tab still show what it changed', async () => {
    test.setTimeout(300_000);
    const { page, workspace } = await launchInProject(twoEditsAndOneNewFile, seedPlanAndBudget);
    const card = await runTurn(page);
    await expect(undoButton(card)).toBeVisible();
    await card.getByRole('button', { name: /^已编辑 3 个文件/ }).click();
    await expect(panel(page).getByTestId('changes-tab')).toBeVisible();
    const { changes, loopId } = onlyTurnDir();
    const record = path.join(changes, loopId, 'undo.json');
    const cutOff = fs.readFileSync(record, 'utf8').slice(0, 40);

    const reopened = await reopenConversation(() => fs.writeFileSync(record, cutOff));

    const reopenedCard = reopened.getByTestId('changed-files-card');
    await expect(reopenedCard.getByRole('button', { name: /^已编辑 3 个文件/ })).toBeVisible({ timeout: RECORD_TIMEOUT });
    await expect(reopenedCard.getByRole('listitem')).toHaveText(['提纲.md+2−0', '方案.md+3−3', '预算.md+2−1']);
    await expect(undoButton(reopenedCard)).toHaveCount(0);
    await expect(reapplyButton(reopenedCard)).toHaveCount(0);
    await reopenedCard.getByRole('button', { name: /^方案\.md/ }).click();
    const tab = panel(reopened).getByTestId('changes-tab');
    await expect(tab.getByTestId('changes-diff')).toContainText('目标一');
    await expect(tab.getByText('这一轮的改动已经撤销')).toHaveCount(0);
    await shot(reopened, '20-card-of-a-turn-whose-undo-record-is-damaged');
    expect(read(workspace, '方案.md')).toBe(PLAN_AFTER);
    // The damaged record stays where it is.
    expect(fs.readFileSync(record, 'utf8')).toBe(cutOff);
  });

  test('an undone turn whose copies were removed still says it is undone, offers nothing to put back, and keeps the files as the undo left them', async () => {
    test.setTimeout(300_000);
    const { page, workspace } = await launchInProject(twoEditsAndOneNewFile, seedPlanAndBudget);
    const card = await runTurn(page);
    await confirmFromCard(page, undoButton(card), UNDO_QUESTION, '撤销');
    await expect(card.getByRole('button', { name: /^已撤销 3 个文件的改动/ })).toBeVisible();
    await card.getByRole('button', { name: /^已撤销 3 个文件的改动/ }).click();
    await expect(panel(page).getByTestId('changes-tab')).toBeVisible();
    const { changes, loopId } = onlyTurnDir();

    // What the copy limit of a conversation leaves of this turn (turnChanges trimCopies): no folder, and an
    // index entry that keeps the undone mark with the count of files its undo restored.
    const reopened = await reopenConversation(() => {
      fs.rmSync(path.join(changes, loopId), { recursive: true });
      const indexPath = path.join(changes, 'index.json');
      const index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as { turns: Record<string, Record<string, unknown>> };
      const { total, added, deleted, firstFile } = index.turns[loopId];
      index.turns[loopId] = { total, added, deleted, firstFile, undone: true, undoneCount: 3 };
      fs.writeFileSync(indexPath, JSON.stringify(index));
    });

    const reopenedCard = reopened.getByTestId('changed-files-card');
    await expect(reopenedCard.getByRole('button', { name: /^已撤销 3 个文件的改动/ })).toBeVisible({ timeout: RECORD_TIMEOUT });
    await expect(reapplyButton(reopenedCard)).toHaveCount(0);
    await expect(undoButton(reopenedCard)).toHaveCount(0);
    await expect(reopenedCard.getByRole('listitem')).toHaveText(['提纲.md+2−0', '方案.md+3−3', '预算.md+2−1']);
    await reopenedCard.getByRole('button', { name: /^方案\.md/ }).click();
    await expect(panel(reopened).getByTestId('changes-tab').getByText('这一轮的改动已经撤销')).toBeVisible();
    await shot(reopened, '21-card-of-an-undone-turn-whose-copies-were-removed');
    expect(read(workspace, '方案.md')).toBe(PLAN_BEFORE);
    expect(read(workspace, '预算.md')).toBe(BUDGET_BEFORE);
    expect(has(workspace, '提纲.md')).toBe(false);
  });
});
