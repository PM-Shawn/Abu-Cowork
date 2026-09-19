/**
 * A conversation pinned to a model whose provider was turned off or deleted
 * must not send, through the real Electron renderer and sidecar.
 *
 * Two loopback OpenAI-compatible mocks stand in for provider A and provider B
 * and record every request, so "nothing was sent" is asserted against what
 * actually reached a model endpoint, not only against the UI.
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
const CHAT_PLACEHOLDER = '想让阿布帮你做点什么？';

const PROVIDER_A = { id: 'spm-prov-a', name: 'SPM Provider A', modelId: 'model-a', modelLabel: 'Model A' };
const PROVIDER_B = { id: 'spm-prov-b', name: 'SPM Provider B', modelId: 'model-b', modelLabel: 'Model B' };

// The memory extractor quotes the transcript in its own request; it is
// background traffic, not a task turn.
const MEMORY_EXTRACTOR_PROMPT = '记忆提取助手';
const MARKER_PREFIX = 'spm-hello-';

interface RecordedRequest {
  /** A real agent turn: tools declared, not the memory extractor. */
  isTask: boolean;
  lastUser: string;
  model: unknown;
}

interface ModelMock {
  baseUrl: string;
  close: () => Promise<void>;
  requests: RecordedRequest[];
}

interface ChatMessage {
  role?: unknown;
  content?: unknown;
}

function messageText(message: ChatMessage): string {
  return typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
}

