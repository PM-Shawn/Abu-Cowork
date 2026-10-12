/**
 * Real-Electron acceptance for what the user sees of the files a turn changes:
 * the line counts and the diff on a step of the work process, the card under
 * the reply that lists the turn's changed files, and the changes tab of the
 * right panel that compares them.
 *
 * A loopback model scripts each turn with file tools and commands. Every case
 * runs in a project whose folder sits in the test's own data root. The card
 * appears once the turn's record is saved, which happens after the reply; every
 * wait here is an assertion that retries.
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

const PROJECT_NAME = 'E2E 文件改动';
const PROMPT = '请修改方案';
const FINAL_TEXT = '已经改好了。';
const REPLY_TIMEOUT = 60_000;
const RECORD_TIMEOUT = 30_000;

const PLAN_BEFORE = [
  '# 方案', '', '第一行', '第二行', '第三行', '目标甲', '目标乙', '目标丙', '第七行', '第八行', '第九行', '',
].join('\n');
const PLAN_GOALS_BEFORE = '目标甲\n目标乙\n目标丙';
const PLAN_GOALS_AFTER = '目标一\n目标二\n目标三';

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

function finalReply(text = FINAL_TEXT): MockReplyPlan {
  return { kind: 'complete', responseText: text };
}

/**
 * Launch the app with a project whose folder is `workspace`, the loopback
 * model answering with `plans` in order, and a new task open in that project.
 */
async function launchInProject(
  plansFor: (workspace: string) => MockReplyPlan[],
  seed: (workspace: string) => void = () => {},
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
          'project-changes': {
            id: 'project-changes', name, workspacePath, pinned: false, archived: false,
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

/** Send a prompt and wait until its turn has ended: the reply is there and the work process has folded. */
async function runTurn(page: Page, prompt = PROMPT, finalText = FINAL_TEXT): Promise<void> {
  const composer = page.getByPlaceholder(CHAT_PLACEHOLDER);
  await composer.fill(prompt);
  await composer.press('Enter');
  await expect(page.getByText(finalText)).toBeVisible({ timeout: REPLY_TIMEOUT });
  await expect(page.getByRole('button', { name: /^用时/ }).last()).toBeVisible({ timeout: REPLY_TIMEOUT });
}

/** Unfold the work process of the turn and its group of steps, so every step row is on the page. */
async function showSteps(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^用时/ }).first().click();
  const group = page.getByRole('button', { name: /^(修改了|创建了|读取了|执行了|调用了)/ }).first();
  await expect(group).toBeVisible();
  if ((await group.getAttribute('aria-expanded')) === 'false') await group.click();
}

function changedFilesCards(page: Page): Locator {
  return page.getByTestId('changed-files-card');
}

function cardRows(card: Locator): Locator {
  return card.getByRole('listitem');
}

/** The tab panel in view. */
function panel(page: Page): Locator {
  return page.locator('[role="tabpanel"]:not([hidden])');
}

function changesTab(page: Page): Locator {
  return panel(page).getByTestId('changes-tab');
}

function fileListRow(page: Page, name: RegExp): Locator {
  return changesTab(page).getByRole('list').getByRole('button', { name });
}

function comparison(page: Page): Locator {
  return changesTab(page).getByTestId('changes-diff');
}

/** Rows of the diff a step of the work process shows, which sits in the conversation and not in a tab panel. */
function stepDiffRows(page: Page, kind?: 'added' | 'deleted' | 'context'): Locator {
  return page.locator(kind ? `[data-diff-row="${kind}"]` : '[data-diff-row]')
    .and(page.locator(':not([role="tabpanel"] *)'));
}

function findLedgers(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return findLedgers(entryPath);
    return entry.name === 'messages.jsonl' ? [entryPath] : [];
  });
}

/**
 * What the conversation record on disk holds of one turn: the run state of the
 * user message with `prompt`, and whether an assistant message carries `reply`.
 * Each message counts as its last ledger revision has it.
 */
function turnOnDisk(rootDir: string, prompt: string, reply: string): { runState: string | null; replySaved: boolean } {
  const rows = new Map<string, { role?: string; content?: unknown; runState?: string }>();
  for (const ledger of findLedgers(rootDir)) {
    for (const line of fs.readFileSync(ledger, 'utf8').split('\n')) {
      if (!line) continue;
      const row = JSON.parse(line) as { id?: string; role?: string; content?: unknown; runState?: string };
      if (row.id) rows.set(row.id, row);
    }
  }
  const saved = [...rows.values()];
  return {
    runState: saved.find((row) => row.role === 'user' && row.content === prompt)?.runState ?? null,
    replySaved: saved.some((row) => row.role === 'assistant' && JSON.stringify(row.content).includes(reply)),
  };
}

