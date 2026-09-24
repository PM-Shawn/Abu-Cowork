/**
 * Background calls made for a conversation — memory extraction here — run on
 * the provider that conversation is bound to, not on the new-conversation
 * default, through the real Electron renderer and sidecar.
 *
 * Two loopback OpenAI-compatible mocks stand in for provider A (the default)
 * and provider B, each with its own key, and record every request with its
 * Authorization header. The conversation is moved to B while A stays the
 * default; the extractor's request must then reach B with B's key and never
 * reach A.
 */
import { expect, test } from '@playwright/test';
import { createServer, type Server, type ServerResponse } from 'node:http';
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

const READY_TIMEOUT = 45_000;
const EXTRACTION_TIMEOUT = 30_000;
const CHAT_PLACEHOLDER = '想让阿布帮你做点什么？';

const PROVIDER_A = { id: 'bcf-prov-a', name: 'BCF Provider A', modelId: 'model-a', modelLabel: 'Model A', apiKey: 'abu-e2e-key-a-not-a-real-secret' };
const PROVIDER_B = { id: 'bcf-prov-b', name: 'BCF Provider B', modelId: 'model-b', modelLabel: 'Model B', apiKey: 'abu-e2e-key-b-not-a-real-secret' };

// The memory extractor quotes the transcript in its own request; that is the
// request this spec is about.
const MEMORY_EXTRACTOR_PROMPT = '记忆提取助手';

interface RecordedRequest {
  authorization: string;
  isMemoryExtraction: boolean;
  /** Every user-role text in the request, joined. */
  userText: string;
  model: unknown;
}

interface ModelMock {
  baseUrl: string;
  close: () => Promise<void>;
  requests: RecordedRequest[];
}

function messageText(message: { content?: unknown }): string {
  return typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
}

function sseChunk(delta: Record<string, unknown>, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-abu-e2e-bcf',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'bcf-mock',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

async function startModelMock(reply: string): Promise<ModelMock> {
  const requests: RecordedRequest[] = [];
  const open = new Set<ServerResponse>();
  const server: Server = createServer(async (req, res) => {
    open.add(res);
    res.once('close', () => open.delete(res));
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    const body = JSON.parse(raw) as Record<string, unknown>;
    const messages = Array.isArray(body.messages) ? (body.messages as Array<{ role?: unknown; content?: unknown }>) : [];
    const system = messages.filter((m) => m.role === 'system').map(messageText).join('\n');
    const isMemoryExtraction = system.includes(MEMORY_EXTRACTOR_PROMPT);
    requests.push({
      authorization: String(req.headers.authorization ?? ''),
      isMemoryExtraction,
      userText: messages.filter((m) => m.role === 'user').map(messageText).join('\n'),
      model: body.model,
    });
    const content = isMemoryExtraction ? '[]' : reply;
    if (body.stream === false) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        id: 'chatcmpl-abu-e2e-bcf',
        object: 'chat.completion',
        created: 0,
        model: 'bcf-mock',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      }));
      return;
    }
    res.writeHead(200, {
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'content-type': 'text/event-stream; charset=utf-8',
    });
    res.write(sseChunk({ content }, null));
    res.write(sseChunk({}, 'stop'));
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('model mock got no TCP port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => {
      for (const response of open) response.destroy();
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}

function memoryRequestsQuoting(mock: ModelMock, marker: string): RecordedRequest[] {
  return mock.requests.filter((r) => r.isMemoryExtraction && r.userText.includes(marker));
}

function composerInput(page: Page): Locator {
  return page.getByPlaceholder(CHAT_PLACEHOLDER);
}

function composerModelButton(page: Page, label: string): Locator {
  return page.getByTestId('composer-toolbar').locator(`button[title="${label}"]`);
}

/** Add provider B next to the configured provider A and reload. */
async function addProviderB(page: Page, baseUrl: string): Promise<void> {
  await Promise.all([page.waitForEvent('load'), page.evaluate(async (config) => {
    await navigator.locks.request('abu-browser-permission-config-v2', () => {
      const raw = window.localStorage.getItem('abu-settings');
      if (!raw) throw new Error('abu-settings was not initialized before E2E configuration');
      const persisted = JSON.parse(raw) as { state: { providers: Array<Record<string, unknown>> } };
      const [providerA] = persisted.state.providers;
      const [modelA] = providerA.models as Array<Record<string, unknown>>;
      persisted.state.providers.push({
        ...providerA,
        id: config.id,
        name: config.name,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        models: [{ ...modelA, id: config.modelId, label: config.modelLabel }],
        defaultModelId: config.modelId,
        sortOrder: 1,
      });
      // Write back whole, version untouched (see configureLocalMockProvider).
      window.localStorage.setItem('abu-settings', JSON.stringify(persisted));
      window.location.reload();
    });
  }, { ...PROVIDER_B, baseUrl })]);
  await expect(composerInput(page)).toBeVisible({ timeout: READY_TIMEOUT });
}

