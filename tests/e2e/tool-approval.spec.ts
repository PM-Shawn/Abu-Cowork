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
/**
 * The task-local capability dialog keeps the "start setup" wording as its
 * own accessible name (`settings.capabilityChromeSetupTitle`), but since the
 * Capabilities rebuild the page it hosts is the ordinary Chrome capability
 * detail page, headed by the capability itself
 * (`settings.capabilityMyChrome`) rather than by the setup phrase. Assert
 * both, so the test still proves it is the Chrome setup that opened.
 */
const CAPABILITY_SETUP_DIALOG = /^(连接我的 Chrome|Connect My Chrome)$/;
const MY_CHROME_HEADING = /^(我的 Chrome|My Chrome)$/;
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

  for (const choice of ['allow', 'reject', 'stop']) {
    test(`team member approval resumes the same sidecar call (${choice})`, async () => {
      const allow = choice === 'allow';
      test.setTimeout(180_000);
      dataRoot = createElectronDataRoot();
      const sentinel = path.join(dataRoot.rootDir, 'team-approval-sentinel.txt');
      fs.writeFileSync(sentinel, 'isolated E2E file');
      const command = `rm -- ${quoteShellArgument(sentinel)}`;
      mock = await startOpenAiMock([
        { kind: 'tool-call', toolName: 'delegate_to_agent', toolCallId: 'team-delegate', arguments: { agent_name: '高级开发工程师', task: 'Perform the isolated approval test' } },
        { kind: 'tool-call', toolName: 'run_command', toolCallId: 'team-member-command', arguments: { command } },
        { kind: 'complete', responseText: 'Member completed the approval test.' },
        { kind: 'complete', responseText: 'Team approval test finished.' },
      ]);
      const launched = await launchAbuElectron(dataRoot);
      app = launched.app;
      const page = await app.firstWindow({ timeout: READY_TIMEOUT });
      await waitForApp(page);
      await page.evaluate(() => {
        const previous = JSON.parse(localStorage.getItem('abu-team') ?? '{}');
        localStorage.setItem('abu-team', JSON.stringify({ ...previous, state: { ...previous.state, teams: [{
          id: 'team-approval', name: 'E2E授权专家团', leaderRoleId: 'builtin:产品经理',
          memberRoleIds: ['builtin:高级开发工程师'], requirePlanApproval: false, createdAt: 1,
        }] } }));
      });
      await configureLocalMockProvider(page, mock.baseUrl, LOCAL_MOCK_PROVIDER_OPTIONS);
      const input = page.getByPlaceholder(CHAT_PLACEHOLDER);
      await input.fill('@');
      await page.getByRole('option', { name: /E2E授权专家团/ }).click();
      await input.fill('Run the isolated team approval test');
      await input.press('Enter');
      const strip = page.getByTestId('team-confirmations-strip');
      await expect(strip).toBeVisible({ timeout: READY_TIMEOUT });
      await expect(strip).toContainText('高级开发工程师');
      await expect(strip).toContainText('这一步正在等待你批准');
      expect(mock.requests).toHaveLength(2);
      expect(fs.existsSync(sentinel)).toBe(true);
      await page.screenshot({ path: test.info().outputPath('team-live-approval-compact.png') });
      await strip.getByRole('button', { name: '查看操作详情' }).click();
      await expect(strip.locator('pre')).toHaveText(command);
      await page.screenshot({ path: test.info().outputPath('team-live-approval.png') });
      if (choice === 'stop') {
        await page.getByRole('button', { name: '停止 高级开发工程师 这次的活', exact: true }).click();
        await expect(strip).toContainText('原步骤已结束');
        await expect(strip.getByRole('button', { name: `允许此次: ${command}`, exact: true })).toHaveCount(0);
        await expect(strip.getByRole('button', { name: `重新尝试: ${command}`, exact: true })).toBeVisible();
        expect(fs.existsSync(sentinel)).toBe(true);
        await strip.getByRole('button', { name: `忽略: ${command}`, exact: true }).click();
        await expect(strip).toHaveCount(0);
        expect(fs.existsSync(sentinel)).toBe(true);
        return;
      }
      await strip.getByRole('button', { name: `${allow ? '允许此次' : '拒绝'}: ${command}`, exact: true }).click();
      await expect(page.getByText('Team approval test finished.', { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
      expect(mock.requests).toHaveLength(4);
      expectToolExchange(mock.requests[2].body, command, allow ? 'exit code: 0' : '用户取消了此操作');
      expect(fs.existsSync(sentinel)).toBe(!allow);
      await expect(strip).toHaveCount(0);
      // A queued retry would add a user message and another run. The same child
      // instead delivers a tool result with its original tool_call_id.
      const messages = (mock.requests[2].body as { messages: OpenAiRequestMessage[] }).messages;
      const pendingCall = messages.flatMap((message) => message.tool_calls ?? []).find((call) => call.function?.name === 'run_command');
      expect(messages.find((message) => message.role === 'tool')?.tool_call_id).toBe(pendingCall?.id);
      expect(messages.filter((message) => message.role === 'user')).toHaveLength(1);
    });
  }

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
    await expect(setupDialog).toHaveAttribute('aria-label', CAPABILITY_SETUP_DIALOG);
    await expect(
      setupDialog.getByRole('heading', { name: MY_CHROME_HEADING }),
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
