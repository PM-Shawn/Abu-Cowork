/**
 * 「创建应用」 (product brief story 4) in the real Electron shell. The switcher
 * opens a creation conversation with its own draft folder; the test writes
 * the draft the model would write (an app and one new expert) and a loopback
 * OpenAI-compatible mock calls `app_prepare` when the user sends. The preview
 * card then shows who handles each scene and the expert to be created, and
 * confirming creates the expert as the user's own, adds the app and enters it.
 *
 * Under E2E the host's home directory is `<appData>/Home`, so the draft, the
 * expert and the app all land in the test's own data root.
 */
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
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
const TEST_MODEL_ID = 'abu-e2e-app-create-model';
const PROVIDER_OPTIONS = {
  apiKey: 'abu-e2e-app-create-not-a-real-secret',
  modelId: TEST_MODEL_ID,
  modelLabel: 'Abu E2E app create model',
  permissionMode: 'standard',
  providerId: 'abu-e2e-app-create-provider',
  providerName: 'Abu E2E app create loopback provider',
  supportsReasoning: null,
  supportsTools: true,
} as const;
const EXPERT = '周报整理员';
const TEMPLATES = [
  { id: 'notes', title: '从记录整理', prompt: '把下面这些记录整理成本周周报：' },
  { id: 'todos', title: '从待办整理', prompt: '根据我这周完成的待办写一份周报' },
  { id: 'short', title: '压缩成三句话', prompt: '把这份周报压缩成三句话' },
];

interface RequestMessage { role?: unknown; content?: unknown }

function sseChunk(delta: Record<string, unknown>, finishReason: string | null): string {
  return `data: ${JSON.stringify({ id: 'chatcmpl-abu-e2e-app-create', object: 'chat.completion.chunk', created: 0, model: TEST_MODEL_ID, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
}

/**
 * Calls `app_prepare` for the user's message and answers its result with one
 * line; every other request (title, memory) gets plain text. Keyed on what the
 * request carries, so the order of background requests does not matter.
 */
async function startMock(): Promise<{ baseUrl: string; toolResults: string[]; seen: Array<{ last: unknown; tools: string[] }>; close: () => Promise<void> }> {
  const toolResults: string[] = [];
  // What each request carried, attached to the report when the test fails.
  const seen: Array<{ last: unknown; tools: string[] }> = [];
  const active = new Set<ServerResponse>();
  const server = createServer(async (req, res) => {
    active.add(res);
    res.once('close', () => active.delete(res));
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    const body = JSON.parse(raw) as { messages?: RequestMessage[]; tools?: Array<{ function?: { name?: string } }> };
    const messages = body.messages ?? [];
    const last = messages.at(-1);
    const toolNames = (body.tools ?? []).map((tool) => tool.function?.name ?? '');
    seen.push({ last, tools: toolNames });
    const offersPrepare = toolNames.includes('app_prepare');
    res.writeHead(200, { 'cache-control': 'no-cache', connection: 'keep-alive', 'content-type': 'text/event-stream; charset=utf-8' });
    if (last?.role === 'tool') {
      toolResults.push(String(last.content));
      res.end(sseChunk({ content: '预览已经放在下面，确认就能添加。' }, null) + sseChunk({}, 'stop') + 'data: [DONE]\n\n');
      return;
    }
    if (offersPrepare && last?.role === 'user') {
      res.end(sseChunk({ tool_calls: [{ index: 0, id: 'call-app-prepare', type: 'function', function: { name: 'app_prepare', arguments: '{}' } }] }, null) + sseChunk({}, 'tool_calls') + 'data: [DONE]\n\n');
      return;
    }
    res.end(sseChunk({ content: '[]' }, null) + sseChunk({}, 'stop') + 'data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    // Numeric loopback: reaches the 127.0.0.1-only server without tripping
    // the local-provider heuristic that disables streaming tool calls.
    baseUrl: `http://2130706433:${port}/v1`,
    toolResults,
    seen,
    close: () => closeServer(server, active),
  };
}

function closeServer(server: Server, active: ReadonlySet<ServerResponse>): Promise<void> {
  for (const response of active) response.destroy();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections?.();
  });
}

