/**
 * Real Electron + sidecar coverage for the command-approval boundary.
 * The provider is a loopback-only OpenAI-compatible SSE server: no real
 * credential, network endpoint, or user file is involved in these tests.
 */
import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import type { ElectronApplication, Page } from 'playwright';
import {
  closeAbuElectron,
  configureLocalMockProvider,
  createElectronDataRoot,
  launchAbuElectron,
  removeElectronDataRoot,
  type ElectronDataRoot,
} from './electronHelpers';

const READY_TIMEOUT = 45_000;
const CHAT_PLACEHOLDER = '想让阿布帮你做点什么？';
const TEST_API_KEY = 'abu-e2e-tool-approval-not-a-real-secret';
const TEST_MODEL_ID = 'abu-e2e-tool-approval-model';
const PROVIDER_ID = 'abu-e2e-tool-approval-provider';
const LOCAL_MOCK_PROVIDER_OPTIONS = {
  apiKey: TEST_API_KEY,
  modelId: TEST_MODEL_ID,
  modelLabel: 'Abu E2E deterministic tool model',
  permissionMode: 'standard',
  providerId: PROVIDER_ID,
  providerName: 'Abu E2E loopback tool provider',
  supportsReasoning: null,
  supportsTools: true,
} as const;

interface MockRequest {
  authorization: string | undefined;
  body: unknown;
  pathname: string;
}

type MockReplyPlan =
  | {
      kind: 'tool-call';
      arguments: Record<string, unknown>;
      delayMs?: number;
      toolCallId: string;
      toolName: string;
    }
  | { kind: 'complete'; delayMs?: number; responseText: string };

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

function sseChunk(delta: Record<string, unknown>, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-abu-e2e-tool-approval',
    object: 'chat.completion.chunk',
    created: 0,
    model: TEST_MODEL_ID,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
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

function completeSse(responseText: string): string {
  return sseChunk({ content: responseText }, null) + sseChunk({}, 'stop') + 'data: [DONE]\n\n';
}

async function startOpenAiMock(replyPlans: readonly MockReplyPlan[]): Promise<OpenAiMock> {
  const requests: MockRequest[] = [];
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
      // Preserve malformed input for diagnostics without accepting it as valid.
    }

    if (req.method !== 'POST' || requestUrl.pathname !== '/v1/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unexpected local E2E mock route' }));
      return;
    }

    requests.push({
      authorization: req.headers.authorization,
      body,
      pathname: requestUrl.pathname,
    });
    const replyPlan = replyPlans[requests.length - 1];
    if (!replyPlan) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unexpected extra local E2E mock request' }));
      return;
    }
    if (replyPlan.delayMs) {
      await new Promise<void>((resolve) => setTimeout(resolve, replyPlan.delayMs));
    }

    res.writeHead(200, {
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'content-type': 'text/event-stream; charset=utf-8',
    });
    res.end(replyPlan.kind === 'tool-call' ? toolCallSse(replyPlan) : completeSse(replyPlan.responseText));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // Loopback only: the mock must never listen on an externally reachable interface.
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
    // 2130706433 is the numeric IPv4 spelling of 127.0.0.1. The server still
    // listens only on loopback, but this avoids the existing adapter's
    // literal-loopback => Ollama heuristic so the real SSE/tools path is used.
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

function quoteShellArgument(value: string): string {
  return `'${value.replace(/'/g, "'\\\"'\\\"'")}'`;
}

async function waitForApp(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible({ timeout: READY_TIMEOUT });
}

function dialogTitle(page: Page) {
  return page.getByRole('heading', { name: /^(操作确认|Confirm Action)$/ });
}

function confirmButton(page: Page) {
  return page.getByRole('button', { name: /^(确认执行|Confirm)$/ });
}

function cancelButton(page: Page) {
  return page.getByRole('button', { name: /^(取消|Cancel)$/ });
}

async function nativeBrowserViewStates(
  electronApp: ElectronApplication,
): Promise<Array<{ url: string; visible: boolean }>> {
  return electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window || window.isDestroyed()) return [];
    return window.contentView.children.flatMap((child) => {
      const candidate = child as unknown as {
        getVisible?: () => boolean;
        webContents?: {
          getURL: () => string;
          isDestroyed: () => boolean;
        };
      };
      if (
        typeof candidate.getVisible !== 'function'
        || !candidate.webContents
        || candidate.webContents.isDestroyed()
      ) {
        return [];
      }
      return [{
        url: candidate.webContents.getURL(),
        visible: candidate.getVisible(),
      }];
    });
  });
}

