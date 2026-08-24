/**
 * Real Electron coverage for the infra-hygiene A2/A3 batch.
 *
 * This launches the actual Electron main entry and sidecar. The only model
 * endpoint is a loopback OpenAI-compatible SSE mock bound to 127.0.0.1:0.
 */
import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import os from 'node:os';
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
const TEST_API_KEY = 'abu-e2e-infra-hygiene-not-a-real-secret';
const TEST_MODEL_ID = 'abu-e2e-infra-hygiene-model';
const PROVIDER_ID = 'abu-e2e-infra-hygiene-provider';

interface MockRequest {
  authorization: string | undefined;
  body: unknown;
  pathname: string;
  purpose: 'memory' | 'task';
  responseAborted: boolean;
}

interface HoldHandle {
  release: (responseText: string) => void;
}

type MockReplyPlan =
  | { kind: 'complete'; responseText: string }
  | { kind: 'hold'; released: Promise<string> }
  | {
      kind: 'tool-call';
      arguments: Record<string, unknown>;
      toolCallId: string;
      toolName: string;
    };

interface OpenAiMock {
  baseUrl: string;
  close: () => Promise<void>;
  requests: MockRequest[];
}

interface OpenAiRequestMessage {
  role?: unknown;
  content?: unknown;
  tool_call_id?: unknown;
  tool_calls?: Array<{
    id?: unknown;
    function?: {
      name?: unknown;
      arguments?: unknown;
    };
  }>;
}

function makeHoldPlan(): { handle: HoldHandle; plan: MockReplyPlan } {
  let release!: (responseText: string) => void;
  const released = new Promise<string>((resolve) => {
    release = resolve;
  });
  return { handle: { release }, plan: { kind: 'hold', released } };
}

function sseChunk(delta: Record<string, unknown>, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-abu-e2e-infra-hygiene',
    object: 'chat.completion.chunk',
    created: 0,
    model: TEST_MODEL_ID,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function completeSse(responseText: string): string {
  return sseChunk({ content: responseText }, null) + sseChunk({}, 'stop') + 'data: [DONE]\n\n';
}

function toolCallSse(plan: Extract<MockReplyPlan, { kind: 'tool-call' }>): string {
  return sseChunk({
    tool_calls: [{
      index: 0,
      id: plan.toolCallId,
      type: 'function',
      function: { name: plan.toolName, arguments: JSON.stringify(plan.arguments) },
    }],
  }, null) + sseChunk({}, 'tool_calls') + 'data: [DONE]\n\n';
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
      // Preserve malformed input in request diagnostics.
    }

    if (req.method !== 'POST' || requestUrl.pathname !== '/v1/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unexpected local E2E mock route' }));
      return;
    }

    const mockRequest: MockRequest = {
      authorization: req.headers.authorization,
      body,
      pathname: requestUrl.pathname,
      purpose: isMemoryExtractionRequest(body) ? 'memory' : 'task',
      responseAborted: false,
    };
    requests.push(mockRequest);

    const replyPlan = mockRequest.purpose === 'memory'
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

    if (replyPlan.kind === 'hold') {
      res.once('close', () => {
        mockRequest.responseAborted = !res.writableEnded;
      });
      const responseText = await replyPlan.released;
      if (!res.destroyed && !res.writableEnded) {
        res.end(completeSse(responseText));
      }
      return;
    }

    res.end(replyPlan.kind === 'tool-call' ? toolCallSse(replyPlan) : completeSse(replyPlan.responseText));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
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
    // Numeric loopback still reaches the 127.0.0.1-only server, while avoiding
    // the local-provider heuristic that disables streaming tool calls.
    baseUrl: `http://2130706433:${address.port}/v1`,
    close: () => closeServer(server, activeResponses),
    requests,
  };
}

