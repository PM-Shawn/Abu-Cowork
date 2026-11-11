/**
 * Real-Electron coverage for the background commands of a conversation (C9):
 * the header entry and its list, a command's output while it runs, stopping it
 * from the list and through Abu's own tools, the entry belonging to one
 * conversation, and the question before a conversation with a running command
 * is deleted.
 *
 * A loopback model scripts each turn and moves on from the previous tool's
 * result (TESTING.md, fixture discipline). The command is a real `node -e`
 * process that prints a numbered `tick` line every 200 ms; it carries a marker
 * argument, so the test can see in the OS process list that it has ended.
 */
import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import type { ElectronApplication, Locator, Page } from 'playwright';
import {
  closeAbuElectron,
  configureLocalMockProvider,
  createElectronDataRoot,
  launchAbuElectron,
  pressWhenSettled,
  removeElectronDataRoot,
  type ElectronDataRoot,
} from './electronHelpers';
import {
  CHAT_PLACEHOLDER,
  READY_TIMEOUT,
  TEST_MODEL_ID,
  classifyMockRequestPurpose,
  closeServer,
  waitForApp,
} from './openAiMock';

const PROMPT = 'E2E后台命令';
const OTHER_PROMPT = 'E2E另一段对话';
const STARTED_REPLY = '后台命令已经启动。';
const STOPPED_REPLY = '我看过输出，已经把它停掉了。';
const OTHER_REPLY = '这是另一段对话的答复。';
// The title the app asks for by itself, in a request without tools. Each conversation's
// title holds its own prompt, so a sidebar row can be told apart by it.
function titleFor(body: unknown): string {
  return JSON.stringify(body).includes(OTHER_PROMPT) ? `${OTHER_PROMPT}标题` : `${PROMPT}标题`;
}
const ENTRY_RUNNING = '1 个后台命令运行中';
const ENTRY_TOTAL = '1 个后台命令';
const BACKGROUND_ID = /Background command id: (bg-[0-9a-f]+)/;
const TICK = /tick (\d+)/g;

interface RequestMessage {
  role?: unknown;
  content?: unknown;
  tool_call_id?: unknown;
  tool_calls?: Array<{ id?: unknown; function?: { name?: unknown } }>;
}

type Plan =
  | { kind: 'complete'; text: string }
  | { kind: 'tool-call'; toolName: string; arguments: Record<string, unknown> };

/** One step of a conversation: what the model answers, given the request it was sent. */
type Step = (body: unknown) => Plan;

interface ScriptedMock {
  baseUrl: string;
  close: () => Promise<void>;
  /** Steps that could not be answered, with the reason; empty when the script ran as written. */
  failures: string[];
}

let app: ElectronApplication | undefined;
let mock: ScriptedMock | undefined;
let dataRoot: ElectronDataRoot | undefined;
let marker: string | undefined;

test.afterEach(async () => {
  if (app) await closeAbuElectron(app);
  app = undefined;
  if (mock) {
    await mock.close();
    expect(mock.failures).toEqual([]);
  }
  mock = undefined;
  if (dataRoot) removeElectronDataRoot(dataRoot);
  dataRoot = undefined;
  if (marker) {
    const left = marker;
    marker = undefined;
    await expect.poll(() => processesWith(left), { timeout: 15_000 }).toEqual([]);
  }
});

/** The processes whose command line holds `text`, as `pid command`. */
function processesWith(text: string): string[] {
  const listing = process.platform === 'win32'
    ? execFileSync('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }',
      ], { encoding: 'utf8' })
    : execFileSync('/bin/ps', ['-A', '-o', 'pid=', '-o', 'command='], { encoding: 'utf8' });
  return listing.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes(text) && !line.includes('Get-CimInstance'));
}

/** A command that prints `tick 1`, `tick 2`, … every 200 ms until it is stopped. */
function tickCommand(): string {
  marker = `abu-e2e-bg-${randomBytes(4).toString('hex')}`;
  // Double quotes outside and single quotes inside read the same in zsh, bash and PowerShell.
  return `node -e "let i=0;setInterval(()=>console.log('tick '+ ++i),200)" ${marker}`;
}

