/**
 * Real-Electron acceptance for redoing a turn with its files restored: the
 * question each redo entry asks (重新生成 under a reply, 编辑 and send on the
 * user's message, 重试 under a failed message), the files it lists as restored
 * and as left alone, and what the files on disk and the conversation hold
 * after the answer.
 *
 * A loopback model scripts each turn with file tools and commands, and every
 * redone turn with a reply of its own. Every case runs in a project whose
 * folder sits in the test's own data root, and reads the files on disk. With
 * ABU_E2E_SCREENSHOT_DIR set, the states named in the cases are saved there
 * as pictures, each after the assertions that establish the state.
 */
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from 'playwright';
import {
  closeAbuElectron,
  launchAbuElectron,
  pressWhenSettled,
  removeElectronDataRoot,
} from './electronHelpers';
import {
  CHAT_PLACEHOLDER,
  READY_TIMEOUT,
  waitForApp,
  type MockReplyPlan,
  type MockRequest,
} from './openAiMock';
import {
  commandCall,
  editFileCall,
  FINAL_TEXT,
  finalReply,
  has,
  launchInProject,
  notices,
  read,
  writeFileCall,
  type LaunchedProject,
} from './turnChangesFixtures';

const PROJECT_NAME = 'E2E 重做恢复文件';
const PROMPT = '请修改 a.md 和 b.md';
const EDITED_PROMPT = '请只把 a.md 改成第三版';
const REDONE_TEXT = '重新做好了。';
const REPLY_TIMEOUT = 60_000;
const RECORD_TIMEOUT = 30_000;
const SCREENSHOT_DIR = process.env.ABU_E2E_SCREENSHOT_DIR;

const A_BEFORE = 'a 第一版\n';
const A_AFTER = 'a 第二版\n';
const A_THIRD = 'a 第三版\n';
const A_REDONE = 'a 重做版\n';
const B_BEFORE = 'b 第一版\n';
const B_AFTER = 'b 第二版\n';
const C_NEW = 'c 新建\n';

const REGENERATE_QUESTION = '重新生成这一轮？';
const EDIT_QUESTION = '按修改后的内容重新发送？';
const RETRY_QUESTION = '重试这一轮？';
const RESEND_QUESTION = '重新发送这一轮？';
const QUIT_QUESTION = '阿布还在处理任务，现在退出会中断它。';
const CLOSED_MIDWAY = '上次关闭应用时，这一轮没有做完。';
const RESTORE_OPTION = '同时把文件恢复到这一轮开始之前';
const NO_PUT_BACK = '恢复之后不能放回';
const COMMAND_NOT_RESTORED = '用命令改动的文件不会恢复';
const RESTORE_A = 'a.md恢复为修改前的内容';
const RESTORE_B = 'b.md恢复为修改前的内容';
const TRASH_C = 'c.md移到废纸篓';

let launched: LaunchedProject | undefined;
let outsideFixtureDir: string | undefined;

test.afterEach(async () => {
  if (launched) {
    await closeAbuElectron(launched.app);
    await launched.mock.close();
    removeElectronDataRoot(launched.dataRoot);
  }
  launched = undefined;
  if (outsideFixtureDir) fs.rmSync(outsideFixtureDir, { recursive: true, force: true });
  outsideFixtureDir = undefined;
});

async function launch(
  plansFor: (workspace: string) => MockReplyPlan[],
  seed: (workspace: string) => void = seedAAndB,
): Promise<{ page: Page; workspace: string }> {
  launched = await launchInProject(PROJECT_NAME, plansFor, seed);
  return { page: launched.page, workspace: launched.workspace };
}

function seedAAndB(folder: string): void {
  fs.writeFileSync(path.join(folder, 'a.md'), A_BEFORE);
  fs.writeFileSync(path.join(folder, 'b.md'), B_BEFORE);
}

/** A turn that edits a.md and b.md and creates c.md. */
function twoEditsAndOneNewFile(folder: string): MockReplyPlan[] {
  return [
    editFileCall('call-edit-a', path.join(folder, 'a.md'), 'a 第一版', 'a 第二版'),
    editFileCall('call-edit-b', path.join(folder, 'b.md'), 'b 第一版', 'b 第二版'),
    writeFileCall('call-write-c', path.join(folder, 'c.md'), C_NEW),
    finalReply(),
  ];
}

/** The turn of `twoEditsAndOneNewFile`, then a redone turn that only answers. */
function oneTurnThenRedo(folder: string): MockReplyPlan[] {
  return [...twoEditsAndOneNewFile(folder), finalReply(REDONE_TEXT)];
}

/**
 * A redone turn that first edits a.md from its content before the turn. The edit finds that
 * content only in a restored file, so `A_REDONE` on disk shows the restore came before the run.
 */
function redoneTurnOnRestoredA(folder: string): MockReplyPlan[] {
  return [editFileCall('call-redo-edit-a', path.join(folder, 'a.md'), 'a 第一版', 'a 重做版'), finalReply(REDONE_TEXT)];
}

/** The turn of `twoEditsAndOneNewFile`, then `redoneTurnOnRestoredA`. */
function oneTurnThenRedoOnRestored(folder: string): MockReplyPlan[] {
  return [...twoEditsAndOneNewFile(folder), ...redoneTurnOnRestoredA(folder)];
}

