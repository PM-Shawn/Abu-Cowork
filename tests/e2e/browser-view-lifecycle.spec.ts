/**
 * Real Electron + real native browser view coverage for the two journeys PR-C
 * (feat/browser-runtime-correctness-c) exists to fix:
 *
 *   1. Run a browser task in conversation A, switch to conversation B, then
 *      switch back to A — the native view must survive (same tab id, same
 *      page), stay invisible to B the whole time, and its URL must not
 *      regress to `about:blank`.
 *   2. Collapse the right panel while a browser task is live, then expand it
 *      again — same survival contract, no conversation switch involved.
 *
 * Both are blind spots today: on unpatched `dev` the adopted tab either gets
 * reassigned to whichever conversation is on screen, or its native view is
 * torn down and rebuilt as a blank tab. These specs fail on `dev` and pass on
 * this branch.
 *
 * Mirrors tests/e2e/tool-approval.spec.ts's conventions: a loopback-only
 * OpenAI-compatible SSE mock (no real credential/network endpoint), the real
 * `electron/main.cjs` entry point via Playwright's `_electron`, and
 * `nativeBrowserViewStates()` as ground truth for the actual native
 * WebContentsView (not just the React tab strip).
 *
 * The one addition over tool-approval.spec.ts: `abu-browser__navigate` needs
 * a `tabId` obtained from the PRECEDING `abu-browser__get_tabs` tool result,
 * and that id (a live Electron `webContents.id`) is not known until runtime.
 * `MockReplyPlanEntry` therefore allows a reply to be a function of the
 * request body actually received, so the second tool call can read the first
 * one's result out of the conversation history the mock server already has.
 */
import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
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
const TEST_API_KEY = 'abu-e2e-browser-lifecycle-not-a-real-secret';
const TEST_MODEL_ID = 'abu-e2e-browser-lifecycle-model';
const PROVIDER_ID = 'abu-e2e-browser-lifecycle-provider';
const LOCAL_MOCK_PROVIDER_OPTIONS = {
  apiKey: TEST_API_KEY,
  modelId: TEST_MODEL_ID,
  modelLabel: 'Abu E2E deterministic browser-lifecycle model',
  permissionMode: 'standard',
  providerId: PROVIDER_ID,
  providerName: 'Abu E2E loopback browser-lifecycle provider',
  supportsReasoning: null,
  supportsTools: true,
} as const;

interface MockRequest {
  authorization: string | undefined;
  body: unknown;
  pathname: string;
  purpose: 'compression' | 'memory' | 'task';
}

type MockReplyPlan =
  | {
      kind: 'tool-call';
      arguments: Record<string, unknown>;
      toolCallId: string;
      toolName: string;
    }
  | { kind: 'complete'; responseText: string };

/**
 * A reply may be computed from the request body the mock just received —
 * needed for the `navigate` call, whose `tabId` argument only exists once the
 * `get_tabs` result (already appended to this request's message history) is
 * on the wire.
 */
type MockReplyPlanEntry = MockReplyPlan | ((body: unknown) => MockReplyPlan);

interface OpenAiMock {
  baseUrl: string;
  close: () => Promise<void>;
  requests: MockRequest[];
}

interface OpenAiRequestMessage {
  role?: unknown;
  content?: unknown;
}

