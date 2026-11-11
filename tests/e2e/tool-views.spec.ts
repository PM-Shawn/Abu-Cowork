/**
 * Real-Electron acceptance for the views of the work process's tool steps: a
 * command, a file read, a search, a find, a folder listing, a page fetch and a
 * web search each open their own view from the step's title, and the marks on
 * the step row (exit code, http status, stopped) hold after a restart.
 *
 * A loopback model scripts each turn. The commands run for real in a project
 * folder inside the test's own data root, the files are written there by the
 * test, and every page fetch and web search is answered by a `node:http`
 * server in this process. With ABU_E2E_SCREENSHOT_DIR set, a few views are
 * saved there for review.
 */
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import path from 'node:path';
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
import {
  CHAT_PLACEHOLDER,
  READY_TIMEOUT,
  closeServer,
  startOpenAiMock,
  taskRequests,
  waitForApp,
  type MockReplyPlan,
  type OpenAiMock,
} from './openAiMock';
import { pdfBytes } from './previewFixtures';
import { persistedStoreVersion } from './storeVersions';

const PROJECT_NAME = 'E2E 工具视图';
const PROMPT = '请看看这些步骤';
const FINAL_TEXT = '步骤都做完了。';
const REPLY_TIMEOUT = 90_000;
const SCREENSHOT_DIR = process.env.ABU_E2E_SCREENSHOT_DIR;

type StepViewKind = 'command' | 'file-read' | 'search' | 'find' | 'list' | 'web-fetch' | 'web-search';

interface WebServer {
  origin: string;
  /** Address without the scheme, as a step title shows it. */
  host: string;
  close: () => Promise<void>;
}

interface Session {
  app: ElectronApplication;
  page: Page;
  dataRoot: ElectronDataRoot;
  mock: OpenAiMock;
  web: WebServer;
  workspace: string;
}

let session: Session | undefined;

async function endSession(): Promise<void> {
  const ending = session;
  session = undefined;
  if (!ending) return;
  await closeAbuElectron(ending.app);
  await ending.mock.close();
  await ending.web.close();
  removeElectronDataRoot(ending.dataRoot);
}

// ---------------------------------------------------------------------------
// Fixtures: the page server, the files and the scripted turns
// ---------------------------------------------------------------------------

const PAGE_LINES = Array.from({ length: 30 }, (_, index) => `page line ${index + 1}`);
const MISSING_BODY = 'abu e2e: there is no page here';
const SEARCH_QUERY = 'abu e2e search';
const SEARCH_RESULTS = Array.from({ length: 8 }, (_, index) => ({
  title: `E2E 搜索结果 ${index + 1}`,
  url: `https://abu-e2e-result-${index + 1}.invalid/article`,
  content: `摘要 ${index + 1}`,
}));
const UNKNOWN_HOST_URL = 'http://abu-e2e-no-such-host.invalid/';

/** Serves /page, /long, /missing and a SearXNG-shaped /search on loopback. */
async function startWebServer(): Promise<WebServer> {
  const responses = new Set<ServerResponse>();
  const server = createServer((req, res) => {
    responses.add(res);
    res.once('close', () => responses.delete(res));
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/page') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(PAGE_LINES.join('\n'));
    } else if (url.pathname === '/long') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('l'.repeat(60_000));
    } else if (url.pathname === '/missing') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(MISSING_BODY);
    } else if (url.pathname === '/search' && url.searchParams.get('format') === 'json') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ query: url.searchParams.get('q'), results: SEARCH_RESULTS }));
    } else {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`unexpected route ${url.pathname}`);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('The page server did not receive a TCP port');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    host: `127.0.0.1:${address.port}`,
    close: () => closeServer(server, responses),
  };
}

function numberedLines(prefix: string, count: number): string {
  // No newline at the end: read_file counts the lines of `split('\n')`.
  return Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join('\n');
}

/** The folders and files every story reads, under `workspace`. */
function seedWorkspace(workspace: string): void {
  const dir = (...parts: string[]) => {
    const full = path.join(workspace, ...parts);
    fs.mkdirSync(full, { recursive: true });
    return full;
  };
  const files = dir('files');
  fs.writeFileSync(path.join(files, 'app.ts'), numberedLines('const line =', 120));
  fs.writeFileSync(path.join(files, 'big.ts'), numberedLines('big line', 1500));
  fs.writeFileSync(path.join(files, 'doc.pdf'), pdfBytes(1));
  fs.writeFileSync(path.join(files, 'huge.txt'), `${'h'.repeat(99)}\n`.repeat(3000));

  // 17 lines that hold useEffect, in 4 files: 5 + 4 + 4 + 4.
  const search = dir('search');
  [5, 4, 4, 4].forEach((count, index) => {
    const lines = Array.from({ length: count }, (_, line) => `useEffect(() => step${line + 1}());`);
    fs.writeFileSync(path.join(search, `hook${index + 1}.ts`), `${lines.join('\nconst gap = 0;\n')}\n`);
  });
  fs.writeFileSync(
    path.join(dir('capped'), 'many.txt'),
    `${Array.from({ length: 150 }, (_, index) => `needle ${index + 1}`).join('\n')}\n`,
  );

  const find = dir('find');
  for (let index = 1; index <= 23; index++) {
    fs.writeFileSync(path.join(dir('find', index % 2 === 0 ? 'even' : 'odd'), `case${index}.test.ts`), 'export {};\n');
  }
  fs.writeFileSync(path.join(find, 'helper.ts'), 'export {};\n');

  for (let index = 1; index <= 4; index++) dir('list', `folder${index}`);
  for (let index = 1; index <= 8; index++) fs.writeFileSync(path.join(dir('list'), `file${index}.txt`), 'x\n');
  dir('empty');
}

