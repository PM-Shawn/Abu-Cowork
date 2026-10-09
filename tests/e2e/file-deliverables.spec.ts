/**
 * Real-Electron acceptance for the file cards under a reply.
 *
 * The cards of a turn are the files the agent presented with `present_files`
 * that are on disk when the cards are shown. A loopback model scripts each
 * turn: file tools, `present_files`, then the final reply. Every case runs in
 * a project whose folder sits in the test's own data root.
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
  taskRequests,
  waitForApp,
  type MockReplyPlan,
  type OpenAiMock,
} from './openAiMock';
import { persistedStoreVersion } from './storeVersions';

const PROJECT_NAME = 'E2E 交付文件';
const PROMPT = '请写一份季度报告';
const FINAL_TEXT = '报告已经写好。';
const REPLY_TIMEOUT = 60_000;

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;
let mock: OpenAiMock | undefined;

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

function presentFilesCall(id: string, files: { path: string; description?: string }[]): MockReplyPlan {
  return { kind: 'tool-call', toolCallId: id, toolName: 'present_files', arguments: { files } };
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
): Promise<{ page: Page; workspace: string; mock: OpenAiMock }> {
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
          'project-files': {
            id: 'project-files', name, workspacePath, pinned: false, archived: false,
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
  return { page, workspace, mock: startedMock };
}

/** Send the prompt and wait until the turn has ended: its work process then folds under "用时". */
async function runTurn(page: Page, finalText = FINAL_TEXT): Promise<void> {
  const composer = page.getByPlaceholder(CHAT_PLACEHOLDER);
  await composer.fill(PROMPT);
  await composer.press('Enter');
  await expect(page.getByText(finalText)).toBeVisible({ timeout: REPLY_TIMEOUT });
  await expect(workProcessToggle(page)).toBeVisible({ timeout: REPLY_TIMEOUT });
}

function workProcessToggle(page: Page): Locator {
  return page.getByRole('button', { name: /^用时/ }).first();
}

/** A file card is the button that opens the file in the side preview. */
function fileCards(page: Page): Locator {
  return page.getByRole('button').and(page.getByTitle('点击预览', { exact: true }));
}

function cardOf(page: Page, fileName: string): Locator {
  return fileCards(page).filter({ has: page.getByTitle(fileName, { exact: true }) });
}

async function regainWindowFocus(page: Page): Promise<void> {
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); });
}

/** The tool results the model was sent with its latest request, in order. */
function toolResultsOfLastRequest(startedMock: OpenAiMock): string[] {
  const body = taskRequests(startedMock).at(-1)?.body as { messages?: { role?: string; content?: unknown }[] };
  return (body.messages ?? [])
    .filter((message) => message.role === 'tool')
    .map((message) => String(message.content));
}

function findLedgers(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return findLedgers(entryPath);
    return entry.name === 'messages.jsonl' ? [entryPath] : [];
  });
}

/** `fileCards` of each assistant message as its last ledger revision has it, keyed by message id. */
function persistedFileCardMarkers(rootDir: string): Record<string, unknown> {
  const markers: Record<string, unknown> = {};
  for (const ledger of findLedgers(rootDir)) {
    for (const line of fs.readFileSync(ledger, 'utf8').split('\n')) {
      if (!line) continue;
      const row = JSON.parse(line) as { id?: string; role?: string; fileCards?: unknown };
      if (row.role === 'assistant' && row.id) markers[row.id] = row.fileCards ?? null;
    }
  }
  return markers;
}

const reportTurn = (workspace: string): MockReplyPlan[] => [
  writeFileCall('call-write-report', path.join(workspace, 'report.md'), '# 季度报告\n\n营收增长。\n'),
  writeFileCall('call-write-script', path.join(workspace, 'build.py'), 'print("build")\n'),
  presentFilesCall('call-present', [{ path: 'report.md', description: '季度报告' }]),
  finalReply(),
];

test('a presented file gets a card with its description, and a file that was only written gets none', async () => {
  test.setTimeout(150_000);
  const { page, workspace, mock: startedMock } = await launchInProject(reportTurn);

  await runTurn(page);

  expect(fs.existsSync(path.join(workspace, 'report.md'))).toBe(true);
  expect(fs.existsSync(path.join(workspace, 'build.py'))).toBe(true);
  // The relative path was resolved against the project folder and accepted.
  expect(toolResultsOfLastRequest(startedMock).at(-1)).toBe(`Presented ${path.join(workspace, 'report.md')}`);

  await expect(fileCards(page)).toHaveCount(1);
  const card = cardOf(page, 'report.md');
  await expect(card).toBeVisible();
  await expect(card).toContainText('季度报告');
  await expect(page.getByTitle('build.py', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '在文件夹中显示', exact: true })).toBeVisible();

  // The side preview opens the presented file by itself once the turn ends.
  await expect(page.getByRole('tab', { name: 'report.md', exact: true })).toBeVisible();

  // The work process lists the presentation as a row of its group of steps;
  // the row's result names the file.
  await workProcessToggle(page).click();
  await page.getByRole('button', { name: /^修改了 2 个文件/ }).click();
  const presentedRow = page.getByText('交付了 1 个文件', { exact: true }).locator('xpath=..');
  await expect(presentedRow).toBeVisible();
  await presentedRow.getByRole('button', { name: '结果', exact: true }).click();
  await expect(presentedRow).toContainText('report.md');
});

