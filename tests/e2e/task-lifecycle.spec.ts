/**
 * Product task lifecycle through the real Electron renderer, sidecar, and
 * conversation JSONL storage. The only LLM endpoint used here is the local
 * loopback mock in ./openAiMock; it never receives a real credential or user
 * content.
 */
import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ElectronApplication } from 'playwright';
import {
  closeAbuElectron,
  configureLocalMockProvider,
  crashAbuSidecarForE2E,
  createElectronDataRoot,
  launchAbuElectron,
  removeElectronDataRoot,
  terminateAbuElectron,
  type ElectronDataRoot,
} from './electronHelpers';
import {
  CHAT_PLACEHOLDER,
  compressionRequests,
  READY_TIMEOUT,
  startOpenAiMock,
  taskRequests,
  TEST_API_KEY,
  waitForApp,
  type OpenAiMock,
} from './openAiMock';

function diskContains(rootDir: string, expectedText: string, fileName = 'messages.jsonl'): boolean {
  const visit = (dir: string): boolean => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    return entries.some((entry) => {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) return visit(entryPath);
      if (entry.name !== fileName) return false;
      try {
        return fs.readFileSync(entryPath, 'utf8').includes(expectedText);
      } catch {
        return false;
      }
    });
  };
  return visit(rootDir);
}

/**
 * Since the message-ledger stage-2 write-amplification governance (see
 * docs/abu-message-ledger-plan.md §3.6, merged PR #212), an in-flight
 * assistant revision is durable crash-protection content the moment it lands
 * in EITHER of two places: a checkpointed `messages.jsonl` line (stable
 * checkpoints only — tool batch done, turn end, stop) or the per-turn
 * `stream-snapshot.json` (one atomic whole-file overwrite per revision,
 * written on a timer/per-tool-result while a turn is still running, see
 * conversationStorage.ts `writeStreamSnapshot`). `loadMessages` folds the
 * snapshot on top of the ledger on load, so either location recovers the
 * exact content after an abrupt termination. This predicate pins that widened
 * contract rather than the old ledger-only shape.
 *
 * Both on-disk snapshot shapes count, because a machine upgrading into this
 * build can still be holding a snapshot written by the previous one:
 *   v1 (legacy writer) `{"version":1,"messages":[Message,...]}`
 *   v2 (current writer) `{"version":2,"entries":[{"message":Message,...},...]}`
 * — the per-entry `stamp` watermark the RB-03 supersede guard added is not
 * part of the recoverability contract, so it is deliberately not asserted here.
 */
function diskContainsRecoverableAssistantMessage(rootDir: string, expectedContent: string): boolean {
  const matchesAssistantMessage = (message: { role?: unknown; content?: unknown }): boolean =>
    message.role === 'assistant' && message.content === expectedContent;

  const visit = (dir: string): boolean => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    return entries.some((entry) => {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) return visit(entryPath);
      if (entry.name === 'messages.jsonl') {
        try {
          return fs.readFileSync(entryPath, 'utf8')
            .trimEnd()
            .split('\n')
            .some((line) => matchesAssistantMessage(JSON.parse(line)));
        } catch {
          return false;
        }
      }
      if (entry.name === 'stream-snapshot.json') {
        try {
          const parsed = JSON.parse(fs.readFileSync(entryPath, 'utf8')) as {
            version?: unknown;
            messages?: unknown;
            entries?: unknown;
          };
          if (parsed.version === 1 && Array.isArray(parsed.messages)) {
            return parsed.messages.some((message) =>
              matchesAssistantMessage(message as { role?: unknown; content?: unknown }));
          }
          if (parsed.version === 2 && Array.isArray(parsed.entries)) {
            return parsed.entries.some((snapshotEntry) =>
              matchesAssistantMessage(
                (snapshotEntry as { message?: { role?: unknown; content?: unknown } }).message ?? {}));
          }
          return false;
        } catch {
          return false;
        }
      }
      return false;
    });
  };
  return visit(rootDir);
}