function call(id: string, toolName: string, args: Record<string, unknown>): MockReplyPlan {
  return { kind: 'tool-call', toolCallId: id, toolName, arguments: args };
}

const commandPurposes = new Map<string, string>();

/** The plain-language purpose a command's run_command call carries: one distinct sentence per command. */
function purposeOf(command: string): string {
  let purpose = commandPurposes.get(command);
  if (!purpose) {
    purpose = `运行检查 ${commandPurposes.size + 1}`;
    commandPurposes.set(command, purpose);
  }
  return purpose;
}

function commandCall(id: string, command: string, extra: Record<string, unknown> = {}): MockReplyPlan {
  return call(id, 'run_command', { command, purpose: purposeOf(command), ...extra });
}

function finalReply(): MockReplyPlan {
  return { kind: 'complete', responseText: FINAL_TEXT };
}

/** The title of a run_command step: the plain-language purpose the call carries, not the command. */
function commandTitle(command: string): string {
  return purposeOf(command);
}

// ---------------------------------------------------------------------------
// The app
// ---------------------------------------------------------------------------

/** Save the window as `name`, with `focus` scrolled into view first when given. */
async function shot(page: Page, name: string, focus?: Locator): Promise<void> {
  if (!SCREENSHOT_DIR) return;
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  if (focus) {
    await focus.scrollIntoViewIfNeeded();
    await waitUntilAtRest(focus);
  }
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `tool-views-${name}.png`), animations: 'disabled' });
}

/** Point web_search at the page server's SearXNG route. */
async function configureWebSearch(page: Page, baseUrl: string): Promise<void> {
  await Promise.all([page.waitForEvent('load'), page.evaluate(async (searchUrl) => {
    await navigator.locks.request('abu-browser-permission-config-v2', () => {
      const raw = window.localStorage.getItem('abu-settings');
      if (!raw) throw new Error('abu-settings was not initialized before E2E configuration');
      const persisted = JSON.parse(raw) as { state: Record<string, unknown>; version: number };
      const services = (persisted.state.auxiliaryServices ?? {}) as Record<string, unknown>;
      persisted.state.auxiliaryServices = {
        ...services,
        webSearch: { provider: 'searxng', apiKey: '', baseUrl: searchUrl },
      };
      window.localStorage.setItem('abu-settings', JSON.stringify(persisted));
      window.location.reload();
    });
  }, baseUrl)]);
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible({ timeout: READY_TIMEOUT });
}

/** Launch the app with a project whose folder holds the seeded files, and a new task open in it. */
async function launchInProject(plansFor: (workspace: string, web: WebServer) => MockReplyPlan[]): Promise<Page> {
  const dataRoot = createElectronDataRoot();
  const workspace = path.join(dataRoot.rootDir, 'workspace');
  seedWorkspace(workspace);
  const web = await startWebServer();
  const mock = await startOpenAiMock(plansFor(workspace, web));
  const app = (await launchAbuElectron(dataRoot)).app;
  const page = await app.firstWindow({ timeout: READY_TIMEOUT });
  session = { app, page, dataRoot, mock, web, workspace };

  await waitForApp(page);
  await page.evaluate(({ name, workspacePath, version }) => {
    window.localStorage.setItem('abu-projects', JSON.stringify({
      state: {
        projects: {
          'project-tool-views': {
            id: 'project-tool-views', name, workspacePath, pinned: false, archived: false,
            createdAt: 1_800_000_000_000, updatedAt: 1_800_000_000_000, lastActiveAt: 1_800_000_000_000,
          },
        },
      },
      version,
    }));
  }, { name: PROJECT_NAME, workspacePath: workspace, version: persistedStoreVersion('abu-projects') });
  await dismissFirstRunOverlays(page);
  await configureLocalMockProvider(page, mock.baseUrl, { supportsTools: true, permissionMode: 'autonomous' });
  await configureWebSearch(page, web.origin);

  await page.getByRole('button', { name: PROJECT_NAME, exact: true })
    .locator('xpath=..')
    .getByRole('button', { name: '新任务', exact: true })
    .click();
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible();
  return page;
}

async function send(page: Page): Promise<void> {
  const composer = page.getByPlaceholder(CHAT_PLACEHOLDER);
  await composer.fill(PROMPT);
  await composer.press('Enter');
}

/** Send the prompt and wait until the turn has ended: the reply is there and the work process has folded. */
async function runTurn(page: Page): Promise<void> {
  await send(page);
  await expect(page.getByText(FINAL_TEXT)).toBeVisible({ timeout: REPLY_TIMEOUT });
  await expect(page.getByRole('button', { name: /^用时/ }).last()).toBeVisible({ timeout: REPLY_TIMEOUT });
}