function sseChunk(delta: Record<string, unknown>, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-abu-e2e-browser-lifecycle',
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

/**
 * Background requests the agent loop fires on its own — memory extraction
 * after a turn, and context compression once a conversation grows — that are
 * unrelated to the scripted tool-call/complete sequence below. Classified the
 * same way tests/e2e/task-lifecycle.spec.ts does, by sniffing the system/user
 * prompt content each one sends, so they get an innocuous canned reply
 * instead of silently consuming a slot in `replyPlans` and desyncing every
 * request after them.
 */
function isMemoryExtractionRequest(body: unknown): boolean {
  if (!body || typeof body !== 'object' || !('messages' in body)) return false;
  const messages = (body as { messages?: unknown }).messages;
  return Array.isArray(messages) && messages.some((message) => {
    if (!message || typeof message !== 'object') return false;
    const candidate = message as { content?: unknown; role?: unknown };
    return candidate.role === 'system'
      && typeof candidate.content === 'string'
      && candidate.content.includes('你是一个记忆提取助手');
  });
}

function isCompressionRequest(body: unknown): boolean {
  if (!body || typeof body !== 'object' || !('messages' in body)) return false;
  const messages = (body as { messages?: unknown }).messages;
  return Array.isArray(messages) && messages.some((message) => {
    if (!message || typeof message !== 'object') return false;
    const content = (message as { content?: unknown }).content;
    return typeof content === 'string' && content.includes('请将以下对话内容压缩为一段简洁的摘要');
  });
}

async function startOpenAiMock(replyPlans: readonly MockReplyPlanEntry[]): Promise<OpenAiMock> {
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
      // Preserve malformed input for diagnostics without accepting it as valid.
    }

    if (req.method !== 'POST' || requestUrl.pathname !== '/v1/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unexpected local E2E mock route' }));
      return;
    }

    const purpose = isMemoryExtractionRequest(body)
      ? 'memory'
      : isCompressionRequest(body)
        ? 'compression'
        : 'task';
    requests.push({
      authorization: req.headers.authorization,
      body,
      pathname: requestUrl.pathname,
      purpose,
    });

    if (purpose === 'memory') {
      res.writeHead(200, {
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'content-type': 'text/event-stream; charset=utf-8',
      });
      res.end(completeSse('[]'));
      return;
    }
    if (purpose === 'compression') {
      res.writeHead(200, {
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'content-type': 'text/event-stream; charset=utf-8',
      });
      res.end(completeSse('Abu E2E compacted conversation summary.'));
      return;
    }

    const rawPlan = replyPlans[taskRequestCount++];
    if (!rawPlan) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unexpected extra local E2E mock request' }));
      return;
    }
    const replyPlan = typeof rawPlan === 'function' ? rawPlan(body) : rawPlan;

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
    // Numeric IPv4 spelling of 127.0.0.1, matching tool-approval.spec.ts: it
    // avoids the adapter's literal-loopback => Ollama heuristic so the real
    // SSE/tools path is used.
    baseUrl: `http://2130706433:${address.port}/v1`,
    close: () => closeServer(server, activeResponses),
    requests,
  };
}