/** The draft the model would write: one scene on a new expert, one on a built-in team. */
function writeDraft(dir: string): void {
  fs.mkdirSync(path.join(dir, '.abu-app'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.abu-app', 'app.json'), JSON.stringify({
    name: 'weekly-report',
    version: '1.0.0',
    minAbuVersion: '0.51.0',
    interface: { displayName: '周报', shortDescription: '每周五整理周报' },
    home: { modes: { items: [{ modeId: 'write', title: '写周报', scenes: [
      { id: 'draft', title: '整理成周报', run: { expert: `mine:${EXPERT}` }, templates: TEMPLATES },
      { id: 'report', title: '做成汇报', run: { team: 'builtin-team:reporting' }, templates: TEMPLATES },
    ] }] } },
  }, null, 2));
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'agents', `${EXPERT}.md`), `---\nname: ${EXPERT}\ndescription: 把一周的记录整理成周报\n---\nTurn the user's notes into a weekly report.\n`);
}

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;
let mock: Awaited<ReturnType<typeof startMock>> | undefined;

test.afterEach(async ({ browserName: _browserName }, testInfo) => {
  if (mock && testInfo.status !== testInfo.expectedStatus) {
    const file = testInfo.outputPath('mock-requests.json');
    fs.writeFileSync(file, JSON.stringify(mock.seen, null, 2));
    await testInfo.attach('mock-requests', { path: file, contentType: 'application/json' });
  }
  if (app) await closeAbuElectron(app);
  app = undefined;
  if (mock) await mock.close();
  mock = undefined;
  if (dataRoot) removeElectronDataRoot(dataRoot);
  dataRoot = undefined;
});

test('创建应用 previews the draft in the conversation and confirming adds the app and its new expert', async () => {
  dataRoot = createElectronDataRoot();
  mock = await startMock();
  app = (await launchAbuElectron(dataRoot)).app;
  const page: Page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await expect(page.getByTestId('app-switcher-trigger')).toBeVisible({ timeout: READY_TIMEOUT });
  await dismissFirstRunOverlays(page);
  await configureLocalMockProvider(page, mock.baseUrl, PROVIDER_OPTIONS);

  await page.getByTestId('app-switcher-trigger').click();
  await page.getByTestId('app-switcher-create').click();
  const composer = page.locator('[data-chat-composer]');
  const composerText = () => composer.evaluate((element) => element instanceof HTMLTextAreaElement ? element.value : element.textContent ?? '');
  await expect(composer).toBeVisible({ timeout: READY_TIMEOUT });
  await expect(page.getByRole('button', { name: '/abu-app-builder', exact: true })).toBeVisible();
  await expect.poll(composerText).toMatch(/我想创建一个应用/);

  // The conversation owns one draft folder under ~/Abu Apps.
  const appsRoot = path.join(dataRoot.appDataDir, 'Home', 'Abu Apps');
  await expect.poll(() => (fs.existsSync(appsRoot) ? fs.readdirSync(appsRoot).length : 0)).toBe(1);
  const draftDir = path.join(appsRoot, fs.readdirSync(appsRoot)[0]!);
  writeDraft(draftDir);

  await composer.click();
  await page.keyboard.type('整理周报');
  await composer.press('Enter');
  await expect.poll(() => mock!.toolResults.length, { timeout: READY_TIMEOUT }).toBe(1);
  expect(JSON.parse(mock.toolResults[0]!)).toMatchObject({ status: 'ready', name: 'weekly-report', newExperts: [EXPERT], newTeams: [] });

  const card = page.getByTestId('app-draft-card');
  await expect(card).toContainText('周报', { timeout: READY_TIMEOUT });
  await expect(page.getByTestId('app-draft-scene-draft')).toContainText(`由 ${EXPERT} 负责`);
  await expect(page.getByTestId('app-draft-scene-report')).toContainText('由 汇报材料专家团 负责');
  await expect(page.getByTestId('app-draft-new-experts')).toContainText(EXPERT);
  // Nothing exists until the user confirms.
  const expertFile = path.join(dataRoot.appDataDir, 'Home', '.abu', 'agents', EXPERT, 'AGENT.md');
  expect(fs.existsSync(expertFile)).toBe(false);

  await page.getByTestId('app-draft-confirm').click();
  await expect(page.getByTestId('app-switcher-current')).toHaveText('周报', { timeout: READY_TIMEOUT });
  await expect(page.getByTestId('app-home-title')).toHaveText('周报');
  await expect(page.getByTestId('app-home-scene-draft')).toContainText(`由 ${EXPERT} 负责`);
  expect(fs.readFileSync(expertFile, 'utf8')).toContain(`name: ${EXPERT}`);
  const added = JSON.parse(fs.readFileSync(path.join(dataRoot.appDataDir, 'Home', '.abu', 'apps', 'added.json'), 'utf8')) as Array<{ appId: string }>;
  expect(added.map((record) => record.appId)).toEqual(['weekly-report@mine']);
});