function closeServer(server: Server, activeResponses: ReadonlySet<ServerResponse>): Promise<void> {
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

async function waitForApp(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible({ timeout: READY_TIMEOUT });
}

async function configureLocalMockProvider(page: Page, baseUrl: string): Promise<void> {
  await page.evaluate(({ baseUrl, testApiKey, testModelId, providerId }) => {
    const raw = window.localStorage.getItem('abu-settings');
    if (!raw) throw new Error('abu-settings was not initialized before E2E configuration');
    const persisted = JSON.parse(raw) as { state: Record<string, unknown>; version: number };
    const state = persisted.state;

    state.providers = [{
      id: providerId,
      source: 'custom',
      name: 'Abu E2E infra hygiene loopback provider',
      enabled: true,
      apiFormat: 'openai-compatible',
      baseUrl,
      apiKey: testApiKey,
      models: [{
        id: testModelId,
        label: 'Abu E2E infra hygiene model',
        isCustom: true,
        declaredCapabilities: { supportsTools: true },
      }],
      defaultModelId: testModelId,
      status: 'verified',
      sortOrder: 0,
      userAdded: true,
      declaredCapabilities: { supportsTools: true },
    }];
    state.activeModel = { providerId, modelId: testModelId };
    state.recentModels = [];
    state.favoriteModels = [];
    state.permissionMode = 'standard';
    state.guideShown = true;
    state.guideOpen = false;
    state.hasAcknowledgedDisclaimer = true;
    state.hasRunSensitiveAudit_v015 = true;

    window.localStorage.setItem('abu-settings', JSON.stringify({ ...persisted, state, version: 42 }));
  }, { baseUrl, testApiKey: TEST_API_KEY, testModelId: TEST_MODEL_ID, providerId: PROVIDER_ID });
  await page.reload();
  await waitForApp(page);
}

async function seedAutomation(page: Page, seed: {
  activeTab: 'schedule' | 'trigger';
  schedules?: Record<string, unknown>;
  triggers?: Record<string, unknown>;
}): Promise<void> {
  await page.evaluate(({ activeTab, schedules, triggers }) => {
    const settingsRaw = window.localStorage.getItem('abu-settings');
    if (!settingsRaw) throw new Error('abu-settings was not initialized before seeding automation');
    const settings = JSON.parse(settingsRaw) as { state: Record<string, unknown>; version: number };
    settings.state.activeAutomationTab = activeTab;
    settings.state.viewMode = 'automation';
    window.localStorage.setItem('abu-settings', JSON.stringify(settings));

    if (schedules) {
      window.localStorage.setItem('abu-schedule', JSON.stringify({
        state: { tasks: schedules },
        version: 5,
      }));
    }
    if (triggers) {
      window.localStorage.setItem('abu-triggers', JSON.stringify({
        state: { triggers },
        version: 4,
      }));
    }
  }, seed);
  await page.reload();
  await waitForApp(page);
}

function makeSchedule(id: string, name: string, prompt: string, workspacePath?: string): Record<string, unknown> {
  return {
    id,
    name,
    prompt,
    schedule: { frequency: 'manual' },
    status: 'active',
    workspacePath,
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_000_000,
    runs: [],
    totalRuns: 0,
  };
}

function makeTrigger(
  id: string,
  name: string,
  prompt: string,
  workspacePath: string,
  capability?: 'read_tools' | 'safe_tools' | 'full' | 'custom',
): Record<string, unknown> {
  return {
    id,
    name,
    status: 'active',
    source: { type: 'http' },
    filter: { type: 'always' },
    action: {
      prompt,
      workspacePath,
      ...(capability ? { capability } : {}),
    },
    debounce: { enabled: false, windowSeconds: 0 },
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_000_000,
    runs: [],
    totalRuns: 0,
  };
}

async function openAutomationItem(page: Page, tabLabel: RegExp, itemName: string): Promise<void> {
  await page
    .getByRole('navigation', { name: /^(Main navigation|主导航)$/ })
    .getByRole('button', { name: /^(自动化|Automation)$/ })
    .evaluate((element: HTMLElement) => element.click());
  await expect(page.getByRole('button', { name: tabLabel })).toBeVisible({ timeout: READY_TIMEOUT });
  await page.getByRole('button', { name: tabLabel }).click();
  const item = page.getByText(itemName, { exact: true });
  if (!await item.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await page.locator('.border-b').getByRole('button').first().click();
  }
  await expect(item).toBeVisible({ timeout: READY_TIMEOUT });
  await item.click();
}

async function sendPrompt(page: Page, prompt: string): Promise<void> {
  const input = page.getByPlaceholder(CHAT_PLACEHOLDER);
  await expect(input).toBeEditable({ timeout: READY_TIMEOUT });
  await input.fill(prompt);
  await input.press('Enter');
}

async function startNewChat(page: Page): Promise<void> {
  await page.locator('[data-sidebar-action="new-task"]').evaluate((element: HTMLElement) => element.click());
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeEditable({ timeout: READY_TIMEOUT });
}

async function expectCurrentChatReady(page: Page): Promise<void> {
  const readyStatus = page.getByText(/^(就绪|Ready)$/);
  if (await readyStatus.isVisible({ timeout: 1_000 }).catch(() => false)) return;
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeEditable({ timeout: READY_TIMEOUT });
  await expect(page.getByText(/^(思考中|Thinking|回复中|Responding)(?:\s*\(\d+s\))?$/)).toHaveCount(0);
}

function expectToolResultMatches(body: unknown, toolName: string, expected: RegExp): string {
  const messages = (body as { messages?: OpenAiRequestMessage[] } | null)?.messages;
  expect(Array.isArray(messages)).toBe(true);
  const toolCall = messages
    ?.filter((message) => message.role === 'assistant' && Array.isArray(message.tool_calls))
    .flatMap((message) => message.tool_calls ?? [])
    .find((call) => call.function?.name === toolName);
  expect(toolCall).toBeDefined();
  const toolResultMessage = messages?.find((message) =>
    message.role === 'tool' && message.tool_call_id === toolCall?.id
  );
  expect(toolResultMessage).toBeDefined();
  const resultText = String(toolResultMessage?.content ?? '');
  expect(resultText).toMatch(expected);
  return resultText;
}

function mkdirFixtureRoot(): string {
  return fs.mkdtempSync(path.join(os.homedir(), 'Documents', 'abu-infra-e2e-'));
}

function removeFixtureRoot(root: string | undefined): void {
  if (!root) return;
  fs.rmSync(root, { recursive: true, force: true });
}

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;
let mock: OpenAiMock | undefined;
let fixtureRoot: string | undefined;

test.describe.serial('Electron infra hygiene batch', () => {
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
    removeFixtureRoot(fixtureRoot);
    fixtureRoot = undefined;
  });

  test('keeps live agent status isolated between a held scheduled run and a normal chat', async () => {
    const scheduleId = `schedule-a2-${randomUUID()}`;
    const scheduleName = `A2 hold schedule ${randomUUID().slice(0, 8)}`;
    const chatPrompt = `a2 normal chat ${randomUUID()}`;
    const chatResponse = `a2 normal chat done ${randomUUID()}`;
    const scheduleResponse = `a2 held schedule done ${randomUUID()}`;
    const { handle, plan } = makeHoldPlan();
    mock = await startOpenAiMock([
      plan,
      { kind: 'complete', responseText: chatResponse },
    ]);

    dataRoot = createElectronDataRoot();
    const launched = await launchAbuElectron(dataRoot);
    app = launched.app;
    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForApp(page);
    await configureLocalMockProvider(page, mock.baseUrl);
    await seedAutomation(page, {
      activeTab: 'schedule',
      schedules: {
        [scheduleId]: makeSchedule(scheduleId, scheduleName, `hold schedule ${randomUUID()}`),
      },
    });

    await openAutomationItem(page, /^(定时任务|Scheduled Tasks)$/, scheduleName);
    await page.getByRole('button', { name: /^(立即执行|Run Now)$/ }).click();
    await expect.poll(() => taskRequests(mock!).length, { timeout: READY_TIMEOUT }).toBe(1);

    await startNewChat(page);
    await sendPrompt(page, chatPrompt);
    await expect.poll(() => taskRequests(mock!).length, { timeout: READY_TIMEOUT }).toBe(2);
    await expect(page.getByText(chatResponse, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    await expectCurrentChatReady(page);

    await openAutomationItem(page, /^(定时任务|Scheduled Tasks)$/, scheduleName);
    await page.getByTitle(/^(查看会话|View Conversation)$/).click();
    await expect(page.getByText(/^(思考中|Thinking)(?:\s*\(\d+s\))?$/)).toBeVisible({ timeout: READY_TIMEOUT });

    handle.release(scheduleResponse);
    await expect(page.getByText(scheduleResponse, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    await expectCurrentChatReady(page);
  });

  test('scopes unattended authorization, recovers it after runs, and ignores manage_trigger self-escalation', async () => {
    fixtureRoot = mkdirFixtureRoot();
    const chatGrantDir = path.join(fixtureRoot, 'chat-grant');
    const fullRunDir = path.join(fixtureRoot, 'full-run');
    fs.mkdirSync(chatGrantDir, { recursive: true });
    fs.mkdirSync(fullRunDir, { recursive: true });

    const readTriggerId = `trigger-read-${randomUUID()}`;
    const fullTriggerId = `trigger-full-${randomUUID()}`;
    const readTriggerName = `A3 read trigger ${randomUUID().slice(0, 8)}`;
    const fullTriggerName = `A3 full trigger ${randomUUID().slice(0, 8)}`;
    const readTarget = path.join(chatGrantDir, 'read-trigger-should-not-write.txt');
    const fullTarget = path.join(fullRunDir, 'full-trigger-write.txt');
    const afterFullTarget = path.join(fullRunDir, 'chat-after-full-should-prompt.txt');
    const grantTarget = path.join(chatGrantDir, 'chat-grant.txt');
    const managedTriggerName = `A3 malicious managed trigger ${randomUUID().slice(0, 8)}`;

    mock = await startOpenAiMock([
      {
        kind: 'tool-call',
        toolName: 'write_file',
        toolCallId: `call-full-trigger-${randomUUID()}`,
        arguments: { path: fullTarget, content: 'full trigger may write' },
      },
      { kind: 'complete', responseText: `full trigger complete ${randomUUID()}` },
      {
        kind: 'tool-call',
        toolName: 'write_file',
        toolCallId: `call-after-full-chat-${randomUUID()}`,
        arguments: { path: afterFullTarget, content: 'chat after full must prompt' },
      },
      { kind: 'complete', responseText: `chat after full complete ${randomUUID()}` },
      {
        kind: 'tool-call',
        toolName: 'write_file',
        toolCallId: `call-chat-grant-${randomUUID()}`,
        arguments: { path: grantTarget, content: 'chat session grant' },
      },
      { kind: 'complete', responseText: `chat grant complete ${randomUUID()}` },
      {
        kind: 'tool-call',
        toolName: 'write_file',
        toolCallId: `call-read-trigger-${randomUUID()}`,
        arguments: { path: readTarget, content: 'read trigger must not write' },
      },
      { kind: 'complete', responseText: `read trigger complete ${randomUUID()}` },
      {
        kind: 'tool-call',
        toolName: 'manage_trigger',
        toolCallId: `call-manage-trigger-${randomUUID()}`,
        arguments: {
          action: 'create',
          name: managedTriggerName,
          prompt: 'malicious full trigger',
          source_type: 'http',
          filter_type: 'always',
          capability: 'full',
        },
      },
      { kind: 'complete', responseText: `manage trigger complete ${randomUUID()}` },
    ]);

    dataRoot = createElectronDataRoot();
    const launched = await launchAbuElectron(dataRoot);
    app = launched.app;
    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForApp(page);
    await configureLocalMockProvider(page, mock.baseUrl);
    await seedAutomation(page, {
      activeTab: 'trigger',
      triggers: {
        [readTriggerId]: makeTrigger(readTriggerId, readTriggerName, 'read_tools trigger $EVENT_DATA', chatGrantDir),
        [fullTriggerId]: makeTrigger(fullTriggerId, fullTriggerName, 'full trigger $EVENT_DATA', fullRunDir, 'full'),
      },
    });

    // Run the full-trigger scope check before any ordinary chat grant. A chat
    // "allow for session" to a Documents child grants the top-level Documents
    // permission directory, which would mask whether trigger-full cleanup worked.
    await openAutomationItem(page, /^(监听事件|Triggers)$/, fullTriggerName);
    await page.getByRole('button', { name: /^(测试触发|Test Trigger)$/ }).click();
    await expect.poll(() => taskRequests(mock!).length, { timeout: READY_TIMEOUT }).toBe(2);
    expectToolResultMatches(taskRequests(mock)[1].body, 'write_file', /Successfully wrote|成功/);
    await expect.poll(() => fs.existsSync(fullTarget), { timeout: READY_TIMEOUT }).toBe(true);

    await startNewChat(page);
    await sendPrompt(page, `chat after full ${randomUUID()}`);
    await expect.poll(() => taskRequests(mock!).length, { timeout: READY_TIMEOUT }).toBeGreaterThanOrEqual(3);
    await expect(page.getByRole('heading', { name: /^(文件写入权限|File Write Permission)$/ })).toBeVisible({
      timeout: READY_TIMEOUT,
    });
    await page.getByRole('button', { name: /^(拒绝|Deny)$/ }).click();
    await expect.poll(() => taskRequests(mock!).length, { timeout: READY_TIMEOUT }).toBe(4);
    expectToolResultMatches(taskRequests(mock)[3].body, 'write_file', /用户拒绝|denied/i);
    expect(fs.existsSync(afterFullTarget)).toBe(false);

    await startNewChat(page);
    await sendPrompt(page, `grant chat write ${randomUUID()}`);
    await expect.poll(() => taskRequests(mock!).length, { timeout: READY_TIMEOUT }).toBe(5);
    await expect(page.getByRole('heading', { name: /^(文件写入权限|File Write Permission)$/ })).toBeVisible({
      timeout: READY_TIMEOUT,
    });
    await page.getByRole('button', { name: /^(本次会话|This session)$/ }).click();
    await page.getByRole('button', { name: /^(允许本次会话|Allow for Session)$/ }).click();
    await expect.poll(() => taskRequests(mock!).length, { timeout: READY_TIMEOUT }).toBe(6);
    expectToolResultMatches(taskRequests(mock)[5].body, 'write_file', /Successfully wrote|成功/);
    await expect.poll(() => fs.existsSync(grantTarget), { timeout: READY_TIMEOUT }).toBe(true);

    await openAutomationItem(page, /^(监听事件|Triggers)$/, readTriggerName);
    await page.getByRole('button', { name: /^(测试触发|Test Trigger)$/ }).click();
    await expect.poll(() => taskRequests(mock!).length, { timeout: READY_TIMEOUT }).toBe(8);
    expectToolResultMatches(
      taskRequests(mock)[7].body,
      'write_file',
      /not allowed|blocked|拒绝|不允许|用户拒绝|denied/i,
    );
    expect(fs.existsSync(readTarget)).toBe(false);

    await startNewChat(page);
    await sendPrompt(page, `try manage_trigger escalation ${randomUUID()}`);
    await expect.poll(() => taskRequests(mock!).length, { timeout: READY_TIMEOUT }).toBe(10);
    const manageTriggerResult = expectToolResultMatches(
      taskRequests(mock)[9].body,
      'manage_trigger',
      /模型不能更改能力档位。新建触发器默认为只读|model cannot change the capability level.*new triggers use read only/i,
    );
    expect(manageTriggerResult).toMatch(/只读分析|Read-only analysis/i);
    expect(manageTriggerResult).not.toMatch(/完全自主|Fully autonomous/i);
    await expect.poll(async () => {
      return page.evaluate((name) => {
        const raw = window.localStorage.getItem('abu-triggers');
        if (!raw) return null;
        const parsed = JSON.parse(raw) as {
          state?: { triggers?: Record<string, { name?: string; action?: { capability?: string } }> };
        };
        const trigger = Object.values(parsed.state?.triggers ?? {}).find((candidate) => candidate.name === name);
        return trigger?.action?.capability ?? null;
      }, managedTriggerName);
    }, { timeout: READY_TIMEOUT }).toBe(null);
  });
});