async function send(page: Page, marker: string, reply: string): Promise<void> {
  const input = composerInput(page);
  await input.fill(marker);
  await input.press('Enter');
  await expect(page.getByText(reply, { exact: true }).last()).toBeVisible({ timeout: READY_TIMEOUT });
  await expect(page.getByRole('button', { name: '停止' })).toHaveCount(0, { timeout: READY_TIMEOUT });
}

test.describe('background calls follow the conversation', () => {
  let app: ElectronApplication | undefined;
  let dataRoot: ElectronDataRoot | undefined;
  let mockA: ModelMock | undefined;
  let mockB: ModelMock | undefined;

  test.afterEach(async () => {
    const testInfo = test.info();
    const [openApp, openMockA, openMockB, openDataRoot] = [app, mockA, mockB, dataRoot];
    app = undefined;
    mockA = undefined;
    mockB = undefined;
    dataRoot = undefined;
    try {
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('mock-requests.json', {
          body: JSON.stringify({ a: openMockA?.requests, b: openMockB?.requests }, null, 2),
          contentType: 'application/json',
        });
      }
      if (openApp) await closeAbuElectron(openApp);
    } finally {
      try {
        await Promise.allSettled([openMockA?.close(), openMockB?.close()]);
      } finally {
        if (openDataRoot) removeElectronDataRoot(openDataRoot);
      }
    }
  });

  test('memory extraction for a conversation moved to provider B goes to B with B\'s key, never to the default A', async () => {
    test.setTimeout(300_000);
    const a = await startModelMock('MOCK-A-REPLY');
    const b = await startModelMock('MOCK-B-REPLY');
    mockA = a;
    mockB = b;
    dataRoot = createElectronDataRoot();
    const launched = await launchAbuElectron(dataRoot);
    app = launched.app;
    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await app.evaluate(({ BrowserWindow }) => {
      const [win] = BrowserWindow.getAllWindows();
      if (win.isMaximized()) win.unmaximize();
      win.setContentSize(1440, 960);
    });
    await page.waitForLoadState('domcontentloaded');
    await expect(composerInput(page)).toBeVisible({ timeout: READY_TIMEOUT });
    await dismissFirstRunOverlays(page);
    await configureLocalMockProvider(page, a.baseUrl, {
      apiKey: PROVIDER_A.apiKey,
      providerId: PROVIDER_A.id,
      providerName: PROVIDER_A.name,
      modelId: PROVIDER_A.modelId,
      modelLabel: PROVIDER_A.modelLabel,
      supportsTools: true,
    });
    await addProviderB(page, b.baseUrl);
    await expect(composerModelButton(page, PROVIDER_A.modelLabel)).toBeVisible({ timeout: READY_TIMEOUT });

    await test.step('the conversation starts on the default provider A', async () => {
      await send(page, 'bcf-turn-1 on the default', 'MOCK-A-REPLY');
    });

    await test.step('the conversation is moved to provider B while A stays the default', async () => {
      await composerModelButton(page, PROVIDER_A.modelLabel).click();
      const row = page.locator('div[role="button"]').filter({ hasText: /^Model B$/ }).last();
      await expect(row).toBeVisible();
      await row.click();
      await expect(composerModelButton(page, PROVIDER_B.modelLabel)).toBeVisible();
      // The extractor reads the transcript from disk once a turn completes and
      // needs four messages there; the reply of the turn that just ended may
      // still be on its way to disk, so two more turns make sure it runs with
      // enough persisted history.
      await send(page, 'bcf-turn-2 my favourite editor is vim and I always use it', 'MOCK-B-REPLY');
      await send(page, 'bcf-turn-3 please remember that I prefer short answers', 'MOCK-B-REPLY');
    });

    await test.step('the extractor quotes this conversation to B, with B\'s key, and never to A', async () => {
      const marker = 'bcf-turn-2';
      const summary = () => JSON.stringify({
        a: a.requests.map((r) => ({ memory: r.isMemoryExtraction, model: r.model, text: r.userText.slice(0, 80) })),
        b: b.requests.map((r) => ({ memory: r.isMemoryExtraction, model: r.model, text: r.userText.slice(0, 80) })),
      });
      const deadline = Date.now() + EXTRACTION_TIMEOUT;
      while (memoryRequestsQuoting(b, marker).length === 0 && Date.now() < deadline) {
        await page.waitForTimeout(500);
      }
      expect(memoryRequestsQuoting(b, marker).length, summary()).toBeGreaterThan(0);
      const toB = memoryRequestsQuoting(b, marker);
      expect(toB.map((r) => r.authorization)).toEqual(toB.map(() => `Bearer ${PROVIDER_B.apiKey}`));
      expect(toB.map((r) => r.model)).toEqual(toB.map(() => PROVIDER_B.modelId));
      expect(memoryRequestsQuoting(a, marker)).toEqual([]);
      expect(a.requests.some((r) => r.authorization.includes(PROVIDER_B.apiKey))).toBe(false);
      expect(b.requests.some((r) => r.authorization.includes(PROVIDER_A.apiKey))).toBe(false);
    });
  });
});