/** The result of the most recent call of `toolName`, paired by tool_call_id; an error result fails the step. */
function lastToolResult(body: unknown, toolName: string): string {
  const messages = (body as { messages?: RequestMessage[] } | null)?.messages;
  if (!Array.isArray(messages)) throw new Error('the request holds no messages');
  const call = messages
    .filter((message) => message.role === 'assistant' && Array.isArray(message.tool_calls))
    .flatMap((message) => message.tool_calls ?? [])
    .filter((candidate) => candidate.function?.name === toolName)
    .at(-1);
  if (!call) throw new Error(`the request holds no ${toolName} call`);
  const result = messages.find((message) => message.role === 'tool' && message.tool_call_id === call.id);
  if (!result) throw new Error(`the request holds no result for ${toolName} (${String(call.id)})`);
  const content = String(result.content ?? '');
  if (content.startsWith('Error')) throw new Error(`${toolName} failed: ${content}`);
  return content;
}

/** The background command id the last run_command result names. */
function startedId(body: unknown): string {
  const result = lastToolResult(body, 'run_command');
  const match = BACKGROUND_ID.exec(result);
  if (!match) throw new Error(`run_command started no background command: ${result}`);
  return match[1];
}

function sseFrame(delta: Record<string, unknown>, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-abu-e2e-background',
    object: 'chat.completion.chunk',
    created: 0,
    model: TEST_MODEL_ID,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function answer(res: ServerResponse, body: unknown, plan: Plan, callId: string): void {
  const streams = !body || typeof body !== 'object' || (body as { stream?: unknown }).stream !== false;
  const toolCall = plan.kind === 'tool-call'
    ? { id: callId, type: 'function', function: { name: plan.toolName, arguments: JSON.stringify(plan.arguments) } }
    : null;
  if (!streams) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      id: 'chatcmpl-abu-e2e-background',
      object: 'chat.completion',
      created: 0,
      model: TEST_MODEL_ID,
      choices: [{
        index: 0,
        message: toolCall
          ? { role: 'assistant', content: null, tool_calls: [toolCall] }
          : { role: 'assistant', content: plan.kind === 'complete' ? plan.text : '' },
        finish_reason: toolCall ? 'tool_calls' : 'stop',
      }],
    }));
    return;
  }
  res.writeHead(200, { 'cache-control': 'no-cache', 'content-type': 'text/event-stream; charset=utf-8' });
  if (toolCall) {
    res.write(sseFrame({ tool_calls: [{ index: 0, ...toolCall }] }, null));
    res.write(sseFrame({}, 'tool_calls'));
  } else {
    res.write(sseFrame({ content: plan.kind === 'complete' ? plan.text : '' }, null));
    res.write(sseFrame({}, 'stop'));
  }
  res.end('data: [DONE]\n\n');
}

/**
 * A loopback OpenAI-compatible model that answers the requests carrying tools with
 * `steps`, in order, and the app's own requests (memory, title) with fixed text.
 */
