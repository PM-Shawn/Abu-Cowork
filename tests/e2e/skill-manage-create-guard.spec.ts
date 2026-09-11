/**
 * Real Electron coverage for skill_manage create's name guard.
 *
 * A scheduled task bound to a temp workspace runs against a loopback
 * OpenAI-compatible SSE mock that calls skill_manage create three times: under
 * a built-in skill's name, under the name of a folder already in the
 * workspace's skills dir whose SKILL.md is filed under another name (both must
 * be refused, nothing written), then under a fresh name (must land in the
 * skills dir). This exercises the renderer's real skill loader (built-in
 * skills scanned from the app's resources), the real host's directory listing,
 * and the Electron fs host's non-recursive mkdir.
 *
 * Under E2E the host's home directory is `<appData>/Home`, so the skill lands
 * in the test's own data root, never in the developer's `~/.abu`.
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
import { persistedStoreVersion } from './storeVersions';

const READY_TIMEOUT = 45_000;
const CHAT_PLACEHOLDER = '想让阿布帮你做点什么？';
const TEST_MODEL_ID = 'abu-e2e-skill-guard-model';
const LOCAL_MOCK_PROVIDER_OPTIONS = {
  apiKey: 'abu-e2e-skill-guard-not-a-real-secret',
  modelId: TEST_MODEL_ID,
  modelLabel: 'Abu E2E skill guard model',
  permissionMode: 'standard',
  providerId: 'abu-e2e-skill-guard-provider',
  providerName: 'Abu E2E skill guard loopback provider',
  supportsReasoning: null,
  supportsTools: true,
} as const;

type MockReplyPlan =
  | { kind: 'complete'; responseText: string }
  | { kind: 'tool-call'; arguments: Record<string, unknown>; toolCallId: string; toolName: string };

interface OpenAiRequestMessage {
  role?: unknown;
  content?: unknown;
  tool_call_id?: unknown;
}

interface OpenAiMock {
  baseUrl: string;
  close: () => Promise<void>;
  taskBodies: unknown[];
}

function sseChunk(delta: Record<string, unknown>, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-abu-e2e-skill-guard',
    object: 'chat.completion.chunk',
    created: 0,
    model: TEST_MODEL_ID,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function replySse(plan: MockReplyPlan): string {
  if (plan.kind === 'complete') {
    return sseChunk({ content: plan.responseText }, null) + sseChunk({}, 'stop') + 'data: [DONE]\n\n';
  }
  return sseChunk({
    tool_calls: [{
      index: 0,
      id: plan.toolCallId,
      type: 'function',
      function: { name: plan.toolName, arguments: JSON.stringify(plan.arguments) },
    }],
  }, null) + sseChunk({}, 'tool_calls') + 'data: [DONE]\n\n';
}

function isMemoryExtractionRequest(body: unknown): boolean {
  const messages = (body as { messages?: unknown } | null)?.messages;
  return Array.isArray(messages) && messages.some((message: { content?: unknown; role?: unknown }) =>
    message?.role === 'system' && typeof message.content === 'string' && message.content.includes('你是一个记忆提取助手'));
}

async function startOpenAiMock(replyPlans: readonly MockReplyPlan[]): Promise<OpenAiMock> {
  const taskBodies: unknown[] = [];
  const activeResponses = new Set<ServerResponse>();
  const server = createServer(async (req, res) => {
    activeResponses.add(res);
    res.once('close', () => activeResponses.delete(res));
    let rawBody = '';
    for await (const chunk of req) rawBody += String(chunk);
    let body: unknown = rawBody;
    try {
      body = JSON.parse(rawBody);
    } catch {
      // Preserve malformed input in request diagnostics.
    }
    if (req.method !== 'POST' || new URL(req.url ?? '/', 'http://127.0.0.1').pathname !== '/v1/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unexpected local E2E mock route' }));
      return;
    }
    let plan: MockReplyPlan | undefined = { kind: 'complete', responseText: '[]' };
    if (!isMemoryExtractionRequest(body)) {
      plan = replyPlans[taskBodies.length];
      taskBodies.push(body);
    }
    if (!plan) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unexpected extra local E2E mock request' }));
      return;
    }
    res.writeHead(200, { 'cache-control': 'no-cache', connection: 'keep-alive', 'content-type': 'text/event-stream; charset=utf-8' });
    res.end(replySse(plan));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('The local OpenAI-compatible mock did not receive a TCP port');
  return {
    // Numeric loopback: reaches the 127.0.0.1-only server without tripping
    // the local-provider heuristic that disables streaming tool calls.
    baseUrl: `http://2130706433:${address.port}/v1`,
    close: () => closeServer(server, activeResponses),
    taskBodies,
  };
}

function closeServer(server: Server, activeResponses: ReadonlySet<ServerResponse>): Promise<void> {
  for (const response of activeResponses) response.destroy();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections?.();
  });
}

/**
 * The newest tool message in a request — the answer to the tool call the mock
 * sent just before it (Abu renumbers tool-call ids, so match by order) —
 * parsed as skill_manage's JSON result.
 */
function latestToolResult(body: unknown): { success?: boolean; error?: string; path?: string } {
  const messages = (body as { messages?: OpenAiRequestMessage[] } | null)?.messages ?? [];
  const message = messages.filter((m) => m.role === 'tool').at(-1);
  expect(message, 'a tool result in the follow-up request').toBeDefined();
  return JSON.parse(String(message?.content ?? '{}'));
}

async function waitForApp(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible({ timeout: READY_TIMEOUT });
}