function diskContainsInterruptedUserMessage(rootDir: string, expectedContent: string): boolean {
  const visit = (dir: string): boolean => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    return entries.some((entry) => {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) return visit(entryPath);
      if (entry.name !== 'messages.jsonl') return false;
      try {
        return fs.readFileSync(entryPath, 'utf8')
          .trimEnd()
          .split('\n')
          .some((line) => {
            const message = JSON.parse(line) as {
              content?: unknown;
              role?: unknown;
              runEndedAt?: unknown;
              runState?: unknown;
            };
            return message.role === 'user'
              && message.content === expectedContent
              && message.runState === 'interrupted'
              && typeof message.runEndedAt === 'number';
          });
      } catch {
        return false;
      }
    });
  };
  return visit(rootDir);
}

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;
let mock: OpenAiMock | undefined;

test.describe.serial('Electron product task lifecycle', () => {
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

  test('sends through the sidecar and restores the persisted conversation after restart', async () => {
    const prompt = `abu-e2e-task-prompt-${randomUUID()}`;
    const response = `abu-e2e-deterministic-answer-${randomUUID()}`;
    const recentTitle = `${prompt.slice(0, 30)}...`;
    mock = await startOpenAiMock([{ kind: 'complete', responseText: response }]);

    dataRoot = createElectronDataRoot();
    const firstLaunch = await launchAbuElectron(dataRoot);
    app = firstLaunch.app;
    const firstPage = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForApp(firstPage);
    await configureLocalMockProvider(firstPage, mock.baseUrl);

    const input = firstPage.getByPlaceholder(CHAT_PLACEHOLDER);
    await input.fill(prompt);
    await input.press('Enter');

    await expect.poll(() => taskRequests(mock!).length, { timeout: READY_TIMEOUT }).toBe(1);
    const request = taskRequests(mock)[0];
    expect(request.pathname).toBe('/v1/chat/completions');
    expect(request.authorization).toBe(`Bearer ${TEST_API_KEY}`);
    expect(JSON.stringify(request.body)).toContain(prompt);
    expect((request.body as { tools?: unknown }).tools).toBeUndefined();

    await expect(firstPage.getByText(response, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    // UI visibility can precede the final JSONL replacement. Require both
    // messages on disk before quitting so restart proves a fresh disk load.
    await expect.poll(() => diskContains(dataRoot!.appDataDir, prompt), { timeout: READY_TIMEOUT }).toBe(true);
    await expect.poll(() => diskContains(dataRoot!.appDataDir, response), { timeout: READY_TIMEOUT }).toBe(true);
    await expect.poll(
      () => diskContains(dataRoot!.appDataDir, '"messageCount": 2', 'index.json'),
      { timeout: READY_TIMEOUT },
    ).toBe(true);

    await closeAbuElectron(app);
    app = undefined;

    const secondLaunch = await launchAbuElectron(dataRoot);
    app = secondLaunch.app;
    const secondPage = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForApp(secondPage);

    await secondPage.getByTitle(/显示侧栏|Show sidebar/).click();
    const recentConversation = secondPage.getByRole('button', { name: recentTitle }).first();
    await expect(recentConversation).toBeVisible({ timeout: READY_TIMEOUT });
    await recentConversation.click();
    await expect(secondPage.getByText(prompt, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(secondPage.getByText(response, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
  });

  test('opens a conserved context breakdown after a real sidecar turn', async () => {
    const prompt = `abu-e2e-context-breakdown-${randomUUID()}`;
    const response = `abu-e2e-context-answer-${randomUUID()}`;
    mock = await startOpenAiMock([{ kind: 'complete', responseText: response }]);

    dataRoot = createElectronDataRoot();
    const launch = await launchAbuElectron(dataRoot);
    app = launch.app;
    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForApp(page);
    await configureLocalMockProvider(page, mock.baseUrl);

    const input = page.getByPlaceholder(CHAT_PLACEHOLDER);
    await input.fill(prompt);
    await input.press('Enter');
    await expect(page.getByText(response, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });

    const indicator = page.getByTestId('context-indicator');
    await expect(indicator).toHaveAttribute('aria-expanded', 'false');
    await indicator.click();

    const popover = page.getByTestId('context-breakdown-popover');
    await expect(popover).toBeVisible();
    const rows = popover.locator('[data-testid^="context-breakdown-row-"]');
    await expect(rows).toHaveCount(5);

    const totalTokens = await popover.getAttribute('data-tokens-used');
    expect(totalTokens).not.toBeNull();
    const bucketTokens = await rows.evaluateAll((elements) => (
      elements.map((element) => Number((element as HTMLElement).dataset.tokens))
    ));
    expect(bucketTokens.reduce((sum, value) => sum + value, 0)).toBe(Number(totalTokens));

    const headerText = await popover.getByTestId('context-breakdown-header').innerText();
    const headerPercent = Number(headerText.match(/(\d+)%/)?.[1]);
    const bucketPercents = await popover
      .locator('[data-testid^="context-breakdown-percent-"]')
      .allInnerTexts();
    expect(bucketPercents.reduce((sum, value) => sum + Number.parseInt(value, 10), 0))
      .toBe(headerPercent);
  });

  test('keeps the breakdown conserved after reading two large files and compressing', async () => {
    test.setTimeout(120_000);
    const runId = randomUUID();
    const prefillResponses = Array.from(
      { length: 6 },
      (_, index) => `abu-e2e-context-prefill-answer-${index}-${runId}`,
    );
    const finalResponse = `abu-e2e-context-after-compression-${runId}`;
    const firstFixtureMarker = `abu-e2e-owned-fixture-alpha-${runId}`;
    const secondFixtureMarker = `abu-e2e-owned-fixture-beta-${runId}`;
    dataRoot = createElectronDataRoot();
    const fixtureDir = path.join(dataRoot.rootDir, 'owned-context-fixtures');
    const firstFixturePath = path.join(fixtureDir, 'alpha-large-fixture.txt');
    const secondFixturePath = path.join(fixtureDir, 'beta-large-fixture.txt');
    const makeLargeFixture = (marker: string, label: string) => [
      marker,
      ...Array.from(
        { length: 119 },
        (_, index) => `${label}-${index.toString().padStart(3, '0')}: ${label.repeat(32)}`,
      ),
    ].join('\n');
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.writeFileSync(firstFixturePath, makeLargeFixture(firstFixtureMarker, 'alpha-context-fixture'));
    fs.writeFileSync(secondFixturePath, makeLargeFixture(secondFixtureMarker, 'beta-context-fixture'));
    mock = await startOpenAiMock([
      ...prefillResponses.map((responseText) => ({ kind: 'complete' as const, responseText })),
      {
        kind: 'tool-call',
        toolCallId: `call-agent-loop-${runId}`,
        toolName: 'read_file',
        arguments: { path: firstFixturePath, offset: 0, limit: 80 },
      },
      {
        kind: 'tool-call',
        toolCallId: `call-chat-store-${runId}`,
        toolName: 'read_file',
        arguments: { path: secondFixturePath, offset: 0, limit: 80 },
      },
      { kind: 'complete', responseText: finalResponse },
    ]);

    const launch = await launchAbuElectron(dataRoot);
    app = launch.app;
    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForApp(page);
    await configureLocalMockProvider(page, mock.baseUrl, {
      contextWindowSize: 50_000,
      maxOutputTokens: 4_096,
      supportsTools: true,
    });

    const input = page.getByPlaceholder(CHAT_PLACEHOLDER);
    const largePayload = 'x'.repeat(20_000);
    for (const [index, response] of prefillResponses.entries()) {
      await input.fill(`abu-e2e-context-prefill-${index}-${runId}\n${largePayload}`);
      await input.press('Enter');
      await expect(page.getByText(response, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
      await expect(input).toBeEditable({ timeout: READY_TIMEOUT });
    }

    const indicator = page.getByTestId('context-indicator');
    await indicator.click();
    const popover = page.getByTestId('context-breakdown-popover');
    await expect(popover).toBeVisible();
    const rows = popover.locator('[data-testid^="context-breakdown-row-"]');
    const beforeTokens = Number(await popover.getAttribute('data-tokens-used'));
    const beforeBucketTokens = await rows.evaluateAll((elements) => (
      elements.map((element) => Number((element as HTMLElement).dataset.tokens))
    ));
    const beforeConversation = Number(
      await popover.getByTestId('context-breakdown-row-conversation').getAttribute('data-tokens'),
    );
    expect(beforeTokens).toBeGreaterThan(50_000 * 0.65);
    expect(beforeBucketTokens.reduce((sum, value) => sum + value, 0)).toBe(beforeTokens);
    expect(beforeConversation).toBe(Math.max(...beforeBucketTokens));
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();

    // No file-read permission prompt to clear: the fixtures live under the data
    // root, which `createElectronDataRoot` puts inside the OS temp directory,
    // and pathSafety treats the runtime temp dir as an implicit read root on
    // every platform (4eccd2cc). The subject here is the token breakdown, so
    // the reads are left implicitly allowed rather than staged elsewhere.
    await input.fill(`请依次读取这两个大文件：${firstFixturePath} 和 ${secondFixturePath}`);
    await input.press('Enter');
    await expect(page.getByText(finalResponse, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(input).toBeEditable({ timeout: READY_TIMEOUT });

    expect(compressionRequests(mock).length).toBeGreaterThan(0);
    const requests = taskRequests(mock);
    expect(requests).toHaveLength(9);
    expect(JSON.stringify(requests[7].body)).toContain(firstFixtureMarker);
    expect(JSON.stringify(requests[8].body)).toContain(secondFixtureMarker);
    expect(JSON.stringify(requests[8].body)).toContain('Abu E2E compacted conversation summary.');

    await indicator.click();
    await expect(popover).toBeVisible();
    const afterTokens = Number(await popover.getAttribute('data-tokens-used'));
    const afterBucketTokens = await rows.evaluateAll((elements) => (
      elements.map((element) => Number((element as HTMLElement).dataset.tokens))
    ));
    const afterConversation = Number(
      await popover.getByTestId('context-breakdown-row-conversation').getAttribute('data-tokens'),
    );
    expect(afterTokens).toBeLessThan(beforeTokens);
    expect(afterBucketTokens.reduce((sum, value) => sum + value, 0)).toBe(afterTokens);
    expect(afterConversation).toBe(Math.max(...afterBucketTokens));

    const headerText = await popover.getByTestId('context-breakdown-header').innerText();
    const headerPercent = Number(headerText.match(/(\d+)%/)?.[1]);
    const bucketPercents = await popover
      .locator('[data-testid^="context-breakdown-percent-"]')
      .allInnerTexts();
    expect(bucketPercents.reduce((sum, value) => sum + Number.parseInt(value, 10), 0))
      .toBe(headerPercent);
  });

  test('stops an open stream, persists its partial reply, and continues after restart', async () => {
    const prompt = `abu-e2e-stop-prompt-${randomUUID()}`;
    const partial = `abu-e2e-stop-partial-${randomUUID()}`;
    const followUp = `abu-e2e-stop-follow-up-${randomUUID()}`;
    const followUpResponse = `abu-e2e-stop-follow-up-answer-${randomUUID()}`;
    const recentTitle = `${prompt.slice(0, 30)}...`;
    mock = await startOpenAiMock([
      { kind: 'hold-open', partialText: partial },
      { kind: 'complete', responseText: followUpResponse },
    ]);

    dataRoot = createElectronDataRoot();
    const firstLaunch = await launchAbuElectron(dataRoot);
    app = firstLaunch.app;
    const firstPage = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForApp(firstPage);
    await configureLocalMockProvider(firstPage, mock.baseUrl);

    const input = firstPage.getByPlaceholder(CHAT_PLACEHOLDER);
    await input.fill(prompt);
    await input.press('Enter');

    await expect.poll(() => taskRequests(mock!).length, { timeout: READY_TIMEOUT }).toBe(1);
    const firstRequest = taskRequests(mock)[0];
    expect(firstRequest.pathname).toBe('/v1/chat/completions');
    expect(firstRequest.authorization).toBe(`Bearer ${TEST_API_KEY}`);
    expect(JSON.stringify(firstRequest.body)).toContain(prompt);
    await expect(firstPage.getByText(partial, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });

    const stopButton = firstPage.getByLabel(/^(停止|Stop)$/);
    await expect(stopButton).toBeVisible({ timeout: READY_TIMEOUT });
    await stopButton.click();

    // The button transition alone is insufficient: the mock must observe the
    // renderer/sidecar aborting its real loopback HTTP response.
    await expect.poll(() => taskRequests(mock!)[0]?.responseAborted, { timeout: READY_TIMEOUT }).toBe(true);
    await expect(stopButton).toBeHidden({ timeout: READY_TIMEOUT });
    await expect(input).toBeEditable({ timeout: READY_TIMEOUT });
    await expect(firstPage.getByText(partial, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(firstPage.getByText(/^(?:你在 .* 后停止了|You stopped after .*)$/)).toBeVisible({
      timeout: READY_TIMEOUT,
    });

    // The assistant content stays model-authored while the durable user-run
    // terminal carries the stop state. Together they prove no later stream
    // token was appended and the status can be reconstructed after restart.
    await expect.poll(
      () => diskContainsRecoverableAssistantMessage(dataRoot!.appDataDir, partial),
      { timeout: READY_TIMEOUT },
    ).toBe(true);
    await expect.poll(
      () => diskContainsInterruptedUserMessage(dataRoot!.appDataDir, prompt),
      { timeout: READY_TIMEOUT },
    ).toBe(true);
    await expect.poll(
      () => diskContains(dataRoot!.appDataDir, '"messageCount": 2', 'index.json'),
      { timeout: READY_TIMEOUT },
    ).toBe(true);

    await closeAbuElectron(app);
    app = undefined;

    const secondLaunch = await launchAbuElectron(dataRoot);
    app = secondLaunch.app;
    const secondPage = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForApp(secondPage);

    await secondPage.getByTitle(/显示侧栏|Show sidebar/).click();
    const recentConversation = secondPage.getByRole('button', { name: recentTitle }).first();
    await expect(recentConversation).toBeVisible({ timeout: READY_TIMEOUT });
    await recentConversation.click();
    await expect(secondPage.getByText(partial, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(secondPage.getByText(/^(?:你在 .* 后停止了|You stopped after .*)$/)).toBeVisible({
      timeout: READY_TIMEOUT,
    });

    const restoredInput = secondPage.getByPlaceholder(CHAT_PLACEHOLDER);
    await restoredInput.fill(followUp);
    await restoredInput.press('Enter');
    await expect.poll(() => taskRequests(mock!).length, { timeout: READY_TIMEOUT }).toBe(2);
    const secondRequest = taskRequests(mock)[1];
    expect(secondRequest.pathname).toBe('/v1/chat/completions');
    expect(secondRequest.authorization).toBe(`Bearer ${TEST_API_KEY}`);
    const secondRequestBody = JSON.stringify(secondRequest.body);
    expect(secondRequestBody).toContain(prompt);
    expect(secondRequestBody).toContain(partial);
    expect(secondRequestBody).not.toContain('[已停止]');
    expect(secondRequestBody).toContain(followUp);
    await expect(secondPage.getByText(followUpResponse, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    await expect.poll(
      () => diskContainsRecoverableAssistantMessage(dataRoot!.appDataDir, followUpResponse),
      { timeout: READY_TIMEOUT },
    ).toBe(true);
  });

  test('recovers a periodically persisted partial reply after an abrupt app termination', async () => {
    const prompt = `abu-e2e-recovery-prompt-${randomUUID()}`;
    const partial = `abu-e2e-recovery-partial-${randomUUID()}`;
    const followUp = `abu-e2e-recovery-follow-up-${randomUUID()}`;
    const followUpResponse = `abu-e2e-recovery-answer-${randomUUID()}`;
    const recentTitle = `${prompt.slice(0, 30)}...`;
    mock = await startOpenAiMock([
      { kind: 'hold-open', partialText: partial },
      { kind: 'complete', responseText: followUpResponse },
    ]);

    dataRoot = createElectronDataRoot();
    const firstLaunch = await launchAbuElectron(dataRoot);
    app = firstLaunch.app;
    const firstPage = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForApp(firstPage);
    await configureLocalMockProvider(firstPage, mock.baseUrl);

    const input = firstPage.getByPlaceholder(CHAT_PLACEHOLDER);
    await input.fill(prompt);
    await input.press('Enter');

    await expect.poll(() => taskRequests(mock!).length, { timeout: READY_TIMEOUT }).toBe(1);
    await expect(firstPage.getByText(partial, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    await expect.poll(
      () => diskContains(dataRoot!.appDataDir, '"status":"llm_calling"', 'checkpoint.json'),
      { timeout: READY_TIMEOUT },
    ).toBe(true);

    // The stream intentionally sends no more chunks. Crash protection must be
    // driven by elapsed time, not by waiting for another provider event.
    await expect.poll(
      () => diskContainsRecoverableAssistantMessage(dataRoot!.appDataDir, partial),
      { timeout: 15_000 },
    ).toBe(true);

    await terminateAbuElectron(app);
    app = undefined;
    await expect.poll(() => taskRequests(mock!)[0]?.responseAborted, { timeout: READY_TIMEOUT }).toBe(true);

    const secondLaunch = await launchAbuElectron(dataRoot);
    app = secondLaunch.app;
    const secondPage = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForApp(secondPage);

    await secondPage.getByTitle(/显示侧栏|Show sidebar/).click();
    const recentConversation = secondPage.getByRole('button', { name: recentTitle }).first();
    await expect(recentConversation).toBeVisible({ timeout: READY_TIMEOUT });
    await recentConversation.click();
    await expect(secondPage.getByText(prompt, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(secondPage.getByText(partial, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(secondPage.getByText(/上次对话.*等待模型响应时中断/)).toBeVisible({
      timeout: READY_TIMEOUT,
    });

    const restoredInput = secondPage.getByPlaceholder(CHAT_PLACEHOLDER);
    await expect(restoredInput).toBeEditable({ timeout: READY_TIMEOUT });
    await restoredInput.fill(followUp);
    await restoredInput.press('Enter');
    await expect.poll(() => taskRequests(mock!).length, { timeout: READY_TIMEOUT }).toBe(2);
    const secondRequestBody = JSON.stringify(taskRequests(mock)[1]?.body);
    expect(secondRequestBody).toContain(prompt);
    expect(secondRequestBody).toContain(partial);
    expect(secondRequestBody).toContain(followUp);
    await expect(secondPage.getByText(followUpResponse, { exact: true })).toBeVisible({
      timeout: READY_TIMEOUT,
    });
  });

  test('recovers after the active sidecar process crashes and continues on its replacement', async () => {
    const prompt = `abu-e2e-sidecar-crash-prompt-${randomUUID()}`;
    const partial = `abu-e2e-sidecar-crash-partial-${randomUUID()}`;
    const followUp = `abu-e2e-sidecar-crash-follow-up-${randomUUID()}`;
    const followUpResponse = `abu-e2e-sidecar-crash-answer-${randomUUID()}`;
    mock = await startOpenAiMock([
      { kind: 'hold-open', partialText: partial },
      { kind: 'complete', responseText: followUpResponse },
    ]);

    dataRoot = createElectronDataRoot();
    const launch = await launchAbuElectron(dataRoot);
    app = launch.app;
    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForApp(page);
    await configureLocalMockProvider(page, mock.baseUrl);

    const input = page.getByPlaceholder(CHAT_PLACEHOLDER);
    await input.fill(prompt);
    await input.press('Enter');
    await expect.poll(() => taskRequests(mock!).length, { timeout: READY_TIMEOUT }).toBe(1);
    await expect(page.getByText(partial, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });

    await crashAbuSidecarForE2E(page, dataRoot.sidecarCrashToken);
    await expect.poll(() => taskRequests(mock!)[0]?.responseAborted, { timeout: READY_TIMEOUT }).toBe(true);

    // #549: the row states the failure and offers the action; the stored
    // `runError` sentence below is what the next turn carries upstream.
    await expect(page.getByText('连接恢复失败')).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(page.getByRole('button', { name: '重试' })).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(page.getByLabel(/^(停止|Stop)$/)).toBeHidden({ timeout: READY_TIMEOUT });
    await expect(input).toBeEditable({ timeout: READY_TIMEOUT });
    expect(app.process().exitCode).toBeNull();
    expect(app.process().signalCode).toBeNull();

    await input.fill(followUp);
    await input.press('Enter');
    await expect.poll(() => taskRequests(mock!).length, { timeout: READY_TIMEOUT }).toBe(2);
    const secondRequestBody = JSON.stringify(taskRequests(mock)[1]?.body);
    expect(secondRequestBody).toContain(prompt);
    expect(secondRequestBody).toContain(partial);
    expect(secondRequestBody).toContain('连接中断，可点重试');
    expect(secondRequestBody).not.toContain('Sidecar process closed');
    expect(secondRequestBody).toContain(followUp);
    await expect(page.getByText(followUpResponse, { exact: true })).toBeVisible({
      timeout: READY_TIMEOUT,
    });
  });
});