test('presenting a file that does not exist shows no card and tells the model why', async () => {
  test.setTimeout(150_000);
  const { page, mock: startedMock } = await launchInProject(() => [
    presentFilesCall('call-present-missing', [{ path: 'missing.md' }]),
    finalReply(),
  ]);

  await runTurn(page);

  const results = toolResultsOfLastRequest(startedMock);
  expect(results).toHaveLength(1);
  expect(results[0]).toMatch(/^Error: 没有交付任何文件。/);
  expect(results[0]).toContain('missing.md');
  expect(results[0]).toContain('找不到文件');
  await expect(fileCards(page)).toHaveCount(0);
  await expect(page.getByTitle('missing.md', { exact: true })).toHaveCount(0);
});

test('a turn that writes a file and presents nothing shows no file card', async () => {
  test.setTimeout(150_000);
  const { page, workspace } = await launchInProject((folder) => [
    writeFileCall('call-write-draft', path.join(folder, 'draft.md'), '# 草稿\n'),
    finalReply(),
  ]);

  await runTurn(page);

  expect(fs.existsSync(path.join(workspace, 'draft.md'))).toBe(true);
  await expect(fileCards(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: '在文件夹中显示', exact: true })).toHaveCount(0);
});

test('a card leaves when its file is moved away and returns when the file is back', async () => {
  test.setTimeout(150_000);
  const { page, workspace } = await launchInProject(reportTurn);
  const reportPath = path.join(workspace, 'report.md');
  const movedPath = path.join(workspace, 'moved-report.md');

  await runTurn(page);
  await expect(cardOf(page, 'report.md')).toBeVisible();

  fs.renameSync(reportPath, movedPath);
  await regainWindowFocus(page);
  await expect(fileCards(page)).toHaveCount(0);

  fs.renameSync(movedPath, reportPath);
  await regainWindowFocus(page);
  await expect(cardOf(page, 'report.md')).toBeVisible();
  await expect(fileCards(page)).toHaveCount(1);

  // Looking at the conversation again after a restart, with the file moved
  // away meanwhile: the card stays off until the file is back.
  await closeAbuElectron(app!);
  // Every assistant message of the turn (three tool steps and the reply) is
  // on disk as a message whose cards come from what was presented.
  const markers = Object.values(persistedFileCardMarkers(dataRoot!.rootDir));
  expect(markers).toHaveLength(4);
  expect(markers.every((marker) => marker === 'declared')).toBe(true);
  fs.renameSync(reportPath, movedPath);
  app = (await launchAbuElectron(dataRoot!)).app;
  const reopened = await app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(reopened);
  // The side preview folded the sidebar away, and the project's tasks are folded after a restart.
  await reopened.getByRole('button', { name: '显示侧栏', exact: true }).click();
  await reopened.getByRole('group', { name: PROJECT_NAME })
    .getByRole('button', { name: PROJECT_NAME, exact: true })
    .click();
  await reopened.getByRole('button', { name: new RegExp(`^${PROMPT}`) }).click();
  await expect(reopened.getByText(FINAL_TEXT)).toBeVisible();
  await expect(workProcessToggle(reopened)).toBeVisible();
  await expect(fileCards(reopened)).toHaveCount(0);

  fs.renameSync(movedPath, reportPath);
  await regainWindowFocus(reopened);
  await expect(cardOf(reopened, 'report.md')).toBeVisible();
  await expect(cardOf(reopened, 'report.md')).toContainText('季度报告');
  await expect(fileCards(reopened)).toHaveCount(1);
});