async function seedSchedule(page: Page, schedule: Record<string, unknown>): Promise<void> {
  await page.evaluate(({ task, scheduleVersion }) => {
    const settingsRaw = window.localStorage.getItem('abu-settings');
    if (!settingsRaw) throw new Error('abu-settings was not initialized before seeding automation');
    const settings = JSON.parse(settingsRaw) as { state: Record<string, unknown>; version: number };
    settings.state.activeAutomationTab = 'schedule';
    settings.state.viewMode = 'automation';
    window.localStorage.setItem('abu-settings', JSON.stringify(settings));
    window.localStorage.setItem('abu-schedule', JSON.stringify({
      state: { tasks: { [task.id as string]: task } },
      version: scheduleVersion,
    }));
  }, { task: schedule, scheduleVersion: persistedStoreVersion('abu-schedule') });
  await page.reload();
  await waitForApp(page);
}

async function runSchedule(page: Page, name: string): Promise<void> {
  await page
    .getByRole('navigation', { name: /^(Main navigation|主导航)$/ })
    .getByRole('button', { name: /^(自动化|Automation)$/ })
    .evaluate((element: HTMLElement) => element.click());
  await page.getByRole('button', { name: /^(定时任务|Scheduled Tasks)$/ }).click();
  const item = page.getByText(name, { exact: true });
  if (!await item.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await page.locator('.border-b').getByRole('button').first().click();
  }
  await item.click();
  await page.getByRole('button', { name: /^(立即执行|Run Now)$/ }).click();
}

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;
let mock: OpenAiMock | undefined;

test.afterEach(async () => {
  if (app) await closeAbuElectron(app);
  app = undefined;
  if (mock) await mock.close();
  mock = undefined;
  if (dataRoot) removeElectronDataRoot(dataRoot);
  dataRoot = undefined;
});

test('skill_manage create refuses a built-in skill name and creates a fresh one', async () => {
  dataRoot = createElectronDataRoot();
  // skill_manage only derives the project key from the workspace path; the
  // folder itself lives in the data root and goes with it.
  const workspace = path.join(dataRoot.rootDir, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  // `taken/SKILL.md` says `name: other`: the loader would list it as `other`,
  // so a create of `taken` that only asked the loader would overwrite it.
  // Same key derivation as sanitizePath (src/core/memdir/paths.ts) below its
  // 200-char hashing threshold.
  const projectKey = workspace.replace(/[^a-zA-Z0-9]/g, '-');
  expect(projectKey.length).toBeLessThanOrEqual(200);
  const skillsDir = path.join(dataRoot.appDataDir, 'Home', '.abu', 'projects', projectKey, 'skills');
  const takenSkillMd = path.join(skillsDir, 'taken', 'SKILL.md');
  const takenContent = '---\nname: other\ndescription: hand-made\n---\n\nmine\n';
  fs.mkdirSync(path.dirname(takenSkillMd), { recursive: true });
  fs.writeFileSync(takenSkillMd, takenContent);
  const freshName = `e2e-guard-${randomUUID().slice(0, 8)}`;
  const done = `skill guard done ${randomUUID()}`;
  const createCall = (toolCallId: string, name: string): MockReplyPlan => ({
    kind: 'tool-call',
    toolCallId,
    toolName: 'skill_manage',
    arguments: { action: 'create', name, frontmatter: { description: 'E2E guard probe' }, content: '# Probe\nbody' },
  });
  mock = await startOpenAiMock([
    createCall('call-builtin-name', 'pdf'),
    createCall('call-taken-folder', 'taken'),
    createCall('call-fresh-name', freshName),
    { kind: 'complete', responseText: done },
  ]);

  app = (await launchAbuElectron(dataRoot)).app;
  const page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(page);
  await configureLocalMockProvider(page, mock.baseUrl, LOCAL_MOCK_PROVIDER_OPTIONS);
  const scheduleId = `schedule-skill-guard-${randomUUID()}`;
  const scheduleName = `Skill guard ${randomUUID().slice(0, 8)}`;
  await seedSchedule(page, {
    id: scheduleId,
    name: scheduleName,
    prompt: 'create the probe skills',
    schedule: { frequency: 'manual' },
    status: 'active',
    workspacePath: workspace,
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_000_000,
    runs: [],
    totalRuns: 0,
  });

  await runSchedule(page, scheduleName);
  await expect.poll(() => mock!.taskBodies.length, { timeout: READY_TIMEOUT }).toBe(4);

  const refusedBuiltin = latestToolResult(mock.taskBodies[1]);
  expect(refusedBuiltin.success).toBe(false);
  expect(refusedBuiltin.error).toMatch(/技能「pdf」未创建/);

  const refusedTaken = latestToolResult(mock.taskBodies[2]);
  expect(refusedTaken.success).toBe(false);
  expect(refusedTaken.error).toMatch(/技能「taken」未创建/);
  expect(fs.readFileSync(takenSkillMd, 'utf8')).toBe(takenContent);

  const created = latestToolResult(mock.taskBodies[3]);
  expect(created.success, JSON.stringify(created)).toBe(true);
  // The app joins paths with `/` on every platform; Node's path.join uses `\` on Windows.
  const slashes = (p: string) => p.replace(/\\/g, '/');
  expect(slashes(String(created.path))).toBe(slashes(path.join(skillsDir, freshName, 'SKILL.md')));
  expect(fs.readFileSync(path.join(skillsDir, freshName, 'SKILL.md'), 'utf8')).toContain(`name: ${freshName}`);
  // The refused creates wrote nothing beside it.
  expect(fs.readdirSync(skillsDir).sort()).toEqual([freshName, 'taken'].sort());
});