/** Show every step of the turn: unfold the work process and its group of steps. */
async function showSteps(page: Page): Promise<void> {
  const work = page.getByRole('button', { name: /^(用时|你在 .* 后停止了)/ }).first();
  if ((await work.count()) > 0 && (await work.getAttribute('aria-expanded')) === 'false') await work.click();
  // The group is named by what its steps did, or 已停止 once the turn was stopped.
  const group = page.getByRole('button', { name: /^(修改了|执行了|调用了|读取了|已停止$)/ }).first();
  await expect(group).toBeVisible();
  if ((await group.getAttribute('aria-expanded')) === 'false') await group.click();
}

/**
 * Wait until `target` has stopped moving. Opening the work process or a group
 * of steps animates the boxes around the rows, and the conversation scrolls
 * along with it.
 */
async function waitUntilAtRest(target: Locator): Promise<void> {
  await expect.poll(() => target.evaluate((element) => document.getAnimations()
    .filter((animation) => (animation.effect as KeyframeEffect | null)?.target?.contains(element))
    .length)).toBe(0);
}

/** The title button of the step titled `title`. */
function stepTitle(page: Page, title: string): Locator {
  return page.getByRole('button', { name: title, exact: true });
}

/** The content column of the step titled `title`: its title line, its view and its completion line. */
function stepRow(page: Page, title: string): Locator {
  return stepTitle(page, title).locator('xpath=../..');
}

/** Open the view of the step titled `title` and return its row and view. */
async function openView(page: Page, title: string, kind: StepViewKind): Promise<{ row: Locator; view: Locator }> {
  const button = stepTitle(page, title);
  const row = stepRow(page, title);
  await expect(button).toBeVisible();
  // The step list scrolls inside its own box: bring the step into its view first.
  await waitUntilAtRest(row);
  await button.scrollIntoViewIfNeeded();
  await waitUntilAtRest(row);
  if ((await button.getAttribute('aria-expanded')) === 'false') await button.click();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  const view = row.locator(`[data-step-view="${kind}"]`);
  await expect(view).toBeVisible();
  return { row, view };
}

/** The view shows `reason` as failure text. */
async function expectFailureText(view: Locator, reason: string): Promise<void> {
  const failure = view.locator('[data-tool-result]');
  await expect(failure).toHaveCount(1);
  await expect(failure).toContainText(reason);
  await expect(failure).toHaveClass(/\btext-danger\b/);
}

interface SentMessage {
  role?: string;
  tool_call_id?: string;
  content?: unknown;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
}

/**
 * The result text the app sent back to the model for the `toolName` call whose
 * arguments hold `argument`, paired by the call's id in the last request of the
 * turn. The memory extraction the app starts once a turn has ended is a request
 * of its own that can arrive later, so only task requests are read.
 */
function toolResultSent(toolName: string, argument: string): string {
  const requests = taskRequests(session!.mock);
  const messages = ((requests.at(-1)?.body as { messages?: SentMessage[] } | undefined)?.messages) ?? [];
  const call = messages
    .flatMap((message) => (message.role === 'assistant' ? message.tool_calls ?? [] : []))
    .find((candidate) => candidate.function?.name === toolName && (candidate.function.arguments ?? '').includes(argument));
  if (!call) throw new Error(`the last task request holds no ${toolName} call with ${argument}`);
  const result = messages.find((message) => message.role === 'tool' && message.tool_call_id === call.id);
  if (!result) throw new Error(`the last task request holds no result for ${toolName} (${String(call.id)})`);
  return typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
}

/** The line numbers a numbered file view shows first. */
async function firstLineNumber(view: Locator): Promise<string> {
  return view.locator('pre[data-line-numbers]').first()
    .evaluate((element) => (element.textContent ?? '').split('\n')[0]);
}

/**
 * Quit the app, run `whileClosed`, start the app again and open the
 * conversation; `shown` is what the opened conversation shows once it is there.
 */
async function reopenConversation(
  whileClosed: () => void = () => {},
  shown: (page: Page) => Locator = (opened) => opened.getByText(FINAL_TEXT),
): Promise<Page> {
  const current = session!;
  await closeAbuElectron(current.app);
  whileClosed();
  const app = (await launchAbuElectron(current.dataRoot)).app;
  const reopened = await app.firstWindow({ timeout: READY_TIMEOUT });
  session = { ...current, app, page: reopened };
  await waitForApp(reopened);
  const project = reopened.getByRole('group', { name: PROJECT_NAME })
    .getByRole('button', { name: PROJECT_NAME, exact: true });
  const showSidebar = reopened.getByRole('button', { name: '显示侧栏', exact: true });
  // The sidebar comes back open or folded, depending on how the last run left it.
  await expect(project.or(showSidebar)).toBeVisible();
  if (await showSidebar.isVisible()) await showSidebar.click();
  await project.click();
  await reopened.getByRole('button', { name: new RegExp(`^${PROMPT}`) }).click();
  await expect(shown(reopened)).toBeVisible();
  return reopened;
}

// ---------------------------------------------------------------------------
// Story 1: a command
// ---------------------------------------------------------------------------

const THIRTY_LINES = "printf 'line %s\\n' $(seq 1 30)";
const FAILING = "printf 'kept\\n'; printf 'went wrong\\n' >&2; exit 1";
const SILENT = "sh -c 'exit 0'";
const NOT_A_PROGRAM = 'abu-e2e-no-such-program';
const SLEEP = 'sleep 30';