/** The scripted tool-call/complete sequence only, excluding background memory/compression noise. */
function taskRequests(mock: OpenAiMock): MockRequest[] {
  return mock.requests.filter((request) => request.purpose === 'task');
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

/**
 * Pull the `currentTabId` a preceding `abu-browser__get_tabs` tool result put
 * into this request's message history, so a subsequent `navigate` call can
 * target the same live tab. The tool result is JSON (`JSON.stringify(data,
 * null, 2)`, see electron/browser-runtime's `formatResult`), so a small regex
 * avoids depending on the adapter's exact message-content shape.
 */
function extractCurrentTabId(body: unknown): number {
  const messages = (body as { messages?: OpenAiRequestMessage[] } | null)?.messages ?? [];
  const toolMessage = messages.find((message) =>
    message.role === 'tool'
    && typeof message.content === 'string'
    && message.content.includes('"currentTabId"')
  );
  if (!toolMessage) {
    throw new Error('Expected an abu-browser__get_tabs tool result in the request body');
  }
  const match = /"currentTabId":\s*(\d+)/.exec(String(toolMessage.content));
  if (!match) {
    throw new Error('Could not find currentTabId in the get_tabs tool result');
  }
  return Number(match[1]);
}

/** A tiny loopback HTTP fixture the agent can navigate the real browser view to. */
interface FixturePage {
  url: string;
  host: string;
  close: () => Promise<void>;
}

async function startFixturePage(marker: string): Promise<FixturePage> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><title>${marker}</title></head><body><h1>${marker}</h1></body></html>`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo | null;
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('The local fixture page did not receive a TCP port');
  }
  const url = `http://127.0.0.1:${address.port}/`;
  return {
    url,
    host: new URL(url).host,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function waitForApp(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible({ timeout: READY_TIMEOUT });
}

/** Ground truth for the real native WebContentsView the React tab strip merely reflects. */
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

/** Find our fixture's native view state, or null while it hasn't been created (yet). */
async function ourNativeViewState(
  electronApp: ElectronApplication,
  fixtureUrl: string,
): Promise<{ url: string; visible: boolean } | null> {
  const states = await nativeBrowserViewStates(electronApp);
  return states.find((state) => state.url === fixtureUrl) ?? null;
}

function browserConfirmHeading(page: Page) {
  return page.getByRole('heading', { name: /^(浏览器操作确认|Confirm browser action)$/ });
}

function browserAllowOnceButton(page: Page) {
  return page.getByRole('button', { name: /^(仅本次对话|This conversation only)$/ });
}

function showPanelToggle(page: Page) {
  return page.getByRole('button', { name: /^(显示面板|Show panel)$/i });
}

function hidePanelButton(page: Page) {
  return page.getByRole('button', { name: /^(隐藏面板|Hide panel)$/i });
}

/**
 * Whether a locator is genuinely clickable right now — actionable per
 * Playwright's own checks (visible, stable, receives pointer events at its
 * center — not just occluded by another element), without performing the
 * click. Needed because the sidebar's zero-width auto-collapsed container
 * only clips PAINT (`overflow: hidden`): the "New Task" button inside it
 * still reports a real, non-zero `getBoundingClientRect()` (Chromium doesn't
 * reflow a fixed-width child to fit a shrunk flex ancestor), so neither
 * `isVisible()` nor `boundingBox()` can tell the collapsed state apart from
 * the expanded one — only an actionability probe (which also checks hit
 * targeting at that point) catches it, the same way the click itself would.
 */
async function isReallyClickable(locator: ReturnType<Page['locator']>, timeout = 300): Promise<boolean> {
  try {
    await locator.click({ timeout, trial: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * A browser tab appearing for the first time in a conversation auto-collapses
 * the LEFT sidebar to make room (RightPanel.tsx's wide-content auto-expand
 * effect) — the sidebar's own "New Task" button and conversation list then
 * sit behind a zero-width, `overflow: hidden` container that clips them out
 * of the paint (see `isReallyClickable`). Re-expand via the always-present
 * title-bar toggle before any test step needs the sidebar (e.g. clicking a
 * past conversation); a no-op when it is already expanded (the toggle's
 * aria-label flips to "hide sidebar"). Polls briefly since the auto-collapse
 * effect can still be in flight a moment after the tab strip first shows the
 * fixture page.
 */
async function ensureSidebarExpanded(page: Page): Promise<void> {
  const showSidebar = page.getByRole('button', { name: /^(显示侧栏|Show sidebar)$/ });
  const sidebarNewTask = page.locator('[data-sidebar-action="new-task"]');
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await isReallyClickable(sidebarNewTask)) return;
    if (await showSidebar.isVisible().catch(() => false)) {
      await showSidebar.click();
    }
    await page.waitForTimeout(150);
  }
}

/**
 * Click whichever "New Task" control is actually on screen right now: the
 * sidebar's own button, or — while a wide browser tab has auto-collapsed the
 * sidebar — the title bar's icon-only copy of the same action (rendered only
 * while `sidebarCollapsed`, see WindowTitleBar.tsx `showNewTask`). Avoids a
 * race against exactly when the auto-collapse effect fires.
 */
async function clickNewTask(page: Page): Promise<void> {
  const sidebarButton = page.locator('[data-sidebar-action="new-task"]');
  if (await isReallyClickable(sidebarButton)) {
    await sidebarButton.click();
    return;
  }
  const titleBarButton = page
    .locator('button[aria-label="新建任务"], button[aria-label="New Task"]')
    .first();
  await titleBarButton.click();
}

/** The workspace tab-strip row for the tab currently titled with this fixture's host. */
function browserTabRow(page: Page, host: string) {
  return page.locator('[data-abu-workspace-tabs] [data-tab-id]', { hasText: host });
}

/**
 * `runAgentLoopDispatched` (src/core/agent/agentLoopRunner.ts) is the promise
 * `ChatInput` awaits before releasing its per-draft-key "send in flight"
 * lock, and it does not resolve until the WHOLE turn (every tool call, the
 * final answer, post-turn bookkeeping) is done — not just once the final
 * answer is visible on screen, which can render slightly earlier via the
 * streaming store update. Every "new task" send in these specs reuses the
 * SAME lock key (there is no conversation id yet), so pressing Enter right
 * after the previous turn's answer appears can still race that lock and get
 * rejected with a "still pending" toast.
 *
 * Ground truth for "did this send actually go out" is the mock server
 * receiving a new task-classified request — NOT the toast's visibility,
 * which can still read `true` for a moment after a *later* retry has already
 * succeeded (the earlier toast is merely still fading out) and would
 * otherwise cause a spurious extra retry that dispatches the message twice.
 */
async function sendComposerMessage(page: Page, mock: OpenAiMock, text: string): Promise<void> {
  const input = page.getByPlaceholder(CHAT_PLACEHOLDER);
  const before = taskRequests(mock).length;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await input.fill(text);
    await input.press('Enter');
    const attemptDeadline = Date.now() + 1_000;
    while (taskRequests(mock).length <= before && Date.now() < attemptDeadline) {
      await page.waitForTimeout(50);
    }
    if (taskRequests(mock).length > before) return;
    await page.waitForTimeout(250);
  }
  throw new Error(`Composer refused to send "${text}" after repeated retries (still pending)`);
}

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;
let mock: OpenAiMock | undefined;
let fixture: FixturePage | undefined;

test.describe.serial('Electron browser view lifecycle E2E', () => {
  test.afterEach(async () => {
    if (app) {
      await closeAbuElectron(app);
      app = undefined;
    }
    if (mock) {
      await mock.close();
      mock = undefined;
    }
    if (fixture) {
      await fixture.close();
      fixture = undefined;
    }
    if (dataRoot) {
      removeElectronDataRoot(dataRoot);
      dataRoot = undefined;
    }
  });

  test('keeps the same browser tab and page alive across a conversation switch and back', async () => {
    const responseA = `abu-e2e-lifecycle-a-complete-${randomUUID()}`;
    const responseB = `abu-e2e-lifecycle-b-complete-${randomUUID()}`;
    const getTabsCallId = `call-get-tabs-${randomUUID()}`;
    const navigateCallId = `call-navigate-${randomUUID()}`;
    fixture = await startFixturePage(`abu-e2e-lifecycle-switch-${randomUUID()}`);
    dataRoot = createElectronDataRoot();

    mock = await startOpenAiMock([
      {
        kind: 'tool-call',
        arguments: {},
        toolCallId: getTabsCallId,
        toolName: 'abu-browser__get_tabs',
      },
      (body) => ({
        kind: 'tool-call',
        arguments: { tabId: extractCurrentTabId(body), url: fixture!.url },
        toolCallId: navigateCallId,
        toolName: 'abu-browser__navigate',
      }),
      { kind: 'complete', responseText: responseA },
      { kind: 'complete', responseText: responseB },
    ]);

    const launched = await launchAbuElectron(dataRoot);
    app = launched.app;
    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForApp(page);
    await configureLocalMockProvider(page, mock.baseUrl, LOCAL_MOCK_PROVIDER_OPTIONS);

    // --- Conversation A: run a browser task that lands on the fixture page ---
    const promptA = `abu-e2e-lc-a-${randomUUID().slice(0, 8)}`;
    await sendComposerMessage(page, mock, promptA);

    await expect.poll(() => taskRequests(mock!).length, { timeout: READY_TIMEOUT }).toBe(2);
    await expect(browserConfirmHeading(page)).toBeVisible({ timeout: READY_TIMEOUT });
    await browserAllowOnceButton(page).click();

    await expect.poll(() => taskRequests(mock!).length, { timeout: READY_TIMEOUT }).toBe(3);
    await expect(page.getByText(responseA, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });

    // The tab strip shows the real page (never regressed to about:blank / the
    // "new tab" placeholder), and the native view actually loaded it.
    const tabInA = browserTabRow(page, fixture.host);
    await expect(tabInA).toHaveCount(1, { timeout: READY_TIMEOUT });
    const tabId = await tabInA.getAttribute('data-tab-id');
    expect(tabId).toBeTruthy();
    await expect.poll(
      async () => (await ourNativeViewState(app!, fixture!.url))?.visible ?? null,
      { timeout: READY_TIMEOUT },
    ).toBe(true);

    // --- Switch to a brand-new conversation B ---
    await clickNewTask(page);
    const promptB = `abu-e2e-lc-b-${randomUUID().slice(0, 8)}`;
    await sendComposerMessage(page, mock, promptB);

    await expect.poll(() => taskRequests(mock!).length, { timeout: READY_TIMEOUT }).toBe(4);
    await expect(page.getByText(responseB, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });

    // B must never see A's tab...
    await expect(browserTabRow(page, fixture.host)).toHaveCount(0);
    await expect(page.locator(`[data-abu-workspace-tabs] [data-tab-id="${tabId}"]`)).toHaveCount(0);
    // ...but the native view is still alive (hidden, not destroyed/reset) — a
    // surviving background task, not a killed one.
    await expect.poll(
      async () => (await ourNativeViewState(app!, fixture!.url))?.visible ?? null,
      { timeout: READY_TIMEOUT },
    ).toBe(false);

    // --- Switch back to A ---
    await ensureSidebarExpanded(page);
    await page.getByText(promptA, { exact: true }).click();

    const tabInAAgain = page.locator(`[data-abu-workspace-tabs] [data-tab-id="${tabId}"]`);
    await expect(tabInAAgain).toHaveCount(1, { timeout: READY_TIMEOUT });
    // Same tab id, and its title is still the fixture host — not "about:blank"
    // and not the generic "new tab" placeholder a rebuilt tab would show.
    await expect(tabInAAgain).toContainText(fixture.host);

    // The right panel may have auto-collapsed on the switch away (this
    // conversation has no workspace); reveal it if so, then confirm the SAME
    // native view resumes showing the SAME page.
    if (await showPanelToggle(page).isVisible().catch(() => false)) {
      await showPanelToggle(page).click();
    }
    await expect.poll(
      async () => (await ourNativeViewState(app!, fixture!.url))?.visible ?? null,
      { timeout: READY_TIMEOUT },
    ).toBe(true);
    // Exactly one native view ever loaded the fixture URL — the agent was
    // never handed a rebuilt tab that had to reload it.
    const finalStates = await nativeBrowserViewStates(app!);
    expect(finalStates.filter((state) => state.url === fixture!.url)).toHaveLength(1);
  });

  test('keeps the same browser tab and page alive across collapsing and expanding the right panel', async () => {
    const responseA = `abu-e2e-lifecycle-collapse-complete-${randomUUID()}`;
    const getTabsCallId = `call-get-tabs-${randomUUID()}`;
    const navigateCallId = `call-navigate-${randomUUID()}`;
    fixture = await startFixturePage(`abu-e2e-lifecycle-collapse-${randomUUID()}`);
    dataRoot = createElectronDataRoot();

    mock = await startOpenAiMock([
      {
        kind: 'tool-call',
        arguments: {},
        toolCallId: getTabsCallId,
        toolName: 'abu-browser__get_tabs',
      },
      (body) => ({
        kind: 'tool-call',
        arguments: { tabId: extractCurrentTabId(body), url: fixture!.url },
        toolCallId: navigateCallId,
        toolName: 'abu-browser__navigate',
      }),
      { kind: 'complete', responseText: responseA },
    ]);

    const launched = await launchAbuElectron(dataRoot);
    app = launched.app;
    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForApp(page);
    await configureLocalMockProvider(page, mock.baseUrl, LOCAL_MOCK_PROVIDER_OPTIONS);

    const prompt = `abu-e2e-lc-c-${randomUUID().slice(0, 8)}`;
    await sendComposerMessage(page, mock, prompt);

    await expect.poll(() => taskRequests(mock!).length, { timeout: READY_TIMEOUT }).toBe(2);
    await expect(browserConfirmHeading(page)).toBeVisible({ timeout: READY_TIMEOUT });
    await browserAllowOnceButton(page).click();

    await expect.poll(() => taskRequests(mock!).length, { timeout: READY_TIMEOUT }).toBe(3);
    await expect(page.getByText(responseA, { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });

    const tab = browserTabRow(page, fixture.host);
    await expect(tab).toHaveCount(1, { timeout: READY_TIMEOUT });
    const tabId = await tab.getAttribute('data-tab-id');
    expect(tabId).toBeTruthy();
    // Same-conversation "wide content appeared" auto-expands the panel, so
    // the view should already be on screen at this point.
    await expect.poll(
      async () => (await ourNativeViewState(app!, fixture!.url))?.visible ?? null,
      { timeout: READY_TIMEOUT },
    ).toBe(true);

    // --- Collapse the right panel ---
    await hidePanelButton(page).click();
    await expect(page.locator('[data-abu-right-panel]')).toBeHidden({ timeout: READY_TIMEOUT });
    await expect.poll(
      async () => (await ourNativeViewState(app!, fixture!.url))?.visible ?? null,
      { timeout: READY_TIMEOUT },
    ).toBe(false);
    // The tab itself is untouched while collapsed — hidden, not destroyed.
    const tabWhileCollapsed = page.locator(`[data-abu-workspace-tabs] [data-tab-id="${tabId}"]`);
    await expect(tabWhileCollapsed).toHaveCount(1);
    await expect(tabWhileCollapsed).toContainText(fixture.host);

    // --- Expand the right panel again ---
    await showPanelToggle(page).click();
    await expect(page.locator('[data-abu-right-panel]')).toBeVisible({ timeout: READY_TIMEOUT });

    const tabAfterExpand = page.locator(`[data-abu-workspace-tabs] [data-tab-id="${tabId}"]`);
    await expect(tabAfterExpand).toHaveCount(1, { timeout: READY_TIMEOUT });
    await expect(tabAfterExpand).toContainText(fixture.host);
    await expect.poll(
      async () => (await ourNativeViewState(app!, fixture!.url))?.visible ?? null,
      { timeout: READY_TIMEOUT },
    ).toBe(true);
    const finalStates = await nativeBrowserViewStates(app!);
    expect(finalStates.filter((state) => state.url === fixture!.url)).toHaveLength(1);
  });
});