function expectToolExchange(body: unknown, command: string, expectedResult: string): void {
  const messages = (body as { messages?: OpenAiRequestMessage[] } | null)?.messages;
  expect(Array.isArray(messages)).toBe(true);

  const toolCall = messages
    ?.filter((message) => message.role === 'assistant' && Array.isArray(message.tool_calls))
    .flatMap((message) => message.tool_calls ?? [])
    .find((call) => call.function?.name === 'run_command');
  expect(toolCall).toBeDefined();
  expect(typeof toolCall?.id).toBe('string');
  expect(toolCall?.id).not.toBe('');

  const toolArguments = JSON.parse(String(toolCall?.function?.arguments ?? '')) as { command?: unknown };
  expect(toolArguments.command).toBe(command);

  const toolResultMessage = messages?.find((message) =>
    message.role === 'tool' && message.tool_call_id === toolCall?.id
  );
  expect(toolResultMessage).toBeDefined();
  expect(String(toolResultMessage?.content ?? '')).toContain(expectedResult);
}

function expectNamedToolResult(
  body: unknown,
  toolName: string,
  expectedResult: string,
): void {
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
  expect(String(toolResultMessage?.content ?? '')).toContain(expectedResult);
}

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;
let mock: OpenAiMock | undefined;

test.describe.serial('Electron run_command approval E2E', () => {
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

  test('confirms an approval-required command, executes it, and continues with the tool result', async () => {
    const response = `abu-e2e-approved-command-complete-${randomUUID()}`;
    const toolCallId = `call-approved-${randomUUID()}`;
    dataRoot = createElectronDataRoot();
    const sentinel = path.join(dataRoot.rootDir, `approval-sentinel-${randomUUID()}.txt`);
    fs.writeFileSync(sentinel, 'delete only after the E2E confirmation');
    const command = `rm -- ${quoteShellArgument(sentinel)}`;
    mock = await startOpenAiMock([
      {
        kind: 'tool-call',
        arguments: { command },
        toolCallId,
        toolName: 'run_command',
      },
      { kind: 'complete', responseText: response },
    ]);

    const launched = await launchAbuElectron(dataRoot);
    app = launched.app;
    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForApp(page);
    await configureLocalMockProvider(page, mock.baseUrl, LOCAL_MOCK_PROVIDER_OPTIONS);

    const prompt = `abu-e2e-confirm-command-${randomUUID()}`;
    await page.getByPlaceholder(CHAT_PLACEHOLDER).fill(prompt);
    await page.getByPlaceholder(CHAT_PLACEHOLDER).press('Enter');

    await expect.poll(() => mock!.requests.length, { timeout: READY_TIMEOUT }).toBe(1);
    expect(mock.requests[0].pathname).toBe('/v1/chat/completions');
    expect(mock.requests[0].authorization).toBe(`Bearer ${TEST_API_KEY}`);
    expect(JSON.stringify(mock.requests[0].body)).toContain('run_command');
    await expect(dialogTitle(page)).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(page.getByText(command, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    expect(fs.existsSync(sentinel)).toBe(true);
    await page.waitForTimeout(300);
    expect(fs.existsSync(sentinel)).toBe(true);
    await confirmButton(page).click();

    await expect.poll(() => mock!.requests.length, { timeout: READY_TIMEOUT }).toBe(2);
    expectToolExchange(mock.requests[1].body, command, 'exit code: 0');
    await expect.poll(() => fs.existsSync(sentinel), { timeout: READY_TIMEOUT }).toBe(false);
    await expect(page.getByText(response, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(dialogTitle(page)).toBeHidden();
    expect(mock.requests).toHaveLength(2);
  });

  test('cancels an approval-required command, returns the cancellation result, and does not execute or re-prompt', async () => {
    const response = `abu-e2e-cancelled-command-complete-${randomUUID()}`;
    const toolCallId = `call-cancelled-${randomUUID()}`;
    dataRoot = createElectronDataRoot();
    const sentinel = path.join(dataRoot.rootDir, `cancel-sentinel-${randomUUID()}.txt`);
    fs.writeFileSync(sentinel, 'must remain after cancellation');
    const command = `rm -- ${quoteShellArgument(sentinel)}`;
    mock = await startOpenAiMock([
      {
        kind: 'tool-call',
        arguments: { command },
        toolCallId,
        toolName: 'run_command',
      },
      { kind: 'complete', responseText: response },
    ]);

    const launched = await launchAbuElectron(dataRoot);
    app = launched.app;
    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForApp(page);
    await configureLocalMockProvider(page, mock.baseUrl, LOCAL_MOCK_PROVIDER_OPTIONS);

    await page.getByPlaceholder(CHAT_PLACEHOLDER).fill(`abu-e2e-cancel-command-${randomUUID()}`);
    await page.getByPlaceholder(CHAT_PLACEHOLDER).press('Enter');

    await expect.poll(() => mock!.requests.length, { timeout: READY_TIMEOUT }).toBe(1);
    await expect(dialogTitle(page)).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(page.getByText(command, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    expect(fs.existsSync(sentinel)).toBe(true);
    await page.waitForTimeout(300);
    expect(fs.existsSync(sentinel)).toBe(true);
    await cancelButton(page).click();

    await expect.poll(() => mock!.requests.length, { timeout: READY_TIMEOUT }).toBe(2);
    expectToolExchange(mock.requests[1].body, command, '[用户取消了此操作]');
    await expect(page.getByText(response, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(dialogTitle(page)).toBeHidden();
    await expect.poll(() => fs.existsSync(sentinel), { timeout: READY_TIMEOUT }).toBe(true);
    await page.waitForTimeout(750);
    expect(fs.existsSync(sentinel)).toBe(true);
    expect(mock.requests).toHaveLength(2);
    await expect(dialogTitle(page)).toBeHidden();
  });

  test('hides a real native browser view during approval and restores it after cancellation', async () => {
    const response = `abu-e2e-browser-approval-complete-${randomUUID()}`;
    const browserToolCallId = `call-browser-tabs-${randomUUID()}`;
    const commandToolCallId = `call-browser-approval-${randomUUID()}`;
    dataRoot = createElectronDataRoot();
    const sentinel = path.join(dataRoot.rootDir, `browser-approval-sentinel-${randomUUID()}.txt`);
    fs.writeFileSync(sentinel, 'must remain after browser approval cancellation');
    const command = `rm -- ${quoteShellArgument(sentinel)}`;
    mock = await startOpenAiMock([
      {
        kind: 'tool-call',
        arguments: {},
        toolCallId: browserToolCallId,
        toolName: 'abu-browser__get_tabs',
      },
      {
        kind: 'tool-call',
        arguments: { command },
        delayMs: 1_500,
        toolCallId: commandToolCallId,
        toolName: 'run_command',
      },
      { kind: 'complete', delayMs: 1_500, responseText: response },
    ]);

    const launched = await launchAbuElectron(dataRoot);
    app = launched.app;
    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForApp(page);
    await configureLocalMockProvider(page, mock.baseUrl, LOCAL_MOCK_PROVIDER_OPTIONS);

    await page.getByPlaceholder(CHAT_PLACEHOLDER).fill(
      `abu-e2e-native-browser-approval-${randomUUID()}`,
    );
    await page.getByPlaceholder(CHAT_PLACEHOLDER).press('Enter');

    await expect.poll(() => mock!.requests.length, { timeout: READY_TIMEOUT }).toBe(2);
    await expect.poll(async () => {
      const states = await nativeBrowserViewStates(app!);
      return states.some((state) => state.visible);
    }, { timeout: READY_TIMEOUT }).toBe(true);

    await expect(dialogTitle(page)).toBeVisible({ timeout: READY_TIMEOUT });
    await expect.poll(async () => {
      const states = await nativeBrowserViewStates(app!);
      return states.length > 0 && states.every((state) => !state.visible);
    }, { timeout: READY_TIMEOUT }).toBe(true);
    expect(fs.existsSync(sentinel)).toBe(true);

    await cancelButton(page).click();

    await expect.poll(() => mock!.requests.length, { timeout: READY_TIMEOUT }).toBe(3);
    expectToolExchange(mock.requests[2].body, command, '[用户取消了此操作]');
    await expect(dialogTitle(page)).toBeHidden();
    await expect.poll(async () => {
      const states = await nativeBrowserViewStates(app!);
      return states.some((state) => state.visible);
    }, { timeout: READY_TIMEOUT }).toBe(true);
    await expect(page.getByText(response, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    expect(fs.existsSync(sentinel)).toBe(true);
  });

  test('opens task-local capability setup, waits, and returns cancellation to the same tool call', async () => {
    const response = `abu-e2e-capability-setup-cancelled-${randomUUID()}`;
    dataRoot = createElectronDataRoot();
    mock = await startOpenAiMock([
      {
        kind: 'tool-call',
        arguments: {
          action: 'open_setup',
          name: 'abu-browser-bridge',
        },
        toolCallId: `call-capability-setup-${randomUUID()}`,
        toolName: 'manage_mcp_server',
      },
      { kind: 'complete', responseText: response },
    ]);

    const launched = await launchAbuElectron(dataRoot);
    app = launched.app;
    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForApp(page);
    await configureLocalMockProvider(page, mock.baseUrl, LOCAL_MOCK_PROVIDER_OPTIONS);

    await page.getByPlaceholder(CHAT_PLACEHOLDER).fill(
      `abu-e2e-task-local-capability-${randomUUID()}`,
    );
    await page.getByPlaceholder(CHAT_PLACEHOLDER).press('Enter');

    await expect.poll(() => mock!.requests.length, { timeout: READY_TIMEOUT }).toBe(1);
    const setupDialog = page.getByRole('dialog');
    await expect(setupDialog).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(
      setupDialog.getByText(/^(连接我的 Chrome|Connect My Chrome)$/),
    ).toBeVisible();

    await setupDialog.getByRole('button', {
      name: /^(取消|Cancel)$/,
    }).click();

    await expect.poll(() => mock!.requests.length, { timeout: READY_TIMEOUT }).toBe(2);
    expectNamedToolResult(
      mock.requests[1].body,
      'manage_mcp_server',
      '取消',
    );
    await expect(setupDialog).toBeHidden();
    await expect(page.getByText(response, { exact: true })).toBeVisible({
      timeout: READY_TIMEOUT,
    });
    expect(mock.requests).toHaveLength(2);
  });
});