test.describe('story 1', () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });
  let page: Page;

  test.beforeAll(async () => {
    page = await launchInProject(() => [
      commandCall('call-thirty', THIRTY_LINES),
      commandCall('call-failing', FAILING),
      commandCall('call-silent', SILENT),
      commandCall('call-not-a-program', NOT_A_PROGRAM),
      finalReply(),
    ]);
    await runTurn(page);
    await showSteps(page);
    await shot(page, '00-command-rows', stepTitle(page, commandTitle(THIRTY_LINES)));
  });
  test.afterAll(endSession);

  test('when the user opens a command with 30 lines of output, the view shows the command, the output folded with a button that shows all 30 lines, and the row carries no mark', async () => {
    const { row, view } = await openView(page, commandTitle(THIRTY_LINES), 'command');
    await expect(view).toContainText(THIRTY_LINES);
    await expect(view.getByRole('button', { name: '复制', exact: true })).toBeVisible();
    await expect(view.getByText('输出', { exact: true })).toBeVisible();
    await expect(view.getByText('line 15', { exact: true })).toHaveCount(0);
    await shot(page, '01-command-folded', view);
    await view.getByRole('button', { name: '显示全部 30 行', exact: true }).click();
    await expect(view.locator('[data-tool-result]')).toContainText('line 15');
    await expect(row.locator('[data-exit-code]')).toHaveCount(0);
  });

  test('when a command ends with exit code 1, the row says 退出码 1 and the view keeps the output and the error output apart', async () => {
    const title = commandTitle(FAILING);
    await expect(stepRow(page, title).locator('[data-exit-code="1"]')).toHaveText('退出码 1');
    const { row, view } = await openView(page, title, 'command');
    await expect(view.getByText('输出', { exact: true })).toBeVisible();
    await expect(view.getByText('错误输出', { exact: true })).toBeVisible();
    const sections = view.locator('[data-tool-result]');
    await expect(sections).toHaveCount(2);
    await expect(sections.nth(0)).toHaveText('kept');
    await expect(sections.nth(1)).toHaveText('went wrong');
    await expect(sections.nth(1)).toHaveClass(/\btext-danger\b/);
    await expect(row.locator('[data-exit-code]')).toHaveCount(1);
    await shot(page, '02-command-exit-1', view);
  });

  test('when the user opens a command that printed nothing, the view says 没有输出', async () => {
    const { view } = await openView(page, commandTitle(SILENT), 'command');
    await expect(view).toContainText(SILENT);
    await expect(view.getByText('没有输出', { exact: true })).toBeVisible();
    await expect(view.locator('[data-tool-result]')).toHaveCount(0);
  });

  test('when the program does not exist, the row says 退出码 127 and the error output holds the shell message', async () => {
    const title = commandTitle(NOT_A_PROGRAM);
    await expect(stepRow(page, title).locator('[data-exit-code="127"]')).toHaveText('退出码 127');
    const { view } = await openView(page, title, 'command');
    await expect(view.getByText('错误输出', { exact: true })).toBeVisible();
    const errorOutput = view.locator('[data-tool-result].text-danger');
    await expect(errorOutput).toContainText(NOT_A_PROGRAM);
    await expect(errorOutput).toContainText('not found');
  });
});

