/**
 * Real-Electron acceptance for 「重试」 in the step block of a turn whose tool
 * step failed: the turn is run again from the user's message, so the
 * conversation and the request to the model hold that message once.
 *
 * A loopback model scripts each turn: a hand-over to an expert whose own
 * model call is refused, then a closing sentence.
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

const PROJECT_NAME = 'E2E 步骤重试';
const PROMPT = '请把会议纪要里的日期改成周三';
const FIRST_FINAL_TEXT = '这一次没有改成。';
const SECOND_FINAL_TEXT = '第二次仍然没有改成。';
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

/** A hand-over to an expert whose own model call is refused: the step of the hand-over fails. */
function failedHandOver(id: string): MockReplyPlan[] {
  return [
    { kind: 'tool-call', toolCallId: id, toolName: 'delegate_to_agent', arguments: { type: 'writer', task: '把会议纪要里的日期改成周三' } },
    { kind: 'http-error', status: 401, body: { error: { code: 401, message: 'Invalid API key', type: 'authentication_error' } } },
  ];
}

/** The user's message bubbles that hold the prompt. */
function promptBubbles(page: Page): Locator {
  return page.locator('[data-message-id]').filter({ hasText: PROMPT });
}

/** How many user messages of a request to the model hold the prompt. */
function promptCountIn(body: unknown): number {
  const messages = (body as { messages: Array<{ role: string; content: unknown }> }).messages;
  return messages.filter((message) => message.role === 'user' && JSON.stringify(message.content).includes(PROMPT)).length;
}

test('retrying a failed step runs the turn again from the user message, which stays single', async () => {
  test.setTimeout(240_000);
  const root = createElectronDataRoot();
  dataRoot = root;
  const workspace = path.join(root.rootDir, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const startedMock = await startOpenAiMock([
    ...failedHandOver('call-hand-over-first'),
    { kind: 'complete', responseText: FIRST_FINAL_TEXT },
    ...failedHandOver('call-hand-over-second'),
    { kind: 'complete', responseText: SECOND_FINAL_TEXT },
  ]);
  mock = startedMock;

  app = (await launchAbuElectron(root)).app;
  const page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(page);
  await page.evaluate(({ name, workspacePath, version }) => {
    window.localStorage.setItem('abu-projects', JSON.stringify({
      state: {
        projects: {
          'project-retry': {
            id: 'project-retry', name, workspacePath, pinned: false, archived: false,
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
  const composer = page.getByPlaceholder(CHAT_PLACEHOLDER);
  await expect(composer).toBeVisible();
  await composer.fill(PROMPT);
  await composer.press('Enter');
  await expect(page.getByText(FIRST_FINAL_TEXT)).toBeVisible({ timeout: REPLY_TIMEOUT });
  await expect(page.getByRole('button', { name: /^用时/ }).last()).toBeVisible({ timeout: REPLY_TIMEOUT });
  await expect(promptBubbles(page)).toHaveCount(1);

  // The work process of an ended turn folds under "用时", and its step block is folded in it.
  await page.getByRole('button', { name: /^用时/ }).first().click();
  await page.locator('.task-block').getByRole('button', { expanded: false }).first().click();
  await expect(page.getByText('执行出错')).toBeVisible();
  await page.getByRole('button', { name: '重试', exact: true }).click();

  await expect(page.getByText(SECOND_FINAL_TEXT)).toBeVisible({ timeout: REPLY_TIMEOUT });
  await expect(page.getByRole('button', { name: /^用时/ }).last()).toBeVisible({ timeout: REPLY_TIMEOUT });
  await expect(page.getByText(FIRST_FINAL_TEXT)).toHaveCount(0);
  await expect(promptBubbles(page)).toHaveCount(1);

  // Each turn makes three calls: the hand-over, the expert's refused call, the closing sentence.
  const requests = taskRequests(startedMock);
  expect(requests).toHaveLength(6);
  expect(promptCountIn(requests[requests.length - 1].body)).toBe(1);
});