async function reopenConversation(prompt = PROMPT): Promise<Page> {
  await closeAbuElectron(app!);
  app = (await launchAbuElectron(dataRoot!)).app;
  const reopened = await app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(reopened);
  // The right panel folded the sidebar away, and the project's tasks are folded after a restart.
  await reopened.getByRole('button', { name: '显示侧栏', exact: true }).click();
  await reopened.getByRole('group', { name: PROJECT_NAME })
    .getByRole('button', { name: PROJECT_NAME, exact: true })
    .click();
  await reopened.getByRole('button', { name: new RegExp(`^${prompt}`) }).click();
  await expect(reopened.getByText(FINAL_TEXT)).toBeVisible();
  return reopened;
}

test('a turn that edits two files and creates one shows the line counts on each step, the diff, and one card with a row per file, also after a restart', async () => {
  test.setTimeout(240_000);
  const { page, workspace } = await launchInProject(
    (folder) => [
      editFileCall('call-edit-plan', path.join(folder, '方案.md'), PLAN_GOALS_BEFORE, PLAN_GOALS_AFTER),
      editFileCall('call-edit-budget', path.join(folder, '预算.md'), '合计 100', '合计 120\n备注 已复核'),
      writeFileCall('call-write-outline', path.join(folder, '提纲.md'), '一、背景\n二、目标\n'),
      finalReply(),
    ],
    (folder) => {
      fs.writeFileSync(path.join(folder, '方案.md'), PLAN_BEFORE);
      fs.writeFileSync(path.join(folder, '预算.md'), '# 预算\n\n合计 100\n');
    },
  );

  await runTurn(page);
  expect(fs.readFileSync(path.join(workspace, '方案.md'), 'utf8')).toContain(PLAN_GOALS_AFTER);

  // Story 1: the step of an edit shows the file name and its line counts.
  await showSteps(page);
  const planCounts = page.getByRole('button', { name: '+3 −3', exact: true });
  await expect(planCounts).toBeVisible();
  await expect(planCounts).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: '在右侧预览 方案.md', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '+2 −1', exact: true })).toBeVisible();
  // A new file shows the lines it was created with.
  const outlineCounts = page.getByRole('button', { name: '+2 −0', exact: true });
  await expect(outlineCounts).toBeVisible();
  await expect(page.getByRole('button', { name: '在右侧预览 提纲.md', exact: true })).toBeVisible();

  // The diff of three changed lines with three lines of text around them is twelve rows:
  // five and four are shown until the rest is asked for.
  await planCounts.click();
  await expect(planCounts).toHaveAttribute('aria-expanded', 'true');
  await expect(stepDiffRows(page)).toHaveCount(9);
  const showAll = page.getByRole('button', { name: '显示全部 12 行', exact: true });
  await showAll.click();
  await expect(stepDiffRows(page)).toHaveCount(12);
  await expect(stepDiffRows(page, 'deleted')).toHaveText([/目标甲$/, /目标乙$/, /目标丙$/]);
  await expect(stepDiffRows(page, 'added')).toHaveText([/目标一$/, /目标二$/, /目标三$/]);
  await expect(stepDiffRows(page, 'context')).toHaveText([/第一行$/, /第二行$/, /第三行$/, /第七行$/, /第八行$/, /第九行$/]);
  await planCounts.click();
  await expect(stepDiffRows(page)).toHaveCount(0);

  await outlineCounts.click();
  await expect(stepDiffRows(page, 'added')).toHaveText([/一、背景$/, /二、目标$/]);
  await outlineCounts.click();

  // Story 2: one card under the reply, titled by the number of files, with the turn's totals.
  const card = changedFilesCards(page);
  await expect(card).toHaveCount(1, { timeout: RECORD_TIMEOUT });
  const title = card.getByRole('button', { name: /^已编辑 3 个文件/ });
  await expect(title).toContainText('+7');
  await expect(title).toContainText('−4');
  await expect(cardRows(card)).toHaveText(['提纲.md+2−0', '方案.md+3−3', '预算.md+2−1']);
  await expect(card.getByRole('button', { name: /全部/ })).toHaveCount(0);

  // The file name on a step opens the file in the side preview.
  await page.getByRole('button', { name: '在右侧预览 方案.md', exact: true }).click();
  await expect(page.getByRole('tab', { name: '方案.md', exact: true })).toBeVisible();
  await expect(panel(page)).toContainText('目标一');

  // Story 3: a row opens the changes tab on its file.
  await card.getByRole('button', { name: /^预算\.md/ }).click();
  await expect(page.getByRole('tab', { name: '改动：提纲.md 等 3 个文件', exact: true })).toBeVisible();
  await expect(fileListRow(page, /^预算\.md/)).toHaveAttribute('aria-current', 'true');
  await expect(comparison(page)).toContainText('合计 100');
  await expect(comparison(page)).toContainText('备注 已复核');

  // After a restart the card and the comparison are still there.
  const reopened = await reopenConversation();
  const reopenedCard = changedFilesCards(reopened);
  await expect(reopenedCard).toHaveCount(1, { timeout: RECORD_TIMEOUT });
  await expect(cardRows(reopenedCard)).toHaveText(['提纲.md+2−0', '方案.md+3−3', '预算.md+2−1']);
  await reopenedCard.getByRole('button', { name: /^方案\.md/ }).click();
  await expect(fileListRow(reopened, /^方案\.md/)).toHaveAttribute('aria-current', 'true');
  await expect(comparison(reopened)).toContainText('目标甲');
  await expect(comparison(reopened)).toContainText('目标一');
  // The step keeps its line counts and its diff as well.
  await showSteps(reopened);
  const reopenedCounts = reopened.getByRole('button', { name: '+3 −3', exact: true });
  await reopenedCounts.click();
  await expect(stepDiffRows(reopened)).toHaveCount(9);
});