test.describe('story 1, a command that has not ended', () => {
  test.describe.configure({ timeout: 300_000 });
  test.afterEach(endSession);

  test('when the user opens a running command it shows 运行中…, and after 停止, also after a restart, the row says 已停止 and the view holds the command only', async () => {
    const page = await launchInProject(() => [commandCall('call-sleep', SLEEP)]);
    await send(page);
    const title = commandTitle(SLEEP);
    await expect(stepTitle(page, title)).toBeVisible({ timeout: REPLY_TIMEOUT });
    const running = await openView(page, title, 'command');
    await expect(running.view.getByText('运行中…', { exact: true })).toBeVisible();
    await shot(page, '03-command-running', running.view);

    const stop = page.getByLabel(/^停止$/);
    await stop.click();
    await expect(stop).toBeHidden({ timeout: READY_TIMEOUT });
    const expectStopped = async (shownPage: Page, shotName: string) => {
      await showSteps(shownPage);
      const { row, view } = await openView(shownPage, title, 'command');
      await expect(view).toContainText(SLEEP);
      await expect(view.getByText('运行中…', { exact: true })).toHaveCount(0);
      await expect(view.getByText('没有输出', { exact: true })).toHaveCount(0);
      await expect(view.locator('[data-tool-result]')).toHaveCount(0);
      await expect(row.getByRole('status', { name: '已停止' })).toBeVisible();
      await expect(shownPage.getByText('执行出错', { exact: true })).toHaveCount(0);
      await shot(shownPage, shotName, row);
    };
    await expectStopped(page, '03-command-stopped');

    const reopened = await reopenConversation(
      () => {},
      (opened) => opened.getByRole('button', { name: /^你在 .* 后停止了/ }).first(),
    );
    await expectStopped(reopened, '03-command-stopped-after-restart');
  });

  test('while the turn runs, a command that ended says 命令已结束：', async () => {
    const page = await launchInProject(() => [
      commandCall('call-failing', FAILING),
      { kind: 'hold-open', partialText: '' },
    ]);
    await send(page);
    const row = stepRow(page, commandTitle(FAILING));
    await expect(row.locator('[data-exit-code="1"]')).toHaveText('退出码 1', { timeout: REPLY_TIMEOUT });
    await expect(row.getByText(/^命令已结束：/)).toBeVisible();

    const stop = page.getByLabel(/^停止$/);
    await stop.click();
    await expect(stop).toBeHidden({ timeout: READY_TIMEOUT });
  });

  test('when the user opens a command started in the background, the view holds the command only', async () => {
    const page = await launchInProject(() => [
      commandCall('call-background', SLEEP, { background: true }),
      finalReply(),
    ]);
    await runTurn(page);
    await showSteps(page);
    const { row, view } = await openView(page, `${commandTitle(SLEEP)}（在后台）`, 'command');
    await expect(view).toContainText(SLEEP);
    await expect(view.getByText('运行中…', { exact: true })).toHaveCount(0);
    await expect(view.getByText('没有输出', { exact: true })).toHaveCount(0);
    await expect(view.locator('[data-tool-result]')).toHaveCount(0);
    await expect(row.locator('[data-exit-code]')).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// The step list of a long turn
// ---------------------------------------------------------------------------

const QUICK_COMMANDS = Array.from({ length: 9 }, (_, index) => `printf 'step ${index + 1}\\n'`);

/** A command that runs until the test writes the file gate-`gate` into the project folder. */
function gateCommand(workspace: string, gate: number): string {
  return `G=${gate}; until [ -f '${path.join(workspace, `gate-${gate}`)}' ]; do sleep 0.1; done`;
}

/** How far the list's scroll position is from its end, in pixels. */
function distanceFromEnd(list: Locator): Promise<number> {
  return list.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
}

test.describe('the step list', () => {
  test.describe.configure({ timeout: 300_000 });
  test.afterEach(endSession);

  test('a long turn scrolls inside its step list', async () => {
    const page = await launchInProject((workspace) => [
      ...QUICK_COMMANDS.map((command, index) => commandCall(`call-quick-${index + 1}`, command)),
      ...[1, 2, 3].map((gate) => commandCall(`call-gate-${gate}`, gateCommand(workspace, gate))),
      finalReply(),
    ]);
    const workspace = session!.workspace;
    const gateStep = (gate: number) => stepTitle(page, commandTitle(gateCommand(workspace, gate)));
    const openGate = (gate: number) => fs.writeFileSync(path.join(workspace, `gate-${gate}`), '');
    await send(page);

    // Ten steps, the last one running: every step is in the list and no button hides any.
    await expect(gateStep(1)).toBeAttached({ timeout: REPLY_TIMEOUT });
    const list = page.locator('[data-step-list]').filter({ has: gateStep(1) });
    for (const command of QUICK_COMMANDS) await expect(list.getByRole('button', { name: commandTitle(command), exact: true })).toBeAttached();
    await expect(page.getByRole('button', { name: '查看更多', exact: true })).toHaveCount(0);

    // A new step while the reader is at the end: the list stays at its end.
    openGate(1);
    await expect(list.locator(gateStep(2))).toBeAttached({ timeout: REPLY_TIMEOUT });
    await expect.poll(() => list.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    await expect.poll(() => distanceFromEnd(list)).toBeLessThanOrEqual(1);
    await shot(page, '08-step-list-at-end', list);

    // The reader scrolls up; the next step leaves the scroll position where it is.
    const readerTop = await list.evaluate(async (element) => {
      await new Promise((resolve) => {
        element.addEventListener('scroll', resolve, { once: true });
        element.scrollTop -= 120;
      });
      return element.scrollTop;
    });
    // Steps lie beyond both ends now: both ends fade.
    await expect(list).toHaveClass(/\bmask-t-from-\(--ds-scroll-fade-start\)/);
    await expect(list).toHaveClass(/\bmask-b-from-\(--ds-scroll-fade-start\)/);
    expect(await list.evaluate((element) => getComputedStyle(element).maskImage)).toContain('linear-gradient');
    const heightBefore = await list.evaluate((element) => element.scrollHeight);
    openGate(2);
    await expect(list.locator(gateStep(3))).toBeAttached({ timeout: REPLY_TIMEOUT });
    await expect.poll(() => list.evaluate((element) => element.scrollHeight)).toBeGreaterThan(heightBefore);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await list.evaluate((element) => element.scrollTop)).toBe(readerTop);
    await expect(page.getByRole('button', { name: '查看更多', exact: true })).toHaveCount(0);
    await shot(page, '08-step-list-scrolled', list);

    openGate(3);
    await expect(page.getByText(FINAL_TEXT)).toBeVisible({ timeout: REPLY_TIMEOUT });
  });
});

// ---------------------------------------------------------------------------
// Story 2: a file read
// ---------------------------------------------------------------------------

test.describe('story 2', () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });
  let page: Page;

  test.beforeAll(async () => {
    page = await launchInProject((workspace) => {
      const file = (name: string) => path.join(workspace, 'files', name);
      return [
        call('call-read-all', 'read_file', { path: file('app.ts') }),
        call('call-read-range', 'read_file', { path: file('big.ts'), offset: 199, limit: 100 }),
        call('call-read-pdf', 'read_file', { path: file('doc.pdf') }),
        call('call-read-missing', 'read_file', { path: file('missing.ts') }),
        call('call-read-huge', 'read_file', { path: file('huge.txt') }),
        finalReply(),
      ];
    });
    await runTurn(page);
    await showSteps(page);
    await shot(page, '04-file-read-rows', stepTitle(page, '读取 app.ts'));
  });
  test.afterAll(endSession);

  test('when the user opens a whole read of a 120-line file, the view says 共 120 行 and numbers the lines from 1, folded with a button that shows all 120 lines', async () => {
    const { view } = await openView(page, '读取 app.ts', 'file-read');
    await expect(view.getByText('共 120 行', { exact: true })).toBeVisible();
    expect(await firstLineNumber(view)).toBe('1');
    await expect(view.getByRole('button', { name: '显示全部 120 行', exact: true })).toBeVisible();
    await shot(page, '04-file-read', view);
  });

  test('when the user opens a read of lines 200 to 299, the view says 第 200–299 行，共 1500 行 and numbers the lines from 200', async () => {
    const { view } = await openView(page, '读取 big.ts', 'file-read');
    await expect(view.getByText('第 200–299 行，共 1500 行', { exact: true })).toBeVisible();
    expect(await firstLineNumber(view)).toBe('200');
    await expect(view).toContainText('big line 200');
    await shot(page, '04-file-read-range', view);
  });

  test('when the user opens a read of a PDF, the view shows the extracted text without line numbers', async () => {
    const { view } = await openView(page, '读取 doc.pdf', 'file-read');
    await expect(view).toContainText('PDFMARK-V1');
    await expect(view.locator('pre[data-line-numbers]')).toHaveCount(0);
  });

  test('when a file does not exist, the view holds the failure text in the failure style', async () => {
    const { view } = await openView(page, '读取 missing.ts', 'file-read');
    const reason = toolResultSent('read_file', 'missing.ts').replace(/^Error reading file: /, '');
    expect(reason).toContain('missing.ts');
    await expectFailureText(view, reason);
    await shot(page, '04-file-read-failed', view);
  });

  test('when the user opens a read of a file over 256 KB, the view shows the too-large notice as written, without line numbers', async () => {
    const { view } = await openView(page, '读取 huge.txt', 'file-read');
    await expect(view).toContainText('File is too large to read at once');
    await expect(view.locator('pre[data-line-numbers]')).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Story 3: search, find and list
// ---------------------------------------------------------------------------

test.describe('story 3', () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });
  let page: Page;

  test.beforeAll(async () => {
    page = await launchInProject((workspace) => [
      call('call-search', 'search_files', { pattern: 'useEffect', path: path.join(workspace, 'search') }),
      call('call-search-capped', 'search_files', { pattern: 'needle', path: path.join(workspace, 'capped'), max_results: 100 }),
      call('call-search-none', 'search_files', { pattern: 'abu-e2e-absent', path: path.join(workspace, 'search') }),
      call('call-find', 'find_files', { pattern: '*.test.ts', path: path.join(workspace, 'find') }),
      call('call-list', 'list_directory', { path: path.join(workspace, 'list') }),
      call('call-list-empty', 'list_directory', { path: path.join(workspace, 'empty') }),
      finalReply(),
    ]);
    await runTurn(page);
    await showSteps(page);
    await shot(page, '05-search-find-list-rows', stepTitle(page, '搜索 "useEffect"'));
  });
  test.afterAll(endSession);

  test('when the user opens a search with 17 matches in 4 files, the view says 17 处匹配 · 4 个文件 and groups the matches by file, each group folding on its own', async () => {
    const { view } = await openView(page, '搜索 "useEffect"', 'search');
    await expect(view.getByText('17 处匹配 · 4 个文件', { exact: true })).toBeVisible();
    await view.getByRole('button', { name: /^显示全部/ }).click();
    const groups = view.getByRole('button', { name: / \d+ 处$/ });
    await expect(groups).toHaveCount(4);
    const groupNames = (await groups.allInnerTexts()).map((name) => path.basename(name.replace(/\s+/g, ' ').trim()));
    expect(groupNames.sort()).toEqual(['hook1.ts 5 处', 'hook2.ts 4 处', 'hook3.ts 4 处', 'hook4.ts 4 处']);
    await shot(page, '05-search', view);
    await expect(groups.nth(0)).toHaveAttribute('aria-expanded', 'true');
    await groups.nth(0).click();
    await expect(groups.nth(0)).toHaveAttribute('aria-expanded', 'false');
    await expect(groups.nth(1)).toHaveAttribute('aria-expanded', 'true');
  });

  test('when the search reached its limit, the view says 显示 100 处匹配，还有更多没有列出', async () => {
    const { view } = await openView(page, '搜索 "needle"', 'search');
    await expect(view.getByText('显示 100 处匹配，还有更多没有列出', { exact: true })).toBeVisible();
  });

  test('when the search found nothing, the view says 没有找到匹配', async () => {
    const { view } = await openView(page, '搜索 "abu-e2e-absent"', 'search');
    await expect(view.getByText('没有找到匹配', { exact: true })).toBeVisible();
  });

  test('when the user opens a find of 23 files, the view says 23 个文件 and lists 23 paths', async () => {
    const { view } = await openView(page, '查找 *.test.ts', 'find');
    await expect(view.getByText('23 个文件', { exact: true })).toBeVisible();
    await expect(view.getByRole('button', { name: '显示全部 23 行', exact: true })).toBeVisible();
    await expect(view.getByText(/case\d+\.test\.ts$/)).toHaveCount(9);
    await shot(page, '05-find', view);
  });

  test('when the user opens a listing of a folder with 12 entries, the view says 12 个条目', async () => {
    const { view } = await openView(page, '列出 list', 'list');
    await expect(view.getByText('12 个条目', { exact: true })).toBeVisible();
    await expect(view).toContainText('file1.txt');
    await expect(view).toContainText('folder4');
    await expect(view.getByRole('button', { name: '显示全部 12 行', exact: true })).toBeVisible();
    await shot(page, '05-list', view);
  });

  test('when the user opens a listing of an empty folder, the view says 这个文件夹是空的', async () => {
    const { view } = await openView(page, '列出 empty', 'list');
    await expect(view.getByText('这个文件夹是空的', { exact: true })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Story 4: a page fetch and a web search
// ---------------------------------------------------------------------------

test.describe('story 4', () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });
  let page: Page;
  let host: string;

  test.beforeAll(async () => {
    page = await launchInProject((_workspace, web) => {
      host = web.host;
      return [
        call('call-fetch-page', 'http_fetch', { url: `${web.origin}/page` }),
        call('call-fetch-long', 'http_fetch', { url: `${web.origin}/long` }),
        call('call-fetch-missing', 'http_fetch', { url: `${web.origin}/missing` }),
        call('call-fetch-unknown-host', 'http_fetch', { url: UNKNOWN_HOST_URL }),
        call('call-web-search', 'web_search', { query: SEARCH_QUERY }),
        finalReply(),
      ];
    });
    await runTurn(page);
    await showSteps(page);
    await shot(page, '06-web-rows', stepTitle(page, `读取网页 ${host}/page`));
  });
  test.afterAll(endSession);

  test('when the user looks at a page fetch, its title names the address and opens it, and the view says 200 OK above the page text', async () => {
    const title = `读取网页 ${host}/page`;
    const row = stepRow(page, title);
    const address = row.locator('a[target="_blank"]').first();
    await expect(address).toHaveText(`${host}/page`);
    await expect(address).toHaveAttribute('href', `http://${host}/page`);
    const { view } = await openView(page, title, 'web-fetch');
    await expect(view.locator('[data-http-status-line]')).toHaveText('200 OK');
    await expect(view.locator('[data-tool-result]')).toContainText('page line 1');
    await shot(page, '06-web-fetch', view);
  });

  test('when the page text was cut, the view says 内容已截断', async () => {
    const { view } = await openView(page, `读取网页 ${host}/long`, 'web-fetch');
    await expect(view.locator('[data-http-status-line]')).toContainText('内容已截断');
    await shot(page, '06-web-fetch-cut', view);
  });

  test('when the page answers 404, the row says 404 and the view shows the page text', async () => {
    const title = `读取网页 ${host}/missing`;
    await expect(stepRow(page, title).locator('[data-http-status="404"]')).toHaveText('404');
    const { view } = await openView(page, title, 'web-fetch');
    await expect(view.locator('[data-tool-result]')).toContainText(MISSING_BODY);
    await shot(page, '06-web-fetch-404', view);
  });

  test('when the request itself fails, the view holds the failure text in the failure style', async () => {
    const { view } = await openView(page, '读取网页 abu-e2e-no-such-host.invalid/', 'web-fetch');
    const reason = toolResultSent('http_fetch', UNKNOWN_HOST_URL).replace(/^Error making HTTP request: /, '');
    expect(reason.length).toBeGreaterThan(0);
    await expectFailureText(view, reason);
    await shot(page, '06-web-fetch-failed', view);
  });

  test('when the user opens a web search with 8 results, the view lists all 8 with the links of the sources below the reply', async () => {
    const { view } = await openView(page, `网页搜索 "${SEARCH_QUERY}"`, 'web-search');
    const links = view.locator('a[target="_blank"]');
    await expect(links).toHaveCount(8);
    await shot(page, '07-web-search', view);
    const viewLinks = await links.evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute('href')));
    await page.getByRole('button', { name: /^来源/ }).click();
    const sources = page.locator('[data-source-index]');
    await expect(sources).toHaveCount(8);
    const sourceLinks = await sources.evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute('href')));
    expect(new Set(viewLinks)).toEqual(new Set(sourceLinks));
    expect(new Set(viewLinks)).toEqual(new Set(SEARCH_RESULTS.map((result) => result.url)));
    await shot(page, '07-web-search-sources', sources.first());
  });
});

