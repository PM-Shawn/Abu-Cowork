/**
 * A provider deleted while a task is already running, through the real Electron
 * renderer and sidecar.
 *
 * The run itself keeps the model it started on (its entry snapshot), so the
 * parent turn after the tool result still goes to that model. A delegate
 * dispatched AFTER the deletion must never reach a model endpoint: the only
 * model endpoint here is a loopback OpenAI-compatible mock that records every
 * request, so "the delegate was never called" is asserted against the wire.
 *
 * The parent's response is held open until the test has deleted the provider,
 * which is what puts the deletion inside the run rather than before it.
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

const PROVIDER_A = { id: 'prm-prov-a', name: 'PRM Provider A', modelId: 'prm-model-a', modelLabel: 'PRM Model A' };
const PROVIDER_B = { id: 'prm-prov-b', name: 'PRM Provider B', modelId: 'prm-model-b', modelLabel: 'PRM Model B' };

const DELEGATE_TRIGGER = 'prm-delegate-trigger';
const SUBTASK_MARKER = 'prm-subtask-marker';
const PARENT_DONE = 'prm parent finished';
const SUBAGENT_REPLY = 'prm subagent replied';

// The memory extractor quotes the whole transcript (markers included) in one
// user message, so it must be recognized before any marker-based branch.
const MEMORY_EXTRACTOR_PROMPT = '记忆提取助手';

type RequestKind = 'delegate-start' | 'subagent' | 'parent-after-tool' | 'aux';

interface RecordedRequest {
  kind: RequestKind;
  model: unknown;
  /** For `parent-after-tool`: what the delegate handed back to the parent. */
  toolResultText: string;
}

interface ModelMock {
  baseUrl: string;
  close: () => Promise<void>;
  requests: RecordedRequest[];
  /** Resolves once a request of that kind has been received. */
  waitFor: (kind: RequestKind) => Promise<void>;
  /** Let the held `delegate-start` response go out. */
  releaseDelegateStart: () => void;
}

interface ChatMessage {
  role?: unknown;
  content?: unknown;
}

function messageText(message: ChatMessage): string {
  return typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
}

function classify(body: Record<string, unknown>): RequestKind {
  const messages = Array.isArray(body.messages) ? (body.messages as ChatMessage[]) : [];
  const system = messages.filter((m) => m.role === 'system').map(messageText).join('\n');
  if (system.includes(MEMORY_EXTRACTOR_PROMPT)) return 'aux';
  const userTexts = messages.filter((m) => m.role === 'user').map(messageText);
  if (messages.some((m) => m.role === 'tool')) return 'parent-after-tool';
  if (userTexts.some((text) => text.includes(SUBTASK_MARKER))) return 'subagent';
  if ((userTexts.at(-1) ?? '').includes(DELEGATE_TRIGGER)) return 'delegate-start';
  return 'aux';
}

