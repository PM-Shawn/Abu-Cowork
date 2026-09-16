/**
 * Per-conversation model scope (issue #545) through the real Electron renderer,
 * sidecar, and conversation storage.
 *
 * - The global model is only the default for NEW conversations; it changes
 *   only when a model is picked on the new-task page.
 * - A pick inside a conversation changes that conversation alone.
 * - Every chat request (including a delegate's) runs on the conversation's model.
 *
 * The only model endpoint is a loopback OpenAI-compatible mock that records the
 * `model` field of every request, so assertions are about what was actually
 * sent, not only what the composer label says.
 */
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
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

const READY_TIMEOUT = 45_000;
const CHAT_PLACEHOLDER = '想让阿布帮你做点什么？';
// Evidence screenshots stay outside the repo; override with ABU_E2E_SCREENSHOT_DIR.
const SCREENSHOT_DIR = process.env.ABU_E2E_SCREENSHOT_DIR
  ?? path.join(os.tmpdir(), 'abu-e2e-conversation-model-scope');

const MODEL_X = { id: 'cms-model-x', label: 'Scope Model X' };
const MODEL_Y = { id: 'cms-model-y', label: 'Scope Model Y' };
const MODEL_Z = { id: 'cms-model-z', label: 'Scope Model Z' };

const DELEGATE_TRIGGER = 'cms-delegate-trigger';
const SUBTASK_MARKER = 'cms-subtask-marker';
const PARENT_DONE_PREFIX = 'cms parent finished via';
const SUBAGENT_DONE_PREFIX = 'cms subagent finished via';

type RequestKind = 'task' | 'delegate-start' | 'subagent' | 'parent-after-tool' | 'aux';

interface RecordedRequest {
  kind: RequestKind;
  marker: string | null;
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

function classify(body: Record<string, unknown>): { kind: RequestKind; marker: string | null } {
  const messages = Array.isArray(body.messages) ? (body.messages as ChatMessage[]) : [];
  const userTexts = messages.filter((m) => m.role === 'user').map(messageText);
  if (messages.some((m) => m.role === 'tool')) return { kind: 'parent-after-tool', marker: null };
  if (userTexts.some((text) => text.includes(SUBTASK_MARKER))) return { kind: 'subagent', marker: null };
  const lastUser = userTexts.at(-1) ?? '';
  if (lastUser.includes(DELEGATE_TRIGGER)) return { kind: 'delegate-start', marker: DELEGATE_TRIGGER };
  // A task prompt is exactly `cms-<letter><digits>`; the memory extractor
  // quotes the conversation too, so it is excluded by its system prompt.
  const marker = /(?:^|\s)(cms-[a-z]\d+)(?:\s|$)/.exec(lastUser)?.[1] ?? null;
  const system = messages.filter((m) => m.role === 'system').map(messageText).join('\n');
  if (marker && !system.includes('记忆提取助手')) return { kind: 'task', marker };
  return { kind: 'aux', marker: null };
}

function replyFor(marker: string, modelId: string): string {
  return `reply ${marker} via ${modelId}`;
}

function sseChunk(modelId: string, delta: Record<string, unknown>, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-abu-e2e-cms',
    object: 'chat.completion.chunk',
    created: 0,
    model: modelId,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

async function startModelMock(): Promise<ModelMock> {
  const requests: RecordedRequest[] = [];
  const activeResponses = new Set<ServerResponse>();
  let toolCallCounter = 0;
  const server: Server = createServer(async (req, res) => {
    activeResponses.add(res);
    res.once('close', () => activeResponses.delete(res));
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (req.method !== 'POST' || pathname !== '/v1/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unexpected local E2E mock route' }));
      return;
    }
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // Recorded as aux with an undefined model; assertions will surface it.
    }
    const modelId = typeof body.model === 'string' ? body.model : 'unknown-model';
    const { kind, marker } = classify(body);
    requests.push({ kind, marker, model: body.model });

    let content: string | null;
    let toolCall: Record<string, unknown> | null = null;
    switch (kind) {
      case 'task': content = replyFor(marker!, modelId); break;
      case 'delegate-start':
        content = null;
        toolCall = {
          index: 0,
          id: `call_cms_delegate_${++toolCallCounter}`,
          type: 'function',
          function: {
            name: 'delegate_to_agent',
            arguments: JSON.stringify({ type: 'writer', task: `Reply with one word. ${SUBTASK_MARKER}` }),
          },
        };
        break;
      case 'subagent': content = `${SUBAGENT_DONE_PREFIX} ${modelId}`; break;
      case 'parent-after-tool': content = `${PARENT_DONE_PREFIX} ${modelId}`; break;
      default: content = '[]';
    }