function sseChunk(delta: Record<string, unknown>, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-abu-e2e-spm',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'spm-mock',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

async function startModelMock(reply: string): Promise<ModelMock> {
  const requests: RecordedRequest[] = [];
  const activeResponses = new Set<ServerResponse>();
  const server: Server = createServer(async (req, res) => {
    activeResponses.add(res);
    res.once('close', () => activeResponses.delete(res));
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // Recorded with an undefined model; assertions will surface it.
    }
    const messages = Array.isArray(body.messages) ? (body.messages as ChatMessage[]) : [];
    const system = messages.filter((m) => m.role === 'system').map(messageText).join('\n');
    const isMemory = system.includes(MEMORY_EXTRACTOR_PROMPT);
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    const lastUser = messages.filter((m) => m.role === 'user').map(messageText).at(-1) ?? '';
    requests.push({ isTask: hasTools && !isMemory, lastUser, model: body.model });

    const content = isMemory ? '[]' : reply;
    if (body.stream === false) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        id: 'chatcmpl-abu-e2e-spm',
        object: 'chat.completion',
        created: 0,
        model: 'spm-mock',
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
      for (const response of activeResponses) response.destroy();
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}

function taskCount(mock: ModelMock): number {
  return mock.requests.filter((r) => r.isTask).length;
}

/** Any request, of any kind, whose latest user text carries `marker`. */
function requestsWith(mock: ModelMock, marker: string): RecordedRequest[] {
  return mock.requests.filter((r) => r.lastUser.includes(marker));
}

function composerInput(page: Page): Locator {
  return page.getByPlaceholder(CHAT_PLACEHOLDER);
}

/** Rendered chat messages (user bubbles included) that contain `text`. */
function messagesWith(page: Page, text: string): Locator {
  return page.locator('[data-message-id]').filter({ hasText: text });
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

function providerCard(dialog: Locator, name: string): Locator {
  return dialog.locator('div.group', { hasText: name }).first();
}

async function openModelSettings(page: Page): Promise<Locator> {
  const sidebarToggle = page.locator('[data-window-control="sidebar"]').first();
  if (/^显示/.test((await sidebarToggle.getAttribute('aria-label')) ?? '')) {
    await sidebarToggle.click();
    await expect(sidebarToggle).not.toHaveAttribute('aria-label', /^显示/);
  }
  await page.getByRole('button', { name: /^(我|Me|登录 \/ 注册|Sign in \/ Sign up)$/ }).first().click();
  await page.getByText('设置', { exact: true }).last().click();
  const dialog = page.locator('[data-abu-settings-dialog]');
  await expect(dialog).toBeVisible({ timeout: READY_TIMEOUT });
  await dialog.getByText('模型', { exact: true }).first().click();
  await expect(providerCard(dialog, PROVIDER_B.name)).toBeVisible({ timeout: READY_TIMEOUT });
  return dialog;
}

async function closeSettings(page: Page): Promise<void> {
  await page.locator('[data-abu-settings-close]').click();
  await expect(page.locator('[data-abu-settings-dialog]')).toHaveCount(0);
}

/**
 * Send `marker` and prove it was blocked: the toast shows, the text stays in
 * the composer, no user bubble or run appears, and neither mock saw it.
 */
async function expectBlockedSend(
  page: Page,
  marker: string,
  toast: string,
  mocks: ModelMock[],
): Promise<void> {
  const before = mocks.map(taskCount);
  const input = composerInput(page);
  await input.fill(marker);
  await input.press('Enter');

  await expect(page.getByRole('status').getByText(toast, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
  await expect(input).toHaveValue(marker);
  await expect(messagesWith(page, marker)).toHaveCount(0);
  await expect(page.getByRole('button', { name: '停止' })).toHaveCount(0);
  // The block decision is made before any dispatch and the toast is its
  // visible result, so a request that escaped the gate would already be on
  // the wire. This short settle only lets such a request reach the loopback
  // mock; the proof of blocking is the toast above, not the wait.
  await page.waitForTimeout(1_000);
  expect(mocks.map(taskCount)).toEqual(before);
  for (const mock of mocks) expect(requestsWith(mock, marker)).toEqual([]);
}

test.describe('stale provider pin', () => {
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
    // Each step runs even if an earlier one throws, so no mock or data root leaks.
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

  test('a turned-off or deleted provider blocks the send; switching the model recovers', async () => {
    test.setTimeout(300_000);
    const a = await startModelMock('MOCK-A-REPLY');
    const b = await startModelMock('MOCK-B-REPLY');
    mockA = a;
    mockB = b;
    const mocks = [a, b];
    dataRoot = createElectronDataRoot();
    const launched = await launchAbuElectron(dataRoot);
    app = launched.app;
    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    // The settings dialog and composer toolbar need a desktop-sized window.
    await app.evaluate(({ BrowserWindow }) => {
      const [win] = BrowserWindow.getAllWindows();
      if (win.isMaximized()) win.unmaximize();
      win.setContentSize(1440, 960);
    });
    await page.waitForLoadState('domcontentloaded');
    await expect(composerInput(page)).toBeVisible({ timeout: READY_TIMEOUT });
    await dismissFirstRunOverlays(page);
    await configureLocalMockProvider(page, a.baseUrl, {
      providerId: PROVIDER_A.id,
      providerName: PROVIDER_A.name,
      modelId: PROVIDER_A.modelId,
      modelLabel: PROVIDER_A.modelLabel,
      supportsTools: true,
    });
    await addProviderB(page, b.baseUrl);
    await expect(composerModelButton(page, 'Model A')).toBeVisible({ timeout: READY_TIMEOUT });

    await test.step('the conversation is pinned to Model A', async () => {
      const marker = `${MARKER_PREFIX}1`;
      const input = composerInput(page);
      await input.fill(marker);
      await input.press('Enter');
      await expect(page.getByText('MOCK-A-REPLY', { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
      await expect(page.getByRole('button', { name: '停止' })).toHaveCount(0, { timeout: READY_TIMEOUT });
      // Sent turns render as messages; the blocked-send checks rely on this.
      await expect(messagesWith(page, marker)).not.toHaveCount(0);
      expect(requestsWith(a, marker).filter((r) => r.isTask).map((r) => r.model)).toEqual([PROVIDER_A.modelId]);
      expect(taskCount(b)).toBe(0);
    });

    await test.step('turning provider A off blocks the send', async () => {
      const dialog = await openModelSettings(page);
      const toggle = providerCard(dialog, PROVIDER_A.name).getByRole('switch');
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      await closeSettings(page);

      await expect(composerModelButton(page, 'Model A（不可用）')).toBeVisible();
      await expectBlockedSend(page, `${MARKER_PREFIX}2`, '模型「Model A」所属服务已关闭，请换一个模型再发送', mocks);
      await expect(composerModelButton(page, 'Model A（不可用）')).toBeVisible();
    });

    await test.step('deleting provider A blocks the send', async () => {
      const dialog = await openModelSettings(page);
      const card = providerCard(dialog, PROVIDER_A.name);
      await card.hover();
      await card.getByTitle('删除', { exact: true }).click();
      await page.getByRole('button', { name: '确认', exact: true }).last().click();
      await expect(dialog.locator('div.group', { hasText: PROVIDER_A.name })).toHaveCount(0);
      await closeSettings(page);

      // With the provider gone the label falls back to the model id.
      await expect(composerModelButton(page, 'model-a（不可用）')).toBeVisible();
      await expectBlockedSend(page, `${MARKER_PREFIX}3`, '模型「model-a」所属服务已删除，请换一个模型再发送', mocks);
      await expect(composerModelButton(page, 'model-a（不可用）')).toBeVisible();
    });

    await test.step('switching to Model B sends the kept text', async () => {
      const marker = `${MARKER_PREFIX}3`;
      const tasksOnA = taskCount(a);
      await composerModelButton(page, 'model-a（不可用）').click();
      // Picker rows are role=button divs; the provider list is the last section.
      const row = page.locator('div[role="button"]').filter({ hasText: /^Model B$/ }).last();
      await expect(row).toBeVisible();
      await row.click();
      await expect(composerModelButton(page, 'Model B')).toBeVisible();

      const input = composerInput(page);
      await expect(input).toHaveValue(marker);
      await input.press('Enter');
      await expect(page.getByText('MOCK-B-REPLY', { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
      expect(requestsWith(b, marker).filter((r) => r.isTask).map((r) => r.model)).toEqual([PROVIDER_B.modelId]);
      expect(taskCount(a)).toBe(tasksOnA);
    });
  });
});