test('a turn the user hands to an expert shows the card of the file the expert presented', async () => {
  test.setTimeout(180_000);
  const expertPrompt = '@产品经理 请写一份调研结论';
  const expertReply = '结论写在 `调研结论.md` 里。';
  const { page, workspace, mock: startedMock } = await launchInProject((folder) => [
    writeFileCall('call-expert-write', path.join(folder, '调研结论.md'), '# 调研结论\n\n用户更看重速度。\n'),
    presentFilesCall('call-expert-present', [{ path: '调研结论.md', description: '给团队看的结论' }]),
    finalReply(expertReply),
  ]);

  // The message field is found by its mark: once it holds text it shows no placeholder.
  const composer = page.locator('[data-chat-composer]').first();
  await composer.fill(expertPrompt);
  await composer.press('Enter');
  const mention = page.getByRole('button', { name: '在右侧预览 调研结论.md', exact: true });
  await expect(mention).toBeVisible({ timeout: REPLY_TIMEOUT });

  // The expert ran the turn: its model calls carried present_files, and the
  // relative path was resolved against the project folder.
  const firstRequest = taskRequests(startedMock)[0]?.body as {
    messages?: { role?: string; content?: unknown }[];
    tools?: { function?: { name?: string } }[];
  };
  const expertSystemPrompt = String(firstRequest.messages?.find((message) => message.role === 'system')?.content);
  expect(expertSystemPrompt).toContain('## Handing Files to the User');
  const offeredTools = (firstRequest.tools ?? []).map((tool) => tool.function?.name);
  expect(offeredTools).toContain('present_files');
  expect(offeredTools).not.toContain('delegate_to_agent');
  expect(toolResultsOfLastRequest(startedMock).at(-1)).toBe(`Presented ${path.join(workspace, '调研结论.md')}`);

  await expect(fileCards(page)).toHaveCount(1);
  const card = cardOf(page, '调研结论.md');
  await expect(card).toBeVisible();
  await expect(card).toContainText('给团队看的结论');
  await expect(page.getByRole('tab', { name: '调研结论.md', exact: true })).toBeVisible();

  // The card and the file name are read from the conversation record, so they
  // are there again after a restart.
  await closeAbuElectron(app!);
  app = (await launchAbuElectron(dataRoot!)).app;
  const reopened = await app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(reopened);
  await reopened.getByRole('button', { name: '显示侧栏', exact: true }).click();
  await reopened.getByRole('group', { name: PROJECT_NAME })
    .getByRole('button', { name: PROJECT_NAME, exact: true })
    .click();
  await reopened.getByRole('button', { name: /请写一份调研结论/ }).click();
  await expect(reopened.getByRole('button', { name: '在右侧预览 调研结论.md', exact: true })).toBeVisible();
  await expect(cardOf(reopened, '调研结论.md')).toContainText('给团队看的结论');
  await expect(fileCards(reopened)).toHaveCount(1);
});

test('six presented files show four cards until all of them are asked for', async () => {
  test.setTimeout(150_000);
  const names = [1, 2, 3, 4, 5, 6].map((index) => `chapter-${index}.md`);
  const { page } = await launchInProject(
    () => [presentFilesCall('call-present-six', names.map((name) => ({ path: name }))), finalReply()],
    (workspace) => {
      for (const name of names) fs.writeFileSync(path.join(workspace, name), `# ${name}\n`);
    },
  );

  await runTurn(page);

  const expand = page.getByRole('button', { name: '全部 6 个文件', exact: true });
  await expect(expand).toBeVisible();
  await expect(fileCards(page)).toHaveCount(4);
  await expect(cardOf(page, 'chapter-4.md')).toBeVisible();
  await expect(cardOf(page, 'chapter-5.md')).toHaveCount(0);

  await expand.click();
  await expect(fileCards(page)).toHaveCount(6);
  await expect(cardOf(page, 'chapter-6.md')).toBeVisible();
  await expect(page.getByRole('button', { name: '收起', exact: true })).toBeVisible();
  await expect(expand).toHaveCount(0);
});

test('a file name in the reply opens the file the turn wrote in the side preview', async () => {
  test.setTimeout(150_000);
  const replyText = '内容写在 `report.md` 里，`other.md` 没有改动。';
  const { page } = await launchInProject((workspace) => [
    writeFileCall('call-write-report', path.join(workspace, 'report.md'), '# 季度报告\n\n营收增长。\n'),
    finalReply(replyText),
  ]);

  const composer = page.getByPlaceholder(CHAT_PLACEHOLDER);
  await composer.fill(PROMPT);
  await composer.press('Enter');
  const mention = page.getByRole('button', { name: '在右侧预览 report.md', exact: true });
  await expect(mention).toBeVisible({ timeout: REPLY_TIMEOUT });
  await expect(workProcessToggle(page)).toBeVisible({ timeout: REPLY_TIMEOUT });

  await expect(mention).toHaveText('report.md');
  await expect(page.getByRole('button', { name: '在右侧预览 other.md', exact: true })).toHaveCount(0);
  await expect(page.getByText('other.md', { exact: true })).toBeVisible();
  await expect(fileCards(page)).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'report.md', exact: true })).toHaveCount(0);

  await mention.click();
  await expect(page.getByRole('tab', { name: 'report.md', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '季度报告', exact: true })).toBeVisible();
});