    if (body.stream === false) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        id: 'chatcmpl-abu-e2e-cms',
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
    close: () => new Promise<void>((resolve) => {
      for (const response of activeResponses) response.destroy();
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}

function modelsFor(mock: ModelMock, marker: string): unknown[] {
  return mock.requests.filter((r) => r.kind === 'task' && r.marker === marker).map((r) => r.model);
}

/** True once any messages.jsonl under the app data root contains `text`. */
function diskContains(rootDir: string, text: string): boolean {
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
        return fs.readFileSync(entryPath, 'utf8').includes(text);
      } catch {
        return false;
      }
    });
  };
  return visit(rootDir);
}

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}.png`) });
}

function composerModelButton(page: Page) {
  return page.getByTestId('composer-toolbar').locator('button[title]').filter({
    hasText: /^Scope Model [XYZ]$/,
  });
}

async function expectComposerModel(page: Page, label: string): Promise<void> {
  await expect(composerModelButton(page)).toHaveText(label, { timeout: READY_TIMEOUT });
}

async function pickModel(page: Page, label: string): Promise<void> {
  await composerModelButton(page).click();
  // Rows are role=button divs; the toolbar trigger is a real <button>. The
  // provider list is the last section, so `.last()` skips the Recent entry.
  const row = page.locator('div[role="button"]').filter({ hasText: new RegExp(`^${label}$`) }).last();
  await expect(row).toBeVisible();
  await row.click();
  await expectComposerModel(page, label);
}

async function sendAndAwait(page: Page, marker: string, modelId: string, mock: ModelMock): Promise<void> {
  const before = modelsFor(mock, marker).length;
  const input = page.getByPlaceholder(CHAT_PLACEHOLDER);
  await input.fill(marker);
  await input.press('Enter');
  await expect(page.getByText(replyFor(marker, modelId), { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
  const models = modelsFor(mock, marker);
  expect(models.length).toBe(before + 1);
  expect(models.at(-1)).toBe(modelId);
  // The run is finished: the composer is idle again before the next step.
  await expect(page.getByRole('button', { name: '停止' })).toHaveCount(0, { timeout: READY_TIMEOUT });
}

/** The sidebar starts collapsed once a conversation is open; expand it if so. */
async function ensureSidebar(page: Page): Promise<void> {
  const showSidebar = page.getByTitle('显示侧栏', { exact: true });
  if (await showSidebar.isVisible()) await showSidebar.click();
  await expect(page.getByTitle('显示侧栏', { exact: true })).toHaveCount(0);
}

async function openConversation(page: Page, title: string): Promise<void> {
  await ensureSidebar(page);
  const row = page.getByRole('button', { name: new RegExp(`^${title}`) }).first();
  await expect(row).toBeVisible({ timeout: READY_TIMEOUT });
  await row.click();
  await expect(page.getByText(title, { exact: true }).first()).toBeVisible({ timeout: READY_TIMEOUT });
}

async function openNewTask(page: Page): Promise<void> {
  await ensureSidebar(page);
  await page.getByRole('button', { name: '新任务', exact: true }).first().click();
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible({ timeout: READY_TIMEOUT });
}

async function launchConfigured(dataRoot: ElectronDataRoot, mock: ModelMock): Promise<{ app: ElectronApplication; page: Page }> {
  const { app } = await launchAbuElectron(dataRoot);
  const page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible({ timeout: READY_TIMEOUT });
  await dismissFirstRunOverlays(page);
  await configureLocalMockProvider(page, mock.baseUrl, {
    modelId: MODEL_X.id,
    modelLabel: MODEL_X.label,
    extraModels: [MODEL_Y, MODEL_Z],
    permissionMode: 'standard',
    providerName: 'Abu E2E model-scope loopback',
    supportsTools: true,
  });
  return { app, page };
}

test.describe('per-conversation model scope (#545)', () => {
  let app: ElectronApplication | undefined;
  let dataRoot: ElectronDataRoot | undefined;
  let mock: ModelMock | undefined;

  test.afterEach(async () => {
    const testInfo = test.info();
    if (mock && testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('mock-requests.json', {
        body: JSON.stringify(mock.requests, null, 2),
        contentType: 'application/json',
      });
    }
    if (app) await closeAbuElectron(app);
    app = undefined;
    if (mock) await mock.close();
    mock = undefined;
    if (dataRoot) removeElectronDataRoot(dataRoot);
    dataRoot = undefined;
  });

  test('a pick scopes to its conversation, new tasks keep the default, and both survive a restart', async () => {
    test.setTimeout(300_000);
    mock = await startModelMock();
    dataRoot = createElectronDataRoot();
    const first = await launchConfigured(dataRoot, mock);
    app = first.app;
    let page = first.page;

    // 1. New-task page default X → the first request uses X.
    await expectComposerModel(page, MODEL_X.label);
    await shot(page, '01-new-task-default-x');
    await sendAndAwait(page, 'cms-a1', MODEL_X.id, mock);
    await expectComposerModel(page, MODEL_X.label);

    // 2. Pick Y inside conversation A → A runs on Y; the new-task default stays X.
    await pickModel(page, MODEL_Y.label);
    await sendAndAwait(page, 'cms-a2', MODEL_Y.id, mock);
    await shot(page, '02-conv-a-switched-to-y');

    await openNewTask(page);
    await expectComposerModel(page, MODEL_X.label);
    await shot(page, '03-new-task-still-x');
    await sendAndAwait(page, 'cms-b1', MODEL_X.id, mock);
    await expectComposerModel(page, MODEL_X.label);

    // 3. Switching conversations shows and uses each one's own model.
    await openConversation(page, 'cms-a1');
    await expectComposerModel(page, MODEL_Y.label);
    await sendAndAwait(page, 'cms-a3', MODEL_Y.id, mock);

    // Picking Z in A leaves B (and the default) untouched.
    await pickModel(page, MODEL_Z.label);
    await shot(page, '04-conv-a-z');
    await openConversation(page, 'cms-b1');
    await expectComposerModel(page, MODEL_X.label);
    await sendAndAwait(page, 'cms-b2', MODEL_X.id, mock);
    await shot(page, '05-conv-b-still-x');

    // Picking Y in B leaves A on Z.
    await pickModel(page, MODEL_Y.label);
    await openConversation(page, 'cms-a1');
    await expectComposerModel(page, MODEL_Z.label);
    await sendAndAwait(page, 'cms-a4', MODEL_Z.id, mock);
    await openConversation(page, 'cms-b1');
    await expectComposerModel(page, MODEL_Y.label);
    await sendAndAwait(page, 'cms-b3', MODEL_Y.id, mock);

    await openNewTask(page);
    await expectComposerModel(page, MODEL_X.label);
    const persistedDefault = await page.evaluate(() => {
      const raw = window.localStorage.getItem('abu-settings');
      return raw ? (JSON.parse(raw) as { state: { activeModel?: unknown } }).state.activeModel : null;
    });
    expect(persistedDefault).toMatchObject({ modelId: MODEL_X.id });

    // Only task requests matter here; no request of any kind ever used an unknown model.
    const knownModels = [MODEL_X.id, MODEL_Y.id, MODEL_Z.id];
    for (const request of mock.requests) expect(knownModels).toContain(request.model);

    // 5. Restart with the same data root: each conversation keeps its model.
    // UI visibility can precede the ledger write; quit only once both last
    // replies are on disk so the relaunch proves a fresh load.
    for (const reply of [replyFor('cms-a4', MODEL_Z.id), replyFor('cms-b3', MODEL_Y.id)]) {
      await expect.poll(() => diskContains(dataRoot!.appDataDir, reply), { timeout: READY_TIMEOUT }).toBe(true);
    }
    await closeAbuElectron(app);
    app = undefined;
    const second = await launchAbuElectron(dataRoot);
    app = second.app;
    page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible({ timeout: READY_TIMEOUT });
    await expectComposerModel(page, MODEL_X.label);

    await openConversation(page, 'cms-a1');
    await expectComposerModel(page, MODEL_Z.label);
    await expect(page.getByText(replyFor('cms-a4', MODEL_Z.id), { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    await shot(page, '06-after-restart-conv-a-z');
    await sendAndAwait(page, 'cms-a5', MODEL_Z.id, mock);

    await openConversation(page, 'cms-b1');
    await expectComposerModel(page, MODEL_Y.label);
    await expect(page.getByText(replyFor('cms-b3', MODEL_Y.id), { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    await shot(page, '07-after-restart-conv-b-y');
    await sendAndAwait(page, 'cms-b4', MODEL_Y.id, mock);

    await openNewTask(page);
    await expectComposerModel(page, MODEL_X.label);
  });

  test('a delegate launched from a Y conversation runs on Y while the default is X', async () => {
    test.setTimeout(240_000);
    mock = await startModelMock();
    dataRoot = createElectronDataRoot();
    const launched = await launchConfigured(dataRoot, mock);
    app = launched.app;
    const page = launched.page;

    await sendAndAwait(page, 'cms-d0', MODEL_X.id, mock);
    await pickModel(page, MODEL_Y.label);

    const input = page.getByPlaceholder(CHAT_PLACEHOLDER);
    await input.fill(`Please delegate this. ${DELEGATE_TRIGGER}`);
    await input.press('Enter');
    await expect(page.getByText(`${PARENT_DONE_PREFIX} ${MODEL_Y.id}`, { exact: true }))
      .toBeVisible({ timeout: 90_000 });
    await shot(page, '08-delegate-conv-y');

    const byKind = (kind: RequestKind) => mock!.requests.filter((r) => r.kind === kind).map((r) => r.model);
    expect(byKind('delegate-start')).toEqual([MODEL_Y.id]);
    expect(byKind('subagent').length).toBeGreaterThan(0);
    for (const model of byKind('subagent')) expect(model).toBe(MODEL_Y.id);
    expect(byKind('parent-after-tool').length).toBeGreaterThan(0);
    for (const model of byKind('parent-after-tool')) expect(model).toBe(MODEL_Y.id);

    // The default for new conversations is still X.
    await openNewTask(page);
    await expectComposerModel(page, MODEL_X.label);
  });
});