async function startScriptedMock(steps: readonly Step[]): Promise<ScriptedMock> {
  const failures: string[] = [];
  const active = new Set<ServerResponse>();
  let next = 0;
  const server = createServer(async (req, res) => {
    active.add(res);
    res.once('close', () => active.delete(res));
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    if (req.method !== 'POST' || new URL(req.url ?? '/', 'http://127.0.0.1').pathname !== '/v1/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unexpected local E2E mock route' }));
      return;
    }
    const body = JSON.parse(raw) as unknown;
    const tools = (body as { tools?: unknown[] }).tools;
    const purpose = classifyMockRequestPurpose(body);
    if (purpose === 'memory') return answer(res, body, { kind: 'complete', text: '[]' }, '');
    if (!Array.isArray(tools) || tools.length === 0) return answer(res, body, { kind: 'complete', text: titleFor(body) }, '');
    const index = next++;
    const step = steps[index];
    let plan: Plan;
    try {
      if (!step) throw new Error(`no step ${index + 1} in the script`);
      plan = step(body);
    } catch (error) {
      // The reason is reported by afterEach; the app sees a failed request.
      failures.push(`step ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'the E2E script could not answer this step' }));
      return;
    }
    answer(res, body, plan, `call-background-${index + 1}`);
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
  if (!address || typeof address === 'string') throw new Error('The scripted mock did not receive a TCP port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => closeServer(server, active),
    failures,
  };
}

/** The plain-language purpose the background call carries: its step reads "<purpose>（在后台）", not the command. */
const BACKGROUND_PURPOSE = '每秒记一次时间';
const BACKGROUND_STEP = `${BACKGROUND_PURPOSE}（在后台）`;

function startInBackground(command: string): Step {
  return () => ({
    kind: 'tool-call',
    toolName: 'run_command',
    arguments: { command, purpose: BACKGROUND_PURPOSE, background: true },
  });
}

/** The reply after the command started: it is in the background and still running. */
function replyOnceStarted(text: string): Step {
  return (body) => {
    startedId(body);
    return { kind: 'complete', text };
  };
}

async function startApp(steps: readonly Step[]): Promise<Page> {
  dataRoot = createElectronDataRoot();
  mock = await startScriptedMock(steps);
  app = (await launchAbuElectron(dataRoot)).app;
  const page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(page);
  await configureLocalMockProvider(page, mock.baseUrl, { supportsTools: true, permissionMode: 'standard' });
  return page;
}

async function ask(page: Page, prompt: string, reply: string): Promise<void> {
  const input = page.getByPlaceholder(CHAT_PLACEHOLDER);
  await input.fill(prompt);
  await input.press('Enter');
  await expect(page.getByText(reply, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
  await expect(input).toBeEditable({ timeout: READY_TIMEOUT });
}

function entry(page: Page, name: string): Locator {
  return page.getByRole('button', { name, exact: true });
}

function anyEntry(page: Page): Locator {
  return page.getByRole('button', { name: /^\d+ 个后台命令/ });
}

function commandList(page: Page): Locator {
  return page.locator('[data-ds-popover]');
}

/** The list row of the one command, by its trigger. */
function commandRow(page: Page): Locator {
  return commandList(page).getByRole('button', { name: /node -e/ });
}

/** The highest tick number the expanded output shows. */
async function lastTick(page: Page): Promise<number> {
  const text = await commandList(page).locator('.xterm-rows').textContent() ?? '';
  const numbers = [...text.matchAll(TICK)].map((match) => Number(match[1]));
  return numbers.length === 0 ? 0 : Math.max(...numbers);
}

/** Unfold the finished turn's work process and every group of steps in it. */
async function showSteps(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^用时/ }).last().click();
  const groups = page.getByRole('button', { name: /^(执行了|调用了)/, expanded: false });
  while (await groups.count() > 0) await groups.first().click();
}

async function showSidebar(page: Page): Promise<void> {
  const toggle = page.getByRole('button', { name: '显示侧栏', exact: true });
  if (await toggle.isVisible()) await toggle.click();
}

async function stopFromList(page: Page): Promise<void> {
  await commandList(page).getByRole('button', { name: '停止', exact: true }).click();
  const confirmStop = commandList(page).getByRole('button', { name: '确认停止', exact: true });
  await expect(confirmStop).toBeVisible();
  await confirmStop.click();
}

test('lists, shows output and stops a background command', async () => {
  test.setTimeout(180_000);
  const command = tickCommand();
  const page = await startApp([startInBackground(command), replyOnceStarted(STARTED_REPLY)]);

  await ask(page, PROMPT, STARTED_REPLY);
  await expect(entry(page, ENTRY_RUNNING)).toBeVisible({ timeout: READY_TIMEOUT });
  await showSteps(page);
  await expect(page.getByText(BACKGROUND_STEP, { exact: true })).toBeVisible();
  expect(processesWith(marker!).length).toBeGreaterThan(0);

  await entry(page, ENTRY_RUNNING).click();
  await expect(commandList(page)).toBeVisible();
  await expect(commandRow(page)).toContainText(command);
  await expect(commandRow(page)).toContainText('运行中');

  await commandRow(page).click();
  await expect(commandRow(page)).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(() => lastTick(page), { timeout: READY_TIMEOUT }).toBeGreaterThan(0);
  const seen = await lastTick(page);
  // New output keeps arriving while the row stays open.
  await expect.poll(() => lastTick(page), { timeout: READY_TIMEOUT }).toBeGreaterThan(seen + 2);

  await stopFromList(page);
  await expect(commandRow(page)).toContainText('已停止', { timeout: READY_TIMEOUT });
  await expect(commandList(page).getByText('已结束 1', { exact: true })).toBeVisible();
  await expect(entry(page, ENTRY_TOTAL)).toBeVisible();
  await expect.poll(() => processesWith(marker!), { timeout: 15_000 }).toEqual([]);
});

test('lets Abu read and stop the command', async () => {
  test.setTimeout(180_000);
  const command = tickCommand();
  const page = await startApp([
    startInBackground(command),
    (body) => ({ kind: 'tool-call', toolName: 'background_command_output', arguments: { id: startedId(body) } }),
    (body) => {
      const output = lastToolResult(body, 'background_command_output');
      if (!output.includes('tick')) throw new Error(`background_command_output shows no tick: ${output}`);
      return { kind: 'tool-call', toolName: 'stop_background_command', arguments: { id: startedId(body) } };
    },
    (body) => {
      lastToolResult(body, 'stop_background_command');
      return { kind: 'complete', text: STOPPED_REPLY };
    },
  ]);

  await ask(page, PROMPT, STOPPED_REPLY);
  await showSteps(page);
  await expect(page.getByText(BACKGROUND_STEP, { exact: true })).toBeVisible();
  await expect(page.getByText(/^查看后台命令的输出 node -e/)).toBeVisible();
  await expect(page.getByText(/^停止后台命令 node -e/)).toBeVisible();

  await expect(entry(page, ENTRY_TOTAL)).toBeVisible({ timeout: READY_TIMEOUT });
  await entry(page, ENTRY_TOTAL).click();
  await expect(commandRow(page)).toContainText('已停止');
  await expect.poll(() => processesWith(marker!), { timeout: 15_000 }).toEqual([]);
});

test('hides the entry in another conversation', async () => {
  test.setTimeout(180_000);
  const command = tickCommand();
  const page = await startApp([
    startInBackground(command),
    replyOnceStarted(STARTED_REPLY),
    () => ({ kind: 'complete', text: OTHER_REPLY }),
  ]);

  await ask(page, PROMPT, STARTED_REPLY);
  await expect(entry(page, ENTRY_RUNNING)).toBeVisible({ timeout: READY_TIMEOUT });

  await showSidebar(page);
  await page.getByLabel('Main navigation').getByRole('button', { name: '新任务', exact: true }).click();
  await ask(page, OTHER_PROMPT, OTHER_REPLY);
  await expect(anyEntry(page)).toHaveCount(0);

  await showSidebar(page);
  await page.locator('[data-conversation-row]').filter({ hasNotText: OTHER_PROMPT }).first().click();
  await expect(page.getByText(STARTED_REPLY, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
  await expect(entry(page, ENTRY_RUNNING)).toBeVisible();
  await entry(page, ENTRY_RUNNING).click();
  await expect(commandRow(page)).toContainText('运行中');

  await stopFromList(page);
  await expect(commandRow(page)).toContainText('已停止', { timeout: READY_TIMEOUT });
  await expect.poll(() => processesWith(marker!), { timeout: 15_000 }).toEqual([]);
});

test('asks before deleting the conversation', async () => {
  test.setTimeout(180_000);
  const command = tickCommand();
  const page = await startApp([startInBackground(command), replyOnceStarted(STARTED_REPLY)]);

  await ask(page, PROMPT, STARTED_REPLY);
  await expect(entry(page, ENTRY_RUNNING)).toBeVisible({ timeout: READY_TIMEOUT });

  await showSidebar(page);
  const row = page.locator('[data-conversation-row]');
  await expect(row).toHaveCount(1);
  await row.hover();
  await row.getByRole('button', { name: '更多操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '删除会话', exact: true }).click();

  const question = page.getByRole('alertdialog', { name: '这段对话还有 1 个后台命令在运行' });
  await expect(question).toBeVisible();
  await expect(question).toContainText('删除后会停止它们。撤销删除只能恢复对话。');
  await expect(question.getByRole('button')).toHaveText(['取消', '删除']);
  expect(processesWith(marker!).length).toBeGreaterThan(0);

  await pressWhenSettled(question.getByRole('button', { name: '删除', exact: true }));
  await expect(question).toHaveCount(0);
  await expect(row).toHaveCount(0);
  await expect(page.getByRole('region', { name: '通知' }).getByText('会话已删除')).toBeVisible();
  await expect.poll(() => processesWith(marker!), { timeout: 15_000 }).toEqual([]);
  expect(await page.evaluate(() => (
    window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<number> } }
  ).__TAURI_INTERNALS__.invoke('background_command_running_count', {}))).toBe(0);
});
