/**
 * Product task lifecycle through the real Electron renderer, sidecar, and
 * conversation JSONL storage. The only LLM endpoint used here is the local
 * loopback mock below; it never receives a real credential or user content.
 */
import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import type { ElectronApplication, Page } from 'playwright';
import {
  closeAbuElectron,
  createElectronDataRoot,
  killAbuSidecar,
  launchAbuElectron,
  removeElectronDataRoot,
  terminateAbuElectron,
  waitForAbuSidecarPid,
  type ElectronDataRoot,
} from './electronHelpers';

const READY_TIMEOUT = 45_000;
const CHAT_PLACEHOLDER = '想让阿布帮你做点什么？';
const TEST_API_KEY = 'abu-e2e-test-key-not-a-real-secret';
const TEST_MODEL_ID = 'abu-e2e-local-model';

interface MockRequest {
  authorization: string | undefined;
  body: unknown;
  pathname: string;
  purpose: 'memory' | 'task';
  responseAborted: boolean;
}

type MockReplyPlan =
  | { kind: 'complete'; responseText: string }
  | { kind: 'hold-open'; partialText: string };

interface OpenAiMock {
  baseUrl: string;
  close: () => Promise<void>;
  requests: MockRequest[];
}

function sseChunk(content: string, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-abu-e2e',
    object: 'chat.completion.chunk',
    created: 0,
    model: TEST_MODEL_ID,
    choices: [{
      index: 0,
      delta: content ? { content } : {},
      finish_reason: finishReason,
    }],
  })}\n\n`;
}

async function startOpenAiMock(replyPlans: readonly MockReplyPlan[]): Promise<OpenAiMock> {
  const requests: MockRequest[] = [];
  let taskRequestCount = 0;
  const activeResponses = new Set<ServerResponse>();
  const server = createServer(async (req, res) => {
    activeResponses.add(res);
    res.once('close', () => activeResponses.delete(res));

    const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    let rawBody = '';
    for await (const chunk of req) rawBody += String(chunk);

    let body: unknown = rawBody;
    try {
      body = JSON.parse(rawBody);
    } catch {
      // Keep malformed input available in the assertion output if this ever regresses.
    }
    const purpose = isMemoryExtractionRequest(body) ? 'memory' : 'task';
    const mockRequest: MockRequest = {
      authorization: req.headers.authorization,
      body,
      pathname: requestUrl.pathname,
      purpose,
      responseAborted: false,
    };
    if (req.method !== 'POST' || requestUrl.pathname !== '/v1/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unexpected local E2E mock route' }));
      return;
    }

    requests.push(mockRequest);
    const replyPlan =
      purpose === 'memory'
        ? { kind: 'complete' as const, responseText: '[]' }
        : replyPlans[taskRequestCount++];
    if (!replyPlan) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unexpected extra local E2E mock request' }));
      return;
    }

    res.writeHead(200, {
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'content-type': 'text/event-stream; charset=utf-8',
    });
    if (replyPlan.kind === 'hold-open') {
      res.once('close', () => {
        // A deliberate stop aborts the browser's response stream. This stays
        // false for normal completed replies, which call res.end() below.
        mockRequest.responseAborted = !res.writableEnded;
      });
      res.write(sseChunk(replyPlan.partialText, null));
      return;
    }

    const { responseText } = replyPlan;
    const splitAt = Math.ceil(responseText.length / 2);
    res.write(sseChunk(responseText.slice(0, splitAt), null));
    // Normal streaming providers deliver several deltas before their terminal
    // frame; preserve that ordering across the renderer's RAF token buffer.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    res.write(sseChunk(responseText.slice(splitAt), null));
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    res.write(sseChunk('', 'stop'));
    res.end('data: [DONE]\n\n');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // Loopback only: this test must never expose a local mock on the network.
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer(server, activeResponses);
    throw new Error('The local OpenAI-compatible mock did not receive a TCP port');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => closeServer(server, activeResponses),
    requests,
  };
}

function isMemoryExtractionRequest(body: unknown): boolean {
  if (!body || typeof body !== 'object' || !('messages' in body)) return false;
  const messages = (body as { messages?: unknown }).messages;
  return Array.isArray(messages) && messages.some((message) => {
    if (!message || typeof message !== 'object') return false;
    const candidate = message as { content?: unknown; role?: unknown };
    return candidate.role === 'system' &&
      typeof candidate.content === 'string' &&
      candidate.content.includes('你是一个记忆提取助手');
  });
}

function taskRequests(mock: OpenAiMock): MockRequest[] {
  return mock.requests.filter((request) => request.purpose === 'task');
}

function closeServer(server: Server, activeResponses: ReadonlySet<ServerResponse>): Promise<void> {
  // A failed assertion can leave a hold-open SSE response active. Destroy it
  // before close() so afterEach cannot wait forever on that client connection.
  for (const response of activeResponses) response.destroy();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.closeAllConnections?.();
      reject(new Error('Timed out closing local OpenAI E2E mock'));
    }, 5_000);
    server.close((error) => {
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    });
    server.closeAllConnections?.();
  });
}

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

function diskContainsExactAssistantMessage(rootDir: string, expectedContent: string): boolean {
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
            const message = JSON.parse(line) as { role?: unknown; content?: unknown };
            return message.role === 'assistant' && message.content === expectedContent;
          });
      } catch {
        return false;
      }
    });
  };
  return visit(rootDir);
}

async function waitForApp(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible({ timeout: READY_TIMEOUT });
}

async function configureLocalMockProvider(page: Page, baseUrl: string): Promise<void> {
  await page.evaluate(({ baseUrl, testApiKey, testModelId }) => {
    const raw = window.localStorage.getItem('abu-settings');
    if (!raw) throw new Error('abu-settings was not initialized before E2E configuration');
    const persisted = JSON.parse(raw) as { state: Record<string, unknown>; version: number };
    const state = persisted.state;

    state.providers = [{
      id: 'abu-e2e-local-provider',
      source: 'custom',
      name: 'Abu E2E loopback mock',
      enabled: true,
      apiFormat: 'openai-compatible',
      baseUrl,
      apiKey: testApiKey,
      models: [{
        id: testModelId,
        label: 'Abu E2E deterministic model',
        isCustom: true,
        declaredCapabilities: { supportsTools: false },
      }],
      defaultModelId: testModelId,
      status: 'verified',
      sortOrder: 0,
      userAdded: true,
      declaredCapabilities: { supportsTools: false },
    }];
    state.activeModel = { providerId: 'abu-e2e-local-provider', modelId: testModelId };
    state.recentModels = [];
    state.favoriteModels = [];
    state.guideShown = true;
    state.guideOpen = false;
    state.hasAcknowledgedDisclaimer = true;
    state.hasRunSensitiveAudit_v015 = true;

    window.localStorage.setItem('abu-settings', JSON.stringify({ ...persisted, state, version: 42 }));
  }, { baseUrl, testApiKey: TEST_API_KEY, testModelId: TEST_MODEL_ID });
  await page.reload();
  await waitForApp(page);
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

  test('stops an open stream, persists its partial reply, and continues after restart', async () => {
    const prompt = `abu-e2e-stop-prompt-${randomUUID()}`;
    const partial = `abu-e2e-stop-partial-${randomUUID()}`;
    const followUp = `abu-e2e-stop-follow-up-${randomUUID()}`;
    const followUpResponse = `abu-e2e-stop-follow-up-answer-${randomUUID()}`;
    const recentTitle = `${prompt.slice(0, 30)}...`;
    const stoppedContent = `${partial}\n\n*[已停止]*`;
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
    await expect(firstPage.getByText('[已停止]', { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });

    // Exact persisted content proves both the partial token and the stop
    // marker survived, with no later stream token appended after cancellation.
    await expect.poll(
      () => diskContainsExactAssistantMessage(dataRoot!.appDataDir, stoppedContent),
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
    await expect(secondPage.getByText('[已停止]', { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });

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
    expect(secondRequestBody).toContain('[已停止]');
    expect(secondRequestBody).toContain(followUp);
    await expect(secondPage.getByText(followUpResponse, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    await expect.poll(
      () => diskContainsExactAssistantMessage(dataRoot!.appDataDir, followUpResponse),
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
      () => diskContainsExactAssistantMessage(dataRoot!.appDataDir, partial),
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

    const originalSidecarPid = await waitForAbuSidecarPid(app);
    const input = page.getByPlaceholder(CHAT_PLACEHOLDER);
    await input.fill(prompt);
    await input.press('Enter');
    await expect.poll(() => taskRequests(mock!).length, { timeout: READY_TIMEOUT }).toBe(1);
    await expect(page.getByText(partial, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });

    const killedPid = await killAbuSidecar(app);
    expect(killedPid).toBe(originalSidecarPid);
    await expect.poll(() => taskRequests(mock!)[0]?.responseAborted, { timeout: READY_TIMEOUT }).toBe(true);

    await expect(page.getByText(/后台服务意外中断.*自动恢复/)).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(page.getByLabel(/^(停止|Stop)$/)).toBeHidden({ timeout: READY_TIMEOUT });
    await expect(input).toBeEditable({ timeout: READY_TIMEOUT });
    expect(app.process().exitCode).toBeNull();
    expect(app.process().signalCode).toBeNull();

    const replacementSidecarPid = await waitForAbuSidecarPid(app, killedPid, READY_TIMEOUT);
    expect(replacementSidecarPid).not.toBe(killedPid);

    await input.fill(followUp);
    await input.press('Enter');
    await expect.poll(() => taskRequests(mock!).length, { timeout: READY_TIMEOUT }).toBe(2);
    const secondRequestBody = JSON.stringify(taskRequests(mock)[1]?.body);
    expect(secondRequestBody).toContain(prompt);
    expect(secondRequestBody).toContain(partial);
    expect(secondRequestBody).toContain('后台服务意外中断');
    expect(secondRequestBody).not.toContain('Sidecar process closed');
    expect(secondRequestBody).toContain(followUp);
    await expect(page.getByText(followUpResponse, { exact: true })).toBeVisible({
      timeout: READY_TIMEOUT,
    });
  });
});