/** Send `prompt` and wait until its turn has ended with `reply` and `cards` cards of changed files are there. */
async function runTurn(page: Page, prompt: string, reply: string, cards: number): Promise<void> {
  const composer = page.getByPlaceholder(CHAT_PLACEHOLDER);
  await composer.fill(prompt);
  await composer.press('Enter');
  await expectTurnEnded(page, reply);
  await expect(changedFilesCards(page)).toHaveCount(cards, { timeout: RECORD_TIMEOUT });
}

/**
 * Waits for `reply` and for the end of its run. A reply without steps has no 用时 row, so the end
 * is read from 重新生成, which the replies show only while the conversation is not running.
 */
async function expectTurnEnded(page: Page, reply: string): Promise<void> {
  await expect(page.getByText(reply, { exact: true })).toBeVisible({ timeout: REPLY_TIMEOUT });
  await expect(page.getByRole('button', { name: '重新生成', exact: true }).last()).toBeVisible({ timeout: REPLY_TIMEOUT });
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SCREENSHOT_DIR) return;
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}.png`), animations: 'disabled' });
}

function changedFilesCards(page: Page): Locator {
  return page.getByTestId('changed-files-card');
}

function question(page: Page, title: string): Locator {
  return page.getByRole('alertdialog', { name: title });
}

function restoreOption(dialog: Locator): Locator {
  return dialog.getByRole('checkbox', { name: RESTORE_OPTION });
}

function willLines(dialog: Locator): Locator {
  return dialog.getByTestId('redo-turn-will').getByRole('listitem');
}

function wontLines(dialog: Locator): Locator {
  return dialog.getByRole('list', { name: '不会恢复' }).getByRole('listitem');
}

/** 重新生成 under the reply of the turn at `index` (0 is the first turn). */
async function regenerate(page: Page, index: number): Promise<void> {
  await expect(page.getByTestId('redo-turn-dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '重新生成', exact: true }).nth(index).click();
}

function userMessages(page: Page, text: string): Locator {
  return page.locator('[data-message-id]').filter({ hasText: text });
}

function editor(page: Page): Locator {
  return page.locator('[data-message-id]').getByRole('textbox');
}

/** 编辑 on the user's message holding `prompt`, the new text typed, and 保存并重发 pressed. */
async function editAndSend(page: Page, prompt: string, text: string): Promise<void> {
  await userMessages(page, prompt).getByRole('button', { name: '编辑', exact: true }).click();
  await expect(editor(page)).toBeVisible();
  await editor(page).fill(text);
  await page.getByRole('button', { name: '保存并重发', exact: true }).click();
}

/** The requests of the conversation's own turns: they carry the tools. */
function turnRequests(): MockRequest[] {
  return launched!.mock.requests.filter((request) => {
    const tools = (request.body as { tools?: unknown[] } | null)?.tools;
    return Array.isArray(tools) && tools.length > 0;
  });
}

/** The user messages of a request to the model, each as its serialized content. */
function userContents(request: MockRequest): string[] {
  const messages = (request.body as { messages: Array<{ role: string; content: unknown }> }).messages;
  return messages.filter((message) => message.role === 'user').map((message) => JSON.stringify(message.content));
}

test.describe('story 1: redoing a turn restores the files it changed', () => {
  test('pressing 重新生成 asks with the three files, the option ticked and no put-back; confirming restores them and runs the turn again', async () => {
    test.setTimeout(240_000);
    const { page, workspace } = await launch(oneTurnThenRedoOnRestored);
    await runTurn(page, PROMPT, FINAL_TEXT, 1);
    await expect(changedFilesCards(page).getByRole('button', { name: /^已编辑 3 个文件/ })).toBeVisible();
    expect(read(workspace, 'a.md')).toBe(A_AFTER);
    expect(read(workspace, 'b.md')).toBe(B_AFTER);
    expect(read(workspace, 'c.md')).toBe(C_NEW);
    await shot(page, 'redo-1-a-card-and-regenerate');

    await regenerate(page, 0);
    const dialog = question(page, REGENERATE_QUESTION);
    await expect(dialog).toBeVisible();
    await expect(restoreOption(dialog)).toBeChecked();
    await expect(dialog.getByText(NO_PUT_BACK, { exact: true })).toBeVisible();
    await expect(dialog.getByText(COMMAND_NOT_RESTORED, { exact: true })).toBeVisible();
    await expect(dialog).toContainText('3 个文件会恢复到这一轮开始之前');
    await expect(willLines(dialog)).toHaveText([RESTORE_A, RESTORE_B, TRASH_C]);
    await expect(dialog.getByTestId('redo-turn-wont')).toHaveCount(0);
    await expect(dialog).not.toContainText('这之后还有');
    await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
    await shot(page, 'redo-2-b-question-with-files-checked');
    await pressWhenSettled(dialog.getByRole('button', { name: '重新生成', exact: true }));

    await expectTurnEnded(page, REDONE_TEXT);
    await expect(dialog).toHaveCount(0);
    // The redone turn's edit found a.md's content before the turn: the restore ran first.
    await expect(changedFilesCards(page)).toHaveCount(1, { timeout: RECORD_TIMEOUT });
    await expect(changedFilesCards(page).getByRole('button', { name: /^已编辑 a\.md/ })).toBeVisible();
    expect(read(workspace, 'a.md')).toBe(A_REDONE);
    expect(read(workspace, 'b.md')).toBe(B_BEFORE);
    expect(has(workspace, 'c.md')).toBe(false);
    await expect(page.getByText(FINAL_TEXT, { exact: true })).toHaveCount(0);
    await expect(userMessages(page, PROMPT)).toHaveCount(1);
    const requests = turnRequests();
    expect(userContents(requests[requests.length - 1]).filter((content) => content.includes(PROMPT))).toHaveLength(1);
    await shot(page, 'redo-4-i-new-turn-after-restore');
  });

  test('unticking the option and confirming leaves the files as they are and runs the turn again; the next question has the option ticked again', async () => {
    test.setTimeout(240_000);
    const { page, workspace } = await launch((folder) => [
      ...twoEditsAndOneNewFile(folder),
      editFileCall('call-edit-a-again', path.join(folder, 'a.md'), 'a 第二版', 'a 第三版'),
      finalReply(REDONE_TEXT),
    ]);
    await runTurn(page, PROMPT, FINAL_TEXT, 1);

    await regenerate(page, 0);
    const dialog = question(page, REGENERATE_QUESTION);
    await expect(restoreOption(dialog)).toBeChecked();
    await restoreOption(dialog).click();
    await expect(restoreOption(dialog)).not.toBeChecked();
    await expect(dialog.getByText(NO_PUT_BACK, { exact: true })).toHaveCount(0);
    await expect(dialog.getByTestId('redo-turn-will')).toHaveCount(0);
    await shot(page, 'redo-2-c-question-unchecked');
    await pressWhenSettled(dialog.getByRole('button', { name: '重新生成', exact: true }));

    // The redone turn edits a.md once more, from what the first turn left.
    await expectTurnEnded(page, REDONE_TEXT);
    await expect(changedFilesCards(page)).toHaveCount(1, { timeout: RECORD_TIMEOUT });
    expect(read(workspace, 'a.md')).toBe(A_THIRD);
    expect(read(workspace, 'b.md')).toBe(B_AFTER);
    expect(read(workspace, 'c.md')).toBe(C_NEW);
    await expect(page.getByText(FINAL_TEXT, { exact: true })).toHaveCount(0);

    await regenerate(page, 0);
    const again = question(page, REGENERATE_QUESTION);
    await expect(restoreOption(again)).toBeChecked();
    await expect(willLines(again)).toHaveText([RESTORE_A]);
    await pressWhenSettled(again.getByRole('button', { name: '取消', exact: true }));
    await expect(again).toHaveCount(0);
    expect(read(workspace, 'a.md')).toBe(A_THIRD);
  });

  test('sending an edited message restores the files first, then runs the turn with the edited text', async () => {
    test.setTimeout(240_000);
    const { page, workspace } = await launch(oneTurnThenRedoOnRestored);
    await runTurn(page, PROMPT, FINAL_TEXT, 1);

    await editAndSend(page, PROMPT, EDITED_PROMPT);
    const dialog = question(page, EDIT_QUESTION);
    await expect(restoreOption(dialog)).toBeChecked();
    await expect(willLines(dialog)).toHaveText([RESTORE_A, RESTORE_B, TRASH_C]);
    // The open question hides the page from the accessibility tree, so the editor is read as an element.
    await expect(page.locator('[data-message-id] textarea')).toHaveValue(EDITED_PROMPT);
    await shot(page, 'redo-2-g-edit-question-with-editor');
    await pressWhenSettled(dialog.getByRole('button', { name: '发送', exact: true }));

    await expectTurnEnded(page, REDONE_TEXT);
    // The redone turn's edit found a.md's content before the turn: the restore ran first.
    expect(read(workspace, 'a.md')).toBe(A_REDONE);
    expect(read(workspace, 'b.md')).toBe(B_BEFORE);
    expect(has(workspace, 'c.md')).toBe(false);
    await expect(editor(page)).toHaveCount(0);
    await expect(userMessages(page, EDITED_PROMPT)).toHaveCount(1);
    await expect(userMessages(page, PROMPT)).toHaveCount(0);
    const requests = turnRequests();
    const lastUser = userContents(requests[requests.length - 1]);
    expect(lastUser[lastUser.length - 1]).toContain(EDITED_PROMPT);
    expect(lastUser.filter((content) => content.includes(PROMPT))).toHaveLength(0);
  });

  test('pressing 重试 under a turn that failed after changing a file restores that file, then runs the turn again', async () => {
    test.setTimeout(240_000);
    const { page, workspace } = await launch((folder) => [
      editFileCall('call-edit-a', path.join(folder, 'a.md'), 'a 第一版', 'a 第二版'),
      { kind: 'http-error', status: 400, body: { error: { code: 400, message: 'The request was rejected', type: 'invalid_request_error' } } },
      ...redoneTurnOnRestoredA(folder),
    ]);
    const composer = page.getByPlaceholder(CHAT_PLACEHOLDER);
    await composer.fill(PROMPT);
    await composer.press('Enter');
    const failed = userMessages(page, PROMPT);
    await expect(failed.getByText('发送失败', { exact: true })).toBeVisible({ timeout: REPLY_TIMEOUT });
    expect(read(workspace, 'a.md')).toBe(A_AFTER);

    await failed.getByRole('button', { name: '重试', exact: true }).click();
    const dialog = question(page, RETRY_QUESTION);
    await expect(restoreOption(dialog)).toBeChecked();
    await expect(willLines(dialog)).toHaveText([RESTORE_A]);
    await shot(page, 'redo-2-h-retry-question');
    await pressWhenSettled(dialog.getByRole('button', { name: '重试', exact: true }));

    await expectTurnEnded(page, REDONE_TEXT);
    // The redone turn's edit found a.md's content before the turn: the restore ran first.
    expect(read(workspace, 'a.md')).toBe(A_REDONE);
    expect(read(workspace, 'b.md')).toBe(B_BEFORE);
    await expect(page.getByText('发送失败', { exact: true })).toHaveCount(0);
    await expect(userMessages(page, PROMPT)).toHaveCount(1);
  });

  test('pressing 重新发送 under a turn the app closed on after it changed a file restores that file, then runs the turn again', async () => {
    test.setTimeout(300_000);
    const partial = 'REDO-RUNNING-TURN-PARTIAL';
    const { page, workspace } = await launch((folder) => [
      editFileCall('call-edit-a', path.join(folder, 'a.md'), 'a 第一版', 'a 第二版'),
      { kind: 'hold-open', partialText: partial },
      ...redoneTurnOnRestoredA(folder),
    ]);
    const composer = page.getByPlaceholder(CHAT_PLACEHOLDER);
    await composer.fill(PROMPT);
    await composer.press('Enter');
    await expect(page.getByText(partial, { exact: true })).toBeVisible({ timeout: REPLY_TIMEOUT });
    expect(read(workspace, 'a.md')).toBe(A_AFTER);

    // The user quits while the turn runs, and answers the quit question with 退出.
    const child = launched!.app.process();
    const left = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    await launched!.app.evaluate(({ app: electronApp }) => {
      setImmediate(() => electronApp.quit());
    });
    const quit = page.getByRole('alertdialog', { name: QUIT_QUESTION });
    await pressWhenSettled(quit.getByRole('button', { name: '退出', exact: true }));
    await left;

    launched!.app = (await launchAbuElectron(launched!.dataRoot)).app;
    const reopened = await launched!.app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForApp(reopened);
    const showSidebar = reopened.getByRole('button', { name: '显示侧栏', exact: true });
    if (await showSidebar.isVisible()) await showSidebar.click();
    await reopened.getByRole('group', { name: PROJECT_NAME })
      .getByRole('button', { name: PROJECT_NAME, exact: true })
      .click();
    await reopened.getByRole('button', { name: new RegExp(`^${PROMPT}`) }).click();
    const closedOn = userMessages(reopened, PROMPT);
    await expect(reopened.getByText(CLOSED_MIDWAY, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });

    await closedOn.getByRole('button', { name: '重新发送', exact: true }).click();
    const dialog = question(reopened, RESEND_QUESTION);
    await expect(restoreOption(dialog)).toBeChecked();
    await expect(willLines(dialog)).toHaveText([RESTORE_A]);
    await shot(reopened, 'redo-2-k-resend-question');
    await pressWhenSettled(dialog.getByRole('button', { name: '重新发送', exact: true }));

    await expectTurnEnded(reopened, REDONE_TEXT);
    // The redone turn's edit found a.md's content before the turn: the restore ran first.
    expect(read(workspace, 'a.md')).toBe(A_REDONE);
    await expect(reopened.getByText(CLOSED_MIDWAY, { exact: true })).toHaveCount(0);
    await expect(closedOn).toHaveCount(1);
  });

  test('Cancel and Escape leave the files and the conversation as they are, and keep the editor with the edited text', async () => {
    test.setTimeout(240_000);
    const { page, workspace } = await launch(oneTurnThenRedo);
    await runTurn(page, PROMPT, FINAL_TEXT, 1);
    const requestsBefore = turnRequests().length;
    const unchanged = async (): Promise<void> => {
      await expect(page.getByTestId('redo-turn-dialog')).toHaveCount(0);
      expect(read(workspace, 'a.md')).toBe(A_AFTER);
      expect(read(workspace, 'b.md')).toBe(B_AFTER);
      expect(read(workspace, 'c.md')).toBe(C_NEW);
      await expect(page.getByText(FINAL_TEXT, { exact: true })).toBeVisible();
      await expect(changedFilesCards(page).getByRole('button', { name: /^已编辑 3 个文件/ })).toBeVisible();
      expect(turnRequests()).toHaveLength(requestsBefore);
    };

    await regenerate(page, 0);
    await pressWhenSettled(question(page, REGENERATE_QUESTION).getByRole('button', { name: '取消', exact: true }));
    await unchanged();

    await regenerate(page, 0);
    await expect(question(page, REGENERATE_QUESTION)).toBeVisible();
    await page.keyboard.press('Escape');
    await unchanged();

    await editAndSend(page, PROMPT, EDITED_PROMPT);
    await pressWhenSettled(question(page, EDIT_QUESTION).getByRole('button', { name: '取消', exact: true }));
    await unchanged();
    await expect(editor(page)).toHaveValue(EDITED_PROMPT);

    await page.getByRole('button', { name: '保存并重发', exact: true }).click();
    await expect(question(page, EDIT_QUESTION)).toBeVisible();
    await page.keyboard.press('Escape');
    await unchanged();
    await expect(editor(page)).toHaveValue(EDITED_PROMPT);
  });

  test('pressing 重新生成 on a last turn that changed files only with a command runs it again with no question', async () => {
    test.setTimeout(240_000);
    const { page, workspace } = await launch(
      () => [commandCall('call-make-sheet', "printf 'sheet' > 报表.xlsx"), finalReply(), finalReply(REDONE_TEXT)],
      () => {},
    );
    await runTurn(page, PROMPT, FINAL_TEXT, 1);
    await expect(changedFilesCards(page).getByRole('button', { name: /^已编辑 报表\.xlsx/ })).toBeVisible();

    await regenerate(page, 0);
    // The redo waits for an answer while a question is open, so the new reply proves none was asked.
    await expectTurnEnded(page, REDONE_TEXT);
    await expect(page.getByTestId('redo-turn-dialog')).toHaveCount(0);
    await expect(page.getByText(FINAL_TEXT, { exact: true })).toHaveCount(0);
    expect(read(workspace, '报表.xlsx')).toBe('sheet');
  });
});

const FIRST_PROMPT = '第一轮：改 a.md';
const SECOND_PROMPT = '第二轮：再改 a.md 和 b.md';
const THIRD_PROMPT = '第三轮：新建 c.md';
const FIRST_REPLY = '第一轮做好了。';
const SECOND_REPLY = '第二轮做好了。';
const THIRD_REPLY = '第三轮做好了。';

/** Turn 1 edits a.md, turn 2 edits a.md and b.md, turn 3 creates c.md; then the redone turn 1 is `redoneTurnOnRestoredA`. */
function threeTurnsThenRedo(folder: string): MockReplyPlan[] {
  return [
    editFileCall('call-turn1-a', path.join(folder, 'a.md'), 'a 第一版', 'a 第二版'),
    finalReply(FIRST_REPLY),
    editFileCall('call-turn2-a', path.join(folder, 'a.md'), 'a 第二版', 'a 第三版'),
    editFileCall('call-turn2-b', path.join(folder, 'b.md'), 'b 第一版', 'b 第二版'),
    finalReply(SECOND_REPLY),
    writeFileCall('call-turn3-c', path.join(folder, 'c.md'), C_NEW),
    finalReply(THIRD_REPLY),
    ...redoneTurnOnRestoredA(folder),
  ];
}

async function runThreeTurns(page: Page): Promise<void> {
  await runTurn(page, FIRST_PROMPT, FIRST_REPLY, 1);
  await runTurn(page, SECOND_PROMPT, SECOND_REPLY, 2);
  await runTurn(page, THIRD_PROMPT, THIRD_REPLY, 3);
}

test.describe('story 2: redoing an earlier turn restores the files of the turns it deletes', () => {
  test('redoing turn 1 of three names the 2 later turns and the 3 files, and confirming restores all of them and keeps only what came before turn 1', async () => {
    test.setTimeout(300_000);
    const { page, workspace } = await launch(threeTurnsThenRedo);
    await runThreeTurns(page);
    expect(read(workspace, 'a.md')).toBe(A_THIRD);
    expect(read(workspace, 'b.md')).toBe(B_AFTER);
    expect(read(workspace, 'c.md')).toBe(C_NEW);

    await regenerate(page, 0);
    const dialog = question(page, REGENERATE_QUESTION);
    await expect(dialog).toContainText('这之后还有 2 轮对话，会一并永久删除。');
    await expect(restoreOption(dialog)).toBeChecked();
    await expect(willLines(dialog)).toHaveText([RESTORE_A, RESTORE_B, TRASH_C]);
    await shot(page, 'redo-2-d-question-with-later-turns');
    await pressWhenSettled(dialog.getByRole('button', { name: '重新生成', exact: true }));

    await expectTurnEnded(page, REDONE_TEXT);
    // The redone turn's edit found a.md's content before turn 1: the restore ran first.
    expect(read(workspace, 'a.md')).toBe(A_REDONE);
    expect(read(workspace, 'b.md')).toBe(B_BEFORE);
    expect(has(workspace, 'c.md')).toBe(false);
    await expect(userMessages(page, FIRST_PROMPT)).toHaveCount(1);
    await expect(userMessages(page, SECOND_PROMPT)).toHaveCount(0);
    await expect(userMessages(page, THIRD_PROMPT)).toHaveCount(0);
    for (const reply of [FIRST_REPLY, SECOND_REPLY, THIRD_REPLY]) {
      await expect(page.getByText(reply, { exact: true })).toHaveCount(0);
    }
    // One card is left: the redone turn's own edit of a.md.
    await expect(changedFilesCards(page)).toHaveCount(1, { timeout: RECORD_TIMEOUT });
    await expect(changedFilesCards(page).getByRole('button', { name: /^已编辑 a\.md/ })).toBeVisible();
  });

  test('a later turn undone on its card first leaves its restored files out of the list, and they are not written again', async () => {
    test.setTimeout(300_000);
    const { page, workspace } = await launch(threeTurnsThenRedo);
    await runThreeTurns(page);

    const secondCard = changedFilesCards(page).nth(1);
    await secondCard.getByRole('button', { name: '撤销', exact: true }).click();
    const undo = question(page, '撤销这一轮的文件改动？');
    await pressWhenSettled(undo.getByRole('button', { name: '撤销', exact: true }));
    await expect(secondCard.getByRole('button', { name: /^已撤销 2 个文件的改动/ })).toBeVisible();
    expect(read(workspace, 'a.md')).toBe(A_AFTER);
    expect(read(workspace, 'b.md')).toBe(B_BEFORE);
    const bWrittenAt = fs.statSync(path.join(workspace, 'b.md')).mtimeMs;

    await regenerate(page, 0);
    const dialog = question(page, REGENERATE_QUESTION);
    await expect(dialog).toContainText('这之后还有 2 轮对话，会一并永久删除。');
    await expect(willLines(dialog)).toHaveText([RESTORE_A, TRASH_C]);
    await pressWhenSettled(dialog.getByRole('button', { name: '重新生成', exact: true }));

    await expectTurnEnded(page, REDONE_TEXT);
    expect(read(workspace, 'a.md')).toBe(A_REDONE);
    expect(read(workspace, 'b.md')).toBe(B_BEFORE);
    expect(fs.statSync(path.join(workspace, 'b.md')).mtimeMs).toBe(bWrittenAt);
    expect(has(workspace, 'c.md')).toBe(false);
  });

  test('redoing turn 1 of two that changed no files asks about the later turn only, with no option and no list; confirming runs turn 1 again and leaves the files alone', async () => {
    test.setTimeout(240_000);
    const { page, workspace } = await launch(() => [finalReply(FIRST_REPLY), finalReply(SECOND_REPLY), finalReply(REDONE_TEXT)]);
    await runTurn(page, FIRST_PROMPT, FIRST_REPLY, 0);
    await runTurn(page, SECOND_PROMPT, SECOND_REPLY, 0);

    await regenerate(page, 0);
    const dialog = question(page, REGENERATE_QUESTION);
    await expect(dialog).toContainText('这之后还有 1 轮对话，会一并永久删除。');
    await expect(restoreOption(dialog)).toHaveCount(0);
    await expect(dialog.getByTestId('redo-turn-will')).toHaveCount(0);
    await expect(dialog.getByTestId('redo-turn-wont')).toHaveCount(0);
    await shot(page, 'redo-2-f-question-later-turns-only');
    await pressWhenSettled(dialog.getByRole('button', { name: '取消', exact: true }));
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText(SECOND_REPLY, { exact: true })).toBeVisible();

    await regenerate(page, 0);
    const again = question(page, REGENERATE_QUESTION);
    await expect(again).toContainText('这之后还有 1 轮对话，会一并永久删除。');
    await pressWhenSettled(again.getByRole('button', { name: '重新生成', exact: true }));

    await expectTurnEnded(page, REDONE_TEXT);
    await expect(again).toHaveCount(0);
    await expect(userMessages(page, FIRST_PROMPT)).toHaveCount(1);
    await expect(userMessages(page, SECOND_PROMPT)).toHaveCount(0);
    for (const reply of [FIRST_REPLY, SECOND_REPLY]) {
      await expect(page.getByText(reply, { exact: true })).toHaveCount(0);
    }
    await expect(changedFilesCards(page)).toHaveCount(0);
    expect(read(workspace, 'a.md')).toBe(A_BEFORE);
    expect(read(workspace, 'b.md')).toBe(B_BEFORE);
  });
});

/** The `changes` folders of the conversations in the test's data root. */
function changesDirs(): string[] {
  const root = launched!.dataRoot.rootDir;
  return fs.readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((entry) => path.basename(entry) === 'changes' && fs.existsSync(path.join(root, entry, 'index.json')))
    .map((entry) => path.join(root, entry));
}

/** Restarts the app and opens the conversation again; `whileClosed` runs between the two. */
async function reopenConversation(whileClosed?: () => void): Promise<Page> {
  await closeAbuElectron(launched!.app);
  whileClosed?.();
  launched!.app = (await launchAbuElectron(launched!.dataRoot)).app;
  const reopened = await launched!.app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(reopened);
  // The right panel folded the sidebar away, and the project's tasks are folded after a restart.
  await reopened.getByRole('button', { name: '显示侧栏', exact: true }).click();
  await reopened.getByRole('group', { name: PROJECT_NAME })
    .getByRole('button', { name: PROJECT_NAME, exact: true })
    .click();
  await reopened.getByRole('button', { name: new RegExp(`^${PROMPT}`) }).click();
  await expect(reopened.getByText(FINAL_TEXT, { exact: true })).toBeVisible();
  return reopened;
}

test.describe('story 3: knowing before the redo which files cannot be restored', () => {
  test('a file a command changed is listed as not restored, with the reason, and keeps its content', async () => {
    test.setTimeout(240_000);
    const { page, workspace } = await launch(
      (folder) => [
        commandCall('call-change-contract', "printf 'second version' > 合同.docx"),
        editFileCall('call-edit-a', path.join(folder, 'a.md'), 'a 第一版', 'a 第二版'),
        finalReply(),
        finalReply(REDONE_TEXT),
      ],
      (folder) => {
        fs.writeFileSync(path.join(folder, 'a.md'), A_BEFORE);
        fs.writeFileSync(path.join(folder, '合同.docx'), 'v1');
      },
    );
    await runTurn(page, PROMPT, FINAL_TEXT, 1);

    await regenerate(page, 0);
    const dialog = question(page, REGENERATE_QUESTION);
    await expect(willLines(dialog)).toHaveText([RESTORE_A]);
    await expect(wontLines(dialog)).toHaveText(['合同.docx这份文件是用命令改动的，没有保存修改前的内容']);
    await shot(page, 'redo-2-e-not-restored-changed-by-command');
    await pressWhenSettled(dialog.getByRole('button', { name: '重新生成', exact: true }));

    await expectTurnEnded(page, REDONE_TEXT);
    expect(read(workspace, 'a.md')).toBe(A_BEFORE);
    expect(read(workspace, '合同.docx')).toBe('second version');
  });

  test('a file a later turn changed only with a command is in neither list, the option says command changes are not restored, and the file keeps its content', async () => {
    test.setTimeout(300_000);
    const byCommand = 'a 命令版\n';
    const { page, workspace } = await launch((folder) => [
      editFileCall('call-turn1-a', path.join(folder, 'a.md'), 'a 第一版', 'a 第二版'),
      editFileCall('call-turn1-b', path.join(folder, 'b.md'), 'b 第一版', 'b 第二版'),
      finalReply(FIRST_REPLY),
      commandCall('call-turn2-a', "printf 'a 命令版\\n' > a.md"),
      finalReply(SECOND_REPLY),
      finalReply(REDONE_TEXT),
    ]);
    await runTurn(page, FIRST_PROMPT, FIRST_REPLY, 1);
    await runTurn(page, SECOND_PROMPT, SECOND_REPLY, 2);
    expect(read(workspace, 'a.md')).toBe(byCommand);
    expect(read(workspace, 'b.md')).toBe(B_AFTER);

    await regenerate(page, 0);
    const dialog = question(page, REGENERATE_QUESTION);
    await expect(dialog).toContainText('这之后还有 1 轮对话，会一并永久删除。');
    await expect(restoreOption(dialog)).toBeChecked();
    await expect(willLines(dialog)).toHaveText([RESTORE_B]);
    await expect(dialog.getByTestId('redo-turn-wont')).toHaveCount(0);
    await expect(dialog.getByText(COMMAND_NOT_RESTORED, { exact: true })).toBeVisible();
    await expect(dialog).not.toContainText('a.md');
    await pressWhenSettled(dialog.getByRole('button', { name: '重新生成', exact: true }));

    await expectTurnEnded(page, REDONE_TEXT);
    await expect(dialog).toHaveCount(0);
    expect(read(workspace, 'a.md')).toBe(byCommand);
    expect(read(workspace, 'b.md')).toBe(B_BEFORE);
    await expect(userMessages(page, SECOND_PROMPT)).toHaveCount(0);
  });

  test('a file the user changed after the turn is listed as not restored, with the reason, and keeps its content', async () => {
    test.setTimeout(240_000);
    const mine = 'b 我自己改过的版本\n';
    const { page, workspace } = await launch(oneTurnThenRedo);
    await runTurn(page, PROMPT, FINAL_TEXT, 1);
    fs.writeFileSync(path.join(workspace, 'b.md'), mine);

    await regenerate(page, 0);
    const dialog = question(page, REGENERATE_QUESTION);
    await expect(willLines(dialog)).toHaveText([RESTORE_A, TRASH_C]);
    await expect(wontLines(dialog)).toHaveText(['b.md这份文件在这一轮之后又被改过']);
    await shot(page, 'redo-2-e-not-restored-changed-after');
    await pressWhenSettled(dialog.getByRole('button', { name: '重新生成', exact: true }));

    await expectTurnEnded(page, REDONE_TEXT);
    expect(read(workspace, 'b.md')).toBe(mine);
    expect(read(workspace, 'a.md')).toBe(A_BEFORE);
    expect(has(workspace, 'c.md')).toBe(false);
  });

  test('a file where Abu has no write authorization now is listed as not restored, with the reason, and keeps its content', async () => {
    test.setTimeout(240_000);
    const memo = '备忘一\n备忘二\n';
    const { page, workspace } = await launch(
      (folder) => [
        editFileCall('call-edit-a', path.join(folder, 'a.md'), 'a 第一版', 'a 第二版'),
        writeFileCall('call-write-memo', path.join(outsideFixtureDir!, '备忘.md'), memo),
        finalReply(),
        finalReply(REDONE_TEXT),
      ],
      (folder) => {
        fs.writeFileSync(path.join(folder, 'a.md'), A_BEFORE);
        outsideFixtureDir = fs.mkdtempSync(path.join(path.dirname(path.dirname(folder)), 'permission-'));
      },
    );
    const memoPath = path.join(outsideFixtureDir!, '备忘.md');
    await Promise.all([
      runTurn(page, PROMPT, FINAL_TEXT, 1),
      (async () => {
        const permission = page.getByRole('alertdialog', { name: '文件写入权限' });
        await expect(permission).toBeVisible({ timeout: READY_TIMEOUT });
        // The window asks for the folder, and offers the grant for good (the default) or until the app quits.
        await expect(permission).toContainText(path.dirname(memoPath).split(path.sep).join('/'));
        await pressWhenSettled(permission.getByRole('radio', { name: '直到关闭应用' }));
        await pressWhenSettled(permission.getByRole('button', { name: '允许到关闭应用', exact: true }));
        await expect(permission).toBeHidden();
      })(),
    ]);
    expect(fs.readFileSync(memoPath, 'utf8')).toBe(memo);
    const recordedMemoPath = fs.realpathSync(memoPath).split(path.sep).join('/');
    await changedFilesCards(page).getByRole('button', { name: /^已编辑 2 个文件/ }).click();
    await expect(page.locator('[role="tabpanel"]:not([hidden])').getByTestId('changes-tab')).toBeVisible();
    const reopened = await reopenConversation();

    await regenerate(reopened, 0);
    const dialog = question(reopened, REGENERATE_QUESTION);
    await expect(willLines(dialog)).toHaveText([RESTORE_A]);
    await expect(wontLines(dialog)).toHaveText([`${recordedMemoPath}阿布现在没有这个位置的写入授权`]);
    await shot(reopened, 'redo-2-e-not-restored-no-authorization');
    await pressWhenSettled(dialog.getByRole('button', { name: '重新生成', exact: true }));

    await expectTurnEnded(reopened, REDONE_TEXT);
    expect(read(workspace, 'a.md')).toBe(A_BEFORE);
    expect(fs.readFileSync(memoPath, 'utf8')).toBe(memo);
  });

  test('a turn whose undo record was trimmed asks nothing on 重新生成 and runs again', async () => {
    test.setTimeout(300_000);
    const { page, workspace } = await launch(oneTurnThenRedo);
    await runTurn(page, PROMPT, FINAL_TEXT, 1);
    // The changes tab opens the right panel, which is the state `reopenConversation` starts from.
    await changedFilesCards(page).getByRole('button', { name: /^已编辑 3 个文件/ }).click();
    await expect(page.locator('[role="tabpanel"]:not([hidden])').getByTestId('changes-tab')).toBeVisible();
    const [changes] = changesDirs();
    const turns = fs.readdirSync(changes).filter((name) => fs.existsSync(path.join(changes, name, 'undo.json')));
    expect(turns).toHaveLength(1);
    const [loopId] = turns;

    // What the copy limit of a conversation leaves of a turn it trims (turnChanges trimCopies):
    // no folder, and an index entry with the turn's totals only.
    const reopened = await reopenConversation(() => {
      fs.rmSync(path.join(changes, loopId), { recursive: true });
      const indexPath = path.join(changes, 'index.json');
      const index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as { turns: Record<string, Record<string, unknown>> };
      const { total, added, deleted, firstFile } = index.turns[loopId];
      index.turns[loopId] = { total, added, deleted, firstFile };
      fs.writeFileSync(indexPath, JSON.stringify(index));
    });
    await expect(changedFilesCards(reopened)).toHaveCount(1, { timeout: RECORD_TIMEOUT });
    await expect(changedFilesCards(reopened).getByRole('button', { name: '撤销', exact: true })).toHaveCount(0);

    await regenerate(reopened, 0);
    await expectTurnEnded(reopened, REDONE_TEXT);
    await expect(reopened.getByTestId('redo-turn-dialog')).toHaveCount(0);
    expect(read(workspace, 'a.md')).toBe(A_AFTER);
    expect(read(workspace, 'b.md')).toBe(B_AFTER);
    expect(read(workspace, 'c.md')).toBe(C_NEW);
  });

  test('a file that cannot be written stops the redo: a notice counts it, the conversation stays, and the card marks it as not restored', async () => {
    test.setTimeout(240_000);
    const { page, workspace } = await launch(oneTurnThenRedo);
    await runTurn(page, PROMPT, FINAL_TEXT, 1);
    const requestsBefore = turnRequests().length;
    fs.chmodSync(path.join(workspace, 'b.md'), 0o444);

    await regenerate(page, 0);
    const dialog = question(page, REGENERATE_QUESTION);
    await expect(willLines(dialog)).toHaveText([RESTORE_A, RESTORE_B, TRASH_C]);
    await pressWhenSettled(dialog.getByRole('button', { name: '重新生成', exact: true }));

    await expect(notices(page)).toHaveText([/已恢复 2 个，1 个没有恢复/]);
    await expect(dialog).toHaveCount(0);
    const card = changedFilesCards(page);
    await expect(card.getByRole('button', { name: /^已撤销 2 个文件的改动/ })).toBeVisible();
    await expect(card.getByRole('listitem').filter({ hasText: 'b.md' })).toContainText('没有恢复');
    await expect(page.getByText(FINAL_TEXT, { exact: true })).toBeVisible();
    await expect(userMessages(page, PROMPT)).toHaveCount(1);
    await expect(page.getByText(REDONE_TEXT, { exact: true })).toHaveCount(0);
    await shot(page, 'redo-5-j-notice-and-card-not-restored');
    expect(turnRequests()).toHaveLength(requestsBefore);
    expect(read(workspace, 'a.md')).toBe(A_BEFORE);
    expect(read(workspace, 'b.md')).toBe(B_AFTER);
    expect(has(workspace, 'c.md')).toBe(false);
  });

  test('a file that cannot be written stops an edited send and keeps the editor with the edited text', async () => {
    test.setTimeout(240_000);
    const { page, workspace } = await launch(oneTurnThenRedo);
    await runTurn(page, PROMPT, FINAL_TEXT, 1);
    const requestsBefore = turnRequests().length;
    fs.chmodSync(path.join(workspace, 'b.md'), 0o444);

    await editAndSend(page, PROMPT, EDITED_PROMPT);
    await pressWhenSettled(question(page, EDIT_QUESTION).getByRole('button', { name: '发送', exact: true }));

    await expect(notices(page)).toHaveText([/已恢复 2 个，1 个没有恢复/]);
    await expect(page.getByTestId('redo-turn-dialog')).toHaveCount(0);
    await expect(editor(page)).toHaveValue(EDITED_PROMPT);
    const card = changedFilesCards(page);
    await expect(card.getByRole('button', { name: /^已撤销 2 个文件的改动/ })).toBeVisible();
    await expect(card.getByRole('listitem').filter({ hasText: 'b.md' })).toContainText('没有恢复');
    await expect(page.getByText(FINAL_TEXT, { exact: true })).toBeVisible();
    expect(turnRequests()).toHaveLength(requestsBefore);
    expect(read(workspace, 'a.md')).toBe(A_BEFORE);
    expect(read(workspace, 'b.md')).toBe(B_AFTER);
    expect(has(workspace, 'c.md')).toBe(false);
  });
});
