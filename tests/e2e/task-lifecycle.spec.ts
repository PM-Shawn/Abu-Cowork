/**
 * Product task lifecycle through the real Electron renderer, sidecar, and
 * conversation JSONL storage. The only LLM endpoint used here is the local
 * loopback mock below; it never receives a real credential or user content.
 */
import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import type { ElectronApplication, Page } from 'playwright';
import {
  closeAbuElectron,
  createElectronDataRoot,
  launchAbuElectron,
  removeElectronDataRoot,
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
}

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

async function startOpenAiMock(responseText: string): Promise<OpenAiMock> {
  const requests: MockRequest[] = [];
  const server = createServer(async (req, res) => {
    const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    let rawBody = '';
    for await (const chunk of req) rawBody += String(chunk);

    let body: unknown = rawBody;
    try {
      body = JSON.parse(rawBody);
    } catch {
      // Keep malformed input available in the assertion output if this ever regresses.
    }
    requests.push({
      authorization: req.headers.authorization,
      body,
      pathname: requestUrl.pathname,
    });

    if (req.method !== 'POST' || requestUrl.pathname !== '/v1/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unexpected local E2E mock route' }));
      return;
    }

    res.writeHead(200, {
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'content-type': 'text/event-stream; charset=utf-8',
    });
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
    await closeServer(server);
    throw new Error('The local OpenAI-compatible mock did not receive a TCP port');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => closeServer(server),
    requests,
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
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
    mock = await startOpenAiMock(response);

    dataRoot = createElectronDataRoot();
    const firstLaunch = await launchAbuElectron(dataRoot);
    app = firstLaunch.app;
    const firstPage = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForApp(firstPage);
    await configureLocalMockProvider(firstPage, mock.baseUrl);

    const input = firstPage.getByPlaceholder(CHAT_PLACEHOLDER);
    await input.fill(prompt);
    await input.press('Enter');

    await expect.poll(() => mock!.requests.length, { timeout: READY_TIMEOUT }).toBe(1);
    const request = mock.requests[0];
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
});