test('a turn that changed one file titles its card by the file name, compares the start of the turn with its end, and a turn without changes has no card', async () => {
  test.setTimeout(200_000);
  const secondPrompt = '这份方案怎么样';
  const secondReply = '结构清楚，可以继续。';
  const { page } = await launchInProject(
    (folder) => [
      editFileCall('call-edit-1', path.join(folder, '方案.md'), '目标甲', '目标中间稿'),
      editFileCall('call-edit-2', path.join(folder, '方案.md'), '目标中间稿', '目标定稿'),
      finalReply(),
      finalReply(secondReply),
    ],
    (folder) => fs.writeFileSync(path.join(folder, '方案.md'), PLAN_BEFORE),
  );

  await runTurn(page);

  const card = changedFilesCards(page);
  await expect(card).toHaveCount(1, { timeout: RECORD_TIMEOUT });
  const title = card.getByRole('button', { name: /^已编辑 方案\.md/ });
  await expect(title).toContainText('+1');
  await expect(title).toContainText('−1');
  // One file: the title alone, no rows.
  await expect(cardRows(card)).toHaveCount(0);

  // The title opens the changes tab on the first file.
  await title.click();
  await expect(page.getByRole('tab', { name: '改动：方案.md', exact: true })).toBeVisible();
  await expect(fileListRow(page, /^方案\.md/)).toHaveAttribute('aria-current', 'true');
  // Edited twice in the turn: the comparison is between the start of the turn and its end.
  await expect(comparison(page)).toContainText('目标甲');
  await expect(comparison(page)).toContainText('目标定稿');
  await expect(comparison(page)).not.toContainText('目标中间稿');

  // A second turn that changes nothing adds no card.
  const composer = page.getByPlaceholder(CHAT_PLACEHOLDER);
  await composer.fill(secondPrompt);
  await composer.press('Enter');
  await expect(page.getByText(secondReply)).toBeVisible({ timeout: REPLY_TIMEOUT });
  // The reply is on the page before its turn has ended and been saved; the
  // restart reads the record, so it waits for the record to hold the finished turn.
  await expect
    .poll(() => turnOnDisk(dataRoot!.rootDir, secondPrompt, secondReply), { timeout: RECORD_TIMEOUT })
    .toEqual({ runState: 'completed', replySaved: true });
  // Read from disk again, the conversation still has the one card, and it sits above the second reply.
  const reopened = await reopenConversation(PROMPT);
  await expect(reopened.getByText(secondReply)).toBeVisible();
  await expect(changedFilesCards(reopened)).toHaveCount(1, { timeout: RECORD_TIMEOUT });
  await expect(changedFilesCards(reopened).getByRole('button', { name: /^已编辑 方案\.md/ })).toBeVisible();
  const cardAboveSecondReply = await reopened.evaluate((replyText) => {
    const card = document.querySelector('[data-testid="changed-files-card"]');
    const reply = [...document.querySelectorAll('p')].find((node) => node.textContent === replyText);
    return card !== null && reply !== undefined
      && (card.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  }, secondReply);
  expect(cardAboveSecondReply).toBe(true);
});

test('a turn that changed more than four files shows four rows until all are asked for, a deleted file as +0 and its lines, and says when a saved diff is cut', async () => {
  test.setTimeout(200_000);
  const longList = Array.from({ length: 450 }, (_, index) => `第 ${index + 1} 项`).join('\n') + '\n';
  const { page, workspace } = await launchInProject(
    (folder) => [
      writeFileCall('call-write-a', path.join(folder, 'a.md'), 'a\n'),
      writeFileCall('call-write-b', path.join(folder, 'b.md'), 'b\n'),
      writeFileCall('call-write-c', path.join(folder, 'c.md'), 'c\n'),
      writeFileCall('call-write-d', path.join(folder, 'd.md'), 'd\n'),
      writeFileCall('call-write-long', path.join(folder, 'e-清单.md'), longList),
      deleteFileCall('call-delete-draft', path.join(folder, '草稿.md')),
      finalReply(),
    ],
    (folder) => fs.writeFileSync(path.join(folder, '草稿.md'), '草稿一\n草稿二\n草稿三\n'),
  );

  await runTurn(page);
  expect(fs.existsSync(path.join(workspace, '草稿.md'))).toBe(false);

  const card = changedFilesCards(page);
  await expect(card).toHaveCount(1, { timeout: RECORD_TIMEOUT });
  await expect(card.getByRole('button', { name: /^已编辑 6 个文件/ })).toBeVisible();
  await expect(cardRows(card)).toHaveText(['a.md+1−0', 'b.md+1−0', 'c.md+1−0', 'd.md+1−0']);

  const expand = card.getByRole('button', { name: '全部 6 个文件', exact: true });
  await expect(expand).toHaveAttribute('aria-expanded', 'false');
  await expand.click();
  await expect(cardRows(card)).toHaveText([
    'a.md+1−0', 'b.md+1−0', 'c.md+1−0', 'd.md+1−0', 'e-清单.md+450−0', '草稿.md+0−3',
  ]);
  const collapse = card.getByRole('button', { name: '收起', exact: true });
  await expect(collapse).toHaveAttribute('aria-expanded', 'true');
  await collapse.click();
  await expect(cardRows(card)).toHaveCount(4);

  // The step that wrote 450 lines keeps the first 400 of its diff and says so once all are shown.
  await showSteps(page);
  const longCounts = page.getByRole('button', { name: '+450 −0', exact: true });
  await longCounts.click();
  await expect(stepDiffRows(page)).toHaveCount(9);
  await expect(page.getByText('对比过长，只显示前面的部分')).toHaveCount(0);
  await page.getByRole('button', { name: '显示全部 400 行', exact: true }).click();
  await expect(stepDiffRows(page)).toHaveCount(400);
  await expect(page.getByText('对比过长，只显示前面的部分')).toBeVisible();
});

test('files a command created, modified and deleted are listed by status after the presented file cards, and the changes tab switches files and layouts', async () => {
  test.setTimeout(200_000);
  const { page, workspace } = await launchInProject(
    (folder) => [
      commandCall('call-make-sheet', "printf 'sheet' > 报表.xlsx"),
      commandCall('call-change-contract', "printf 'second version' > 合同.docx"),
      commandCall('call-remove-draft', 'unlink 旧稿.md'),
      editFileCall('call-edit-plan', path.join(folder, '方案.md'), '目标甲', '目标一'),
      { kind: 'tool-call', toolCallId: 'call-present', toolName: 'present_files', arguments: { files: [{ path: '方案.md', description: '改好的方案' }] } },
      finalReply(),
    ],
    (folder) => {
      fs.writeFileSync(path.join(folder, '方案.md'), PLAN_BEFORE);
      fs.writeFileSync(path.join(folder, '合同.docx'), 'v1');
      fs.writeFileSync(path.join(folder, '旧稿.md'), '旧稿\n');
    },
  );

  await runTurn(page);
  expect(fs.readFileSync(path.join(workspace, '报表.xlsx'), 'utf8')).toBe('sheet');
  expect(fs.readFileSync(path.join(workspace, '合同.docx'), 'utf8')).toBe('second version');
  expect(fs.existsSync(path.join(workspace, '旧稿.md'))).toBe(false);

  const card = changedFilesCards(page);
  await expect(card).toHaveCount(1, { timeout: RECORD_TIMEOUT });
  const title = card.getByRole('button', { name: /^已编辑 4 个文件/ });
  await expect(title).toContainText('+1');
  await expect(title).toContainText('−1');
  await expect(cardRows(card)).toHaveText(['合同.docx已修改', '报表.xlsx新建', '方案.md+1−1', '旧稿.md已删除']);

  // The card of the presented file comes first, the changed-files card after it.
  const presentedFirst = await page.evaluate(() => {
    const presented = document.querySelector('[title="点击预览"]');
    const changed = document.querySelector('[data-testid="changed-files-card"]');
    return presented !== null && changed !== null
      && (presented.compareDocumentPosition(changed) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  });
  expect(presentedFirst).toBe(true);

  // A row of a file without line counts opens the tab on that file: nothing to compare, and it can still be opened.
  await card.getByRole('button', { name: /^报表\.xlsx/ }).click();
  const tab = page.getByRole('tab', { name: '改动：合同.docx 等 4 个文件', exact: true });
  await expect(tab).toBeVisible();
  await expect(changesTab(page).getByRole('list').getByRole('listitem')).toHaveText([
    '合同.docx已修改', '报表.xlsx新建', '方案.md+1−1', '旧稿.md已删除',
  ]);
  await expect(fileListRow(page, /^报表\.xlsx/)).toHaveAttribute('aria-current', 'true');
  await expect(changesTab(page).getByText('这份文件没有可以显示的对比')).toBeVisible();
  await expect(changesTab(page).getByTestId('changes-diff')).toHaveCount(0);
  await changesTab(page).getByRole('button', { name: '打开文件', exact: true }).click();
  await expect(page.getByRole('tab', { name: '报表.xlsx', exact: true })).toHaveAttribute('aria-selected', 'true');

  // Back in the changes tab, another file is chosen from the list.
  await tab.click();
  await fileListRow(page, /^方案\.md/).click();
  await expect(fileListRow(page, /^方案\.md/)).toHaveAttribute('aria-current', 'true');
  await expect(fileListRow(page, /^报表\.xlsx/)).not.toHaveAttribute('aria-current', 'true');
  await expect(comparison(page)).toContainText('目标甲');
  await expect(comparison(page)).toContainText('目标一');

  // One column: before above after. Side by side: before on the left, after on the right.
  await changesTab(page).getByRole('radio', { name: '单栏', exact: true }).click();
  await expect(comparison(page)).toHaveAttribute('data-diff-layout', 'unified');
  await expect(comparison(page).locator('[data-diff-pair]')).toHaveCount(0);
  await expect(comparison(page).locator('[data-diff-row="deleted"]')).toHaveText([/目标甲$/]);
  await expect(comparison(page).locator('[data-diff-row="added"]')).toHaveText([/目标一$/]);
  await changesTab(page).getByRole('radio', { name: '左右对照', exact: true }).click();
  await expect(comparison(page)).toHaveAttribute('data-diff-layout', 'split');
  const changedPair = comparison(page).locator('[data-diff-pair]').filter({ hasText: '目标甲' });
  await expect(changedPair.locator('[data-diff-side="before"]')).toContainText('目标甲');
  await expect(changedPair.locator('[data-diff-side="after"]')).toContainText('目标一');
  const sides = await changedPair.evaluate((pair) => {
    const before = pair.querySelector('[data-diff-side="before"]')!.getBoundingClientRect();
    const after = pair.querySelector('[data-diff-side="after"]')!.getBoundingClientRect();
    return { beforeLeftOfAfter: before.right <= after.left + 1, sameRow: Math.abs(before.top - after.top) < 1 };
  });
  expect(sides).toEqual({ beforeLeftOfAfter: true, sameRow: true });

  // The title of the card returns to the same tab, on the first file.
  await title.click();
  await expect(page.getByRole('tab', { name: /^改动：/ })).toHaveCount(1);
  await expect(fileListRow(page, /^合同\.docx/)).toHaveAttribute('aria-current', 'true');
  await expect(changesTab(page).getByText('这份文件没有可以显示的对比')).toBeVisible();
});