function sseChunk(modelId: string, delta: Record<string, unknown>, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-abu-e2e-prm',
    object: 'chat.completion.chunk',
    created: 0,
    model: modelId,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

async function startModelMock(): Promise<ModelMock> {
  const requests: RecordedRequest[] = [];
  const activeResponses = new Set<ServerResponse>();
  const seen = new Map<RequestKind, () => void>();
  let releaseDelegateStart: () => void = () => {};
  const delegateStartGate = new Promise<void>((resolve) => { releaseDelegateStart = resolve; });

  const server: Server = createServer(async (req, res) => {
    activeResponses.add(res);
    res.once('close', () => activeResponses.delete(res));
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // Recorded as aux with an undefined model; assertions will surface it.
    }
    const modelId = typeof body.model === 'string' ? body.model : 'unknown-model';
    const kind = classify(body);
    const messages = Array.isArray(body.messages) ? (body.messages as ChatMessage[]) : [];
    requests.push({
      kind,
      model: body.model,
      toolResultText: messages.filter((m) => m.role === 'tool').map(messageText).join('\n'),
    });
    seen.get(kind)?.();

    let content: string | null;
    let toolCall: Record<string, unknown> | null = null;
    switch (kind) {
      case 'delegate-start':
        // Held so the provider can be deleted while this run is in flight.
        await delegateStartGate;
        content = null;
        toolCall = {
          index: 0,
          id: 'call_prm_delegate_1',
          type: 'function',
          function: {
            name: 'delegate_to_agent',
            arguments: JSON.stringify({ type: 'research', task: `Reply with one word. ${SUBTASK_MARKER}` }),
          },
        };
        break;
      case 'subagent': content = SUBAGENT_REPLY; break;
      case 'parent-after-tool': content = PARENT_DONE; break;
      default: content = '[]';
    }

    if (body.stream === false) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        id: 'chatcmpl-abu-e2e-prm',
        object: 'chat.completion',
        created: 0,
        model: modelId,
        choices: [{
          index: 0,
          message: toolCall
            ? { role: 'assistant', content: null, tool_calls: [{ ...toolCall, index: undefined }] }
            : { role: 'assistant', content },
          finish_reason: toolCall ? 'tool_calls' : 'stop',
        }],
      }));
      return;
    }
    res.writeHead(200, {
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'content-type': 'text/event-stream; charset=utf-8',
    });
    if (toolCall) {
      res.write(sseChunk(modelId, { tool_calls: [toolCall] }, null));
      res.write(sseChunk(modelId, {}, 'tool_calls'));
    } else {
      res.write(sseChunk(modelId, { content }, null));
      res.write(sseChunk(modelId, {}, 'stop'));
    }
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
    releaseDelegateStart: () => releaseDelegateStart(),
    waitFor: (kind) => requests.some((r) => r.kind === kind)
      ? Promise.resolve()
      : new Promise<void>((resolve) => seen.set(kind, resolve)),
    close: () => new Promise<void>((resolve) => {
      releaseDelegateStart();
      for (const response of activeResponses) response.destroy();
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}

function countOf(mock: ModelMock, kind: RequestKind): number {
  return mock.requests.filter((r) => r.kind === kind).length;
}

function composerInput(page: Page): Locator {
  return page.getByPlaceholder(CHAT_PLACEHOLDER);
}

function composerModelButton(page: Page, label: string): Locator {
  return page.getByTestId('composer-toolbar').locator(`button[title="${label}"]`);
}

function providerCard(dialog: Locator, name: string): Locator {
  return dialog.locator('div.group', { hasText: name }).first();
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

async function openModelSettings(page: Page): Promise<Locator> {
  const sidebarToggle = page.locator('[data-window-control="sidebar"]').first();
  if (/^显示/.test((await sidebarToggle.getAttribute('aria-label')) ?? '')) {
    await sidebarToggle.click();
    await expect(sidebarToggle).not.toHaveAttribute('aria-label', /^显示/);
  }
  await page.getByRole('button', { name: '我', exact: true }).first().click();
  await page.getByText('设置', { exact: true }).last().click();
  const dialog = page.locator('[data-abu-settings-dialog]');
  await expect(dialog).toBeVisible({ timeout: READY_TIMEOUT });
  await dialog.getByText('模型', { exact: true }).first().click();
  await expect(providerCard(dialog, PROVIDER_A.name)).toBeVisible({ timeout: READY_TIMEOUT });
  return dialog;
}

async function closeSettings(page: Page): Promise<void> {
  await page.locator('[data-abu-settings-close]').click();
  await expect(page.locator('[data-abu-settings-dialog]')).toHaveCount(0);
}

test.describe('provider deleted mid-run', () => {
  let app: ElectronApplication | undefined;
  let dataRoot: ElectronDataRoot | undefined;
  let mock: ModelMock | undefined;

  test.afterEach(async () => {
    const testInfo = test.info();
    const [openApp, openMock, openDataRoot] = [app, mock, dataRoot];
    app = undefined;
    mock = undefined;
    dataRoot = undefined;
    // Each step runs even if an earlier one throws, so nothing leaks.
    try {
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('mock-requests.json', {
          body: JSON.stringify(openMock?.requests, null, 2),
          contentType: 'application/json',
        });
      }
      if (openApp) await closeAbuElectron(openApp);
    } finally {
      try {
        await openMock?.close();
      } finally {
        if (openDataRoot) removeElectronDataRoot(openDataRoot);
      }
    }
  });

  test('a delegate dispatched after the deletion never reaches a model', async () => {
    test.setTimeout(300_000);
    const m = await startModelMock();
    mock = m;
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
    await configureLocalMockProvider(page, m.baseUrl, {
      providerId: PROVIDER_A.id,
      providerName: PROVIDER_A.name,
      modelId: PROVIDER_A.modelId,
      modelLabel: PROVIDER_A.modelLabel,
      supportsTools: true,
    });
    // Provider B stays enabled so deleting A re-points the GLOBAL default to
    // it — the delegate must still not move onto that model.
    await addProviderB(page, m.baseUrl);
    await expect(composerModelButton(page, PROVIDER_A.modelLabel)).toBeVisible({ timeout: READY_TIMEOUT });

    await test.step('the run starts on Model A and is held at the first turn', async () => {
      const input = composerInput(page);
      await input.fill(DELEGATE_TRIGGER);
      await input.press('Enter');
      await m.waitFor('delegate-start');
      expect(m.requests.filter((r) => r.kind === 'delegate-start').map((r) => r.model))
        .toEqual([PROVIDER_A.modelId]);
      await expect(page.getByRole('button', { name: '停止' })).toBeVisible({ timeout: READY_TIMEOUT });
    });

    await test.step('provider A is deleted while that run is still in flight', async () => {
      const dialog = await openModelSettings(page);
      const card = providerCard(dialog, PROVIDER_A.name);
      await card.hover();
      await card.getByTitle('删除', { exact: true }).click();
      await page.getByRole('button', { name: '确认', exact: true }).last().click();
      await expect(dialog.locator('div.group', { hasText: PROVIDER_A.name })).toHaveCount(0);
      await closeSettings(page);
      expect(countOf(m, 'subagent')).toBe(0);
    });

    await test.step('the delegate is refused and never calls a model', async () => {
      m.releaseDelegateStart();

      // The parent run keeps its own model (entry snapshot), so its turn after
      // the tool result is what carries the delegate's refusal back.
      await m.waitFor('parent-after-tool');
      await expect(page.getByText(PARENT_DONE, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
      await expect(page.getByRole('button', { name: '停止' })).toHaveCount(0, { timeout: READY_TIMEOUT });

      const afterTool = m.requests.filter((r) => r.kind === 'parent-after-tool');
      expect(afterTool.map((r) => r.model)).toEqual([PROVIDER_A.modelId]);
      expect(afterTool[0].toolResultText).toContain('所属服务已删除');
      // The proof: no delegate request on the wire, on any model.
      expect(countOf(m, 'subagent')).toBe(0);
      expect(m.requests.filter((r) => r.model === PROVIDER_B.modelId)).toEqual([]);
      await expect(page.getByText(SUBAGENT_REPLY, { exact: true })).toHaveCount(0);
    });
  });
});