// ---------------------------------------------------------------------------
// After a restart
// ---------------------------------------------------------------------------

test.describe('after a restart', () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });
  let page: Page;
  let host: string;

  test.beforeAll(async () => {
    page = await launchInProject((workspace, web) => {
      host = web.host;
      return [
        commandCall('call-failing', FAILING),
        call('call-read-range', 'read_file', { path: path.join(workspace, 'files', 'big.ts'), offset: 199, limit: 100 }),
        call('call-search', 'search_files', { pattern: 'useEffect', path: path.join(workspace, 'search') }),
        call('call-fetch-missing', 'http_fetch', { url: `${web.origin}/missing` }),
        finalReply(),
      ];
    });
    await runTurn(page);
    page = await reopenConversation();
    await showSteps(page);
  });
  test.afterAll(endSession);

  test('when the user opens the exit-code-1 command after a restart, the row still says 退出码 1 and the view keeps the two outputs apart', async () => {
    const title = commandTitle(FAILING);
    await expect(stepRow(page, title).locator('[data-exit-code="1"]')).toHaveText('退出码 1');
    const { view } = await openView(page, title, 'command');
    await expect(view.getByText('错误输出', { exact: true })).toBeVisible();
    await expect(view.locator('[data-tool-result]').nth(1)).toHaveText('went wrong');
  });

  test('when the user opens the read of lines 200 to 299 after a restart, the view still says 第 200–299 行，共 1500 行', async () => {
    const { view } = await openView(page, '读取 big.ts', 'file-read');
    await expect(view.getByText('第 200–299 行，共 1500 行', { exact: true })).toBeVisible();
    expect(await firstLineNumber(view)).toBe('200');
  });

  test('when the user opens the search after a restart, the view still says 17 处匹配 · 4 个文件', async () => {
    const { view } = await openView(page, '搜索 "useEffect"', 'search');
    await expect(view.getByText('17 处匹配 · 4 个文件', { exact: true })).toBeVisible();
  });

  test('when the user looks at the 404 page fetch after a restart, the row still says 404', async () => {
    const title = `读取网页 ${host}/missing`;
    await expect(stepRow(page, title).locator('[data-http-status="404"]')).toHaveText('404');
    const { view } = await openView(page, title, 'web-fetch');
    await expect(view.locator('[data-tool-result]')).toContainText(MISSING_BODY);
  });
});

