/**
 * Real-Electron acceptance for a team run the application was closed on.
 *
 * Opening the app again starts nothing: the interrupted request's row says the
 * app was closed before the turn finished and offers 「继续」 (a team row offers
 * no 「重新发送」). The click continues the run as the user's own send: the
 * leader is asked to pick up from the conversation, the original request is in
 * that prompt, and what the interrupted run produced stays in the transcript.
 */
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import {
  closeAbuElectron,
  configureLocalMockProvider,
  createElectronDataRoot,
  dismissFirstRunOverlays,
  launchAbuElectron,
  removeElectronDataRoot,
  type ElectronDataRoot,
} from './electronHelpers';
import { READY_TIMEOUT, startOpenAiMock, taskRequests, type OpenAiMock } from './openAiMock';

const TEAM_NAME = 'E2E续跑小队';
const TASK = 'E2E续跑任务：整理一份周报';
const PARTIAL = 'RESUME-TURN-PARTIAL';
const RESUMED_REPLY = 'RESUME-TURN-CONTINUED';
const QUIT_QUESTION = '阿布还在处理任务，现在退出会中断它。';
const CLOSED_MIDWAY = '上次关闭应用时，这一轮没有做完。';
const CONTINUE_BUTTON = '继续';
const RESEND_BUTTON = '重新发送';

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;
let mock: OpenAiMock | undefined;

async function launch(root: ElectronDataRoot): Promise<Page> {
  const launched = await launchAbuElectron(root);
  app = launched.app;
  const page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await page.waitForLoadState('domcontentloaded');
  // The first-run guide is a modal window: the page behind it is out of the accessibility tree,
  // so until the guide is dismissed the message field is found by its mark and not by its role.
  await expect(page.locator('[data-chat-composer]').first()).toBeVisible({ timeout: READY_TIMEOUT });
  return page;
}

async function showSidebar(page: Page): Promise<void> {
  const toggle = page.getByRole('button', { name: '显示侧栏', exact: true });
  if (await toggle.isVisible()) await toggle.click();
}

/** Start a quit the way Cmd+Q does, without waiting for the application to leave. */
async function requestQuit(target: ElectronApplication): Promise<void> {
  await target.evaluate(({ app: electronApp }) => {
    setImmediate(() => electronApp.quit());
  });
}

function exited(target: ElectronApplication): Promise<void> {
  const child = target.process();
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

/** Every user-role text in a mock request body, in order. */
function userTextsOf(body: unknown): string[] {
  const messages = (body as { messages?: Array<{ role?: unknown; content?: unknown }> }).messages ?? [];
  return messages
    .filter((m) => m.role === 'user')
    .map((m) => (typeof m.content === 'string'
      ? m.content
      : (m.content as Array<{ text?: string }> | null | undefined)?.map((block) => block.text ?? '').join('\n') ?? ''));
}

test.afterEach(async () => {
  const [openApp, openMock, openDataRoot] = [app, mock, dataRoot];
  app = undefined;
  mock = undefined;
  dataRoot = undefined;
  try {
    if (openApp) await closeAbuElectron(openApp);
  } finally {
    try {
      await openMock?.close();
    } finally {
      if (openDataRoot) removeElectronDataRoot(openDataRoot);
    }
  }
});

test('a team run the app was closed on waits for 继续, then continues as the user\'s send', async () => {
  test.setTimeout(300_000);
  mock = await startOpenAiMock([
    { kind: 'hold-open', partialText: PARTIAL },
    { kind: 'complete', responseText: RESUMED_REPLY },
  ]);
  dataRoot = createElectronDataRoot();

  let page = await launch(dataRoot);
  await dismissFirstRunOverlays(page);
  await page.addInitScript(({ name }) => {
    const previous = JSON.parse(localStorage.getItem('abu-team') ?? '{}');
    localStorage.setItem('abu-team', JSON.stringify({
      ...previous,
      state: {
        ...previous.state,
        teams: [{
          id: 't-resume',
          name,
          description: '重启后续跑验收',
          leaderRoleId: 'builtin:产品经理',
          memberRoleIds: ['builtin:产品经理', 'builtin:高级开发工程师'],
          requirePlanApproval: false,
          createdAt: 1,
        }],
      },
    }));
  }, { name: TEAM_NAME });
  await configureLocalMockProvider(page, mock.baseUrl, { supportsTools: true, permissionMode: 'standard' });

  await expect(page.getByRole('textbox').first()).toBeVisible({ timeout: READY_TIMEOUT });
  await showSidebar(page);
  await page.getByTestId('sidebar-team').click();
  await page.getByTestId('top-tab-nav').getByRole('button', { name: '专家团', exact: true }).click();
  await page.getByTestId('team-source-mine').click();
  await page.getByTestId(`team-row-${TEAM_NAME}`).click();
  await page.getByTestId('team-detail-start-chat').click();

  const composer = page.getByRole('textbox');
  await composer.fill(TASK);
  await composer.press('Enter');
  await expect(page.getByText(PARTIAL, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
  expect(taskRequests(mock)).toHaveLength(1);

  // The user quits with the leader still running: the turn is recorded as closed on.
  const left = exited(app!);
  await requestQuit(app!);
  const question = page.getByRole('alertdialog', { name: QUIT_QUESTION });
  await expect(question).toBeVisible({ timeout: READY_TIMEOUT });
  await question.getByRole('button', { name: '退出', exact: true }).click();
  await left;
  app = undefined;

  page = await launch(dataRoot);
  await showSidebar(page);
  await page.getByRole('button', { name: new RegExp(`${TASK}|${TEAM_NAME}`) }).first().click();
  await expect(page.getByText(CLOSED_MIDWAY, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
  await expect(page.getByText(PARTIAL, { exact: true })).toBeVisible();
  const continueButton = page.getByRole('button', { name: CONTINUE_BUTTON, exact: true });
  await expect(continueButton).toBeVisible();
  await expect(page.getByRole('button', { name: RESEND_BUTTON, exact: true })).toHaveCount(0);
  // Nothing ran on its own: the only model call so far is the one the user sent before the quit.
  expect(taskRequests(mock)).toHaveLength(1);

  await continueButton.click();
  await expect(page.getByText(RESUMED_REPLY, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
  // The continuation carries the original request to the leader, and the
  // interrupted turn's output is still in the transcript — nothing was cut.
  expect(taskRequests(mock)).toHaveLength(2);
  const continuation = userTextsOf(taskRequests(mock)[1].body).at(-1) ?? '';
  expect(continuation).toContain('不要重做');
  expect(continuation).toContain(TASK);
  await expect(page.getByText(PARTIAL, { exact: true })).toBeVisible();
  await expect(page.getByText(CLOSED_MIDWAY, { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: CONTINUE_BUTTON, exact: true })).toHaveCount(0);
});
