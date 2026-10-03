/**
 * Real-Electron acceptance for goal mode: /goal in the composer, automatic
 * rounds driven by the round driver, the goal bar, pause / resume, and the
 * model settling the goal through manage_goal. The model is the loopback
 * OpenAI-compatible mock (tests/e2e/openAiMock.ts), so every round is
 * deterministic and the request count proves no extra round started.
 */
import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { ElectronApplication } from 'playwright';
import {
  closeAbuElectron,
  configureLocalMockProvider,
  createElectronDataRoot,
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

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;
let mock: OpenAiMock | undefined;

function completeGoal(runId: string): MockReplyPlan {
  return {
    kind: 'tool-call',
    toolCallId: `call-goal-complete-${runId}`,
    toolName: 'manage_goal',
    arguments: {
      action: 'complete',
      summary: `abu-e2e-goal-summary-${runId}`,
      evidence: [`abu-e2e-goal-evidence-${runId}`],
    },
  };
}

async function startGoal(page: Page, objective: string): Promise<void> {
  const input = page.getByPlaceholder(CHAT_PLACEHOLDER);
  await input.fill(`/goal ${objective}`);
  await input.press('Enter');
}

function goalBar(page: Page) {
  return page.getByTestId('goal-bar');
}

test.describe.serial('Goal mode — real Electron', () => {
  test.afterEach(async () => {
    if (app) {
      await closeAbuElectron(app);
      app = undefined;
    }
    if (mock) {
      await mock.close();
      mock = undefined;
    }
    if (dataRoot) {
      removeElectronDataRoot(dataRoot);
      dataRoot = undefined;
    }
  });

  test('/goal keeps working round after round until the model completes it with evidence', async () => {
    const runId = randomUUID();
    const objective = `abu-e2e-goal-objective-${runId}`;
    const closingNote = `abu-e2e-goal-closing-${runId}`;
    mock = await startOpenAiMock([
      // The objective itself (the run /goal sends) and goal round 1: text only.
      { kind: 'complete', responseText: `abu-e2e-goal-first-${runId}` },
      { kind: 'complete', responseText: `abu-e2e-goal-round-1-${runId}` },
      // Goal round 2: settle the goal, then the closing note.
      completeGoal(runId),
      { kind: 'complete', responseText: closingNote },
    ]);
    dataRoot = createElectronDataRoot();
    app = (await launchAbuElectron(dataRoot)).app;
    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForApp(page);
    await configureLocalMockProvider(page, mock.baseUrl, { supportsTools: true });

    await startGoal(page, objective);

    await expect(goalBar(page)).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(goalBar(page)).toContainText(objective);
    // The objective is the first message, as an ordinary user bubble.
    await expect(page.getByText(objective, { exact: true }).first()).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(page.getByText(closingNote, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });

    // Rounds open with markers, not user bubbles.
    const markers = page.getByTestId('goal-round-marker');
    await expect(markers).toHaveCount(2, { timeout: READY_TIMEOUT });
    await expect(markers.nth(0)).toContainText('第 1 / 256 轮');
    await expect(markers.nth(1)).toContainText('第 2 / 256 轮');
    await expect(page.getByText(/<goal_round/)).toHaveCount(0);

    await expect(goalBar(page)).toContainText('目标已完成', { timeout: READY_TIMEOUT });
    await expect(goalBar(page)).toContainText(`abu-e2e-goal-summary-${runId}`);
    await goalBar(page).getByRole('button', { name: /完成依据/ }).click();
    await expect(goalBar(page)).toContainText(`abu-e2e-goal-evidence-${runId}`);

    // Exactly the four planned requests: nothing ran after the goal settled.
    await page.waitForTimeout(1_500);
    expect(taskRequests(mock)).toHaveLength(4);
    const round1Body = JSON.stringify(taskRequests(mock)[1].body);
    expect(round1Body).toContain('goal_round round=\\"1\\"');
    expect(round1Body).toContain('Active goal');
  });

  test('pausing stops the round in flight and starts nothing more until the user resumes', async () => {
    const runId = randomUUID();
    const objective = `abu-e2e-goal-pause-${runId}`;
    const closingNote = `abu-e2e-goal-pause-closing-${runId}`;
    mock = await startOpenAiMock([
      { kind: 'complete', responseText: `abu-e2e-goal-pause-first-${runId}` },
      // Goal round 1 hangs until the user pauses.
      { kind: 'hold-open', partialText: `abu-e2e-goal-pause-partial-${runId}` },
      // After resume: round 2 settles the goal.
      completeGoal(runId),
      { kind: 'complete', responseText: closingNote },
    ]);
    dataRoot = createElectronDataRoot();
    app = (await launchAbuElectron(dataRoot)).app;
    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForApp(page);
    await configureLocalMockProvider(page, mock.baseUrl, { supportsTools: true });

    await startGoal(page, objective);
    await expect.poll(() => taskRequests(mock!).length, { timeout: READY_TIMEOUT }).toBe(2);
    await expect(goalBar(page)).toContainText('自动推进中', { timeout: READY_TIMEOUT });

    await goalBar(page).getByRole('button', { name: /暂停/ }).click();

    await expect.poll(() => taskRequests(mock!)[1]?.responseAborted, { timeout: READY_TIMEOUT }).toBe(true);
    await expect(goalBar(page)).toContainText('已暂停', { timeout: READY_TIMEOUT });
    await expect(page.getByTestId('goal-round-outcome')).toContainText('已中断', { timeout: READY_TIMEOUT });
    await page.waitForTimeout(2_000);
    expect(taskRequests(mock)).toHaveLength(2);

    await goalBar(page).getByRole('button', { name: /继续/ }).click();

    await expect(page.getByText(closingNote, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(goalBar(page)).toContainText('目标已完成', { timeout: READY_TIMEOUT });
    await expect(page.getByTestId('goal-round-marker')).toHaveCount(2);
    expect(taskRequests(mock)).toHaveLength(4);
  });
});