/** Every file named `name` under `root`. */
function filesNamed(root: string, name: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) return filesNamed(full, name);
    return entry.name === name ? [full] : [];
  });
}

interface StoredToolCall { name?: string; commandOutcome?: unknown }
interface StoredMessage { toolCalls?: StoredToolCall[] }

/** Remove the command outcome from every run_command call of `message`; returns how many it removed. */
function forgetCommandOutcomes(message: StoredMessage | undefined): number {
  let removed = 0;
  for (const toolCall of message?.toolCalls ?? []) {
    if (toolCall.name === 'run_command' && toolCall.commandOutcome !== undefined) {
      delete toolCall.commandOutcome;
      removed++;
    }
  }
  return removed;
}

/**
 * Turn the saved conversations into the records an older Abu wrote: no
 * run_command call carries a command outcome. Returns how many it removed.
 */
function writeRecordsWithoutCommandOutcomes(appDataDir: string): number {
  let removed = 0;
  for (const ledger of filesNamed(appDataDir, 'messages.jsonl')) {
    const rows = fs.readFileSync(ledger, 'utf8').split('\n').map((line) => {
      if (!line.trim()) return line;
      const row = JSON.parse(line) as StoredMessage;
      const count = forgetCommandOutcomes(row);
      removed += count;
      return count > 0 ? JSON.stringify(row) : line;
    });
    fs.writeFileSync(ledger, rows.join('\n'));
  }
  for (const snapshot of filesNamed(appDataDir, 'stream-snapshot.json')) {
    const file = JSON.parse(fs.readFileSync(snapshot, 'utf8')) as {
      entries?: Array<{ message?: StoredMessage }>;
      messages?: StoredMessage[];
    };
    for (const entry of file.entries ?? []) removed += forgetCommandOutcomes(entry.message);
    for (const message of file.messages ?? []) removed += forgetCommandOutcomes(message);
    fs.writeFileSync(snapshot, JSON.stringify(file));
  }
  return removed;
}

test.describe('after a restart, a record without a command outcome', () => {
  test.describe.configure({ timeout: 300_000 });
  test.afterEach(endSession);

  test('when the user opens a command saved without its outcome, the view shows the whole result as one output and the row carries no exit code', async () => {
    const page = await launchInProject(() => [commandCall('call-failing', FAILING), finalReply()]);
    await runTurn(page);
    let removed = 0;
    const reopened = await reopenConversation(() => {
      removed = writeRecordsWithoutCommandOutcomes(session!.dataRoot.appDataDir);
    });
    expect(removed).toBeGreaterThan(0);
    await showSteps(reopened);
    const title = commandTitle(FAILING);
    const { row, view } = await openView(reopened, title, 'command');
    await expect(row.locator('[data-exit-code]')).toHaveCount(0);
    await expect(view.getByText('输出', { exact: true })).toHaveCount(1);
    await expect(view.getByText('错误输出', { exact: true })).toHaveCount(0);
    const output = view.locator('[data-tool-result]');
    await expect(output).toHaveCount(1);
    await expect(output).toContainText('stdout:');
    await expect(output).toContainText('kept');
    await expect(output).toContainText('went wrong');
    await expect(output).toContainText('exit code: 1');
  });
});
