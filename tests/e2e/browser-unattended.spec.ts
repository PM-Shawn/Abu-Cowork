/**
 * The four unattended-browser journeys, end to end, in a real Electron app.
 *
 * ## Why these exist
 *
 * Every task in the "unattended browser authorization" batch has unit tests
 * pinning its own local invariant, and twice in that batch every layer was
 * green while the CHAIN was broken (U6's detectors silently missing real
 * login pages; U7's audit fields silently dropped at a whitelist boundary).
 * Nothing in the repo ran from "a scheduled task fires" all the way to "a card
 * appears in the conversation". These four specs are that witness:
 *
 *   1. master switch on + site allowed  → a scheduled run really fills a form,
 *      with NO confirmation dialog anywhere.
 *   2. an allowed origin 302s to an unauthorized one → the next action is
 *      refused as "outside the allowed sites", not as "origin unverified".
 *   3. unattended `execute_js` → refused, with provably zero JS executed.
 *   4. two refusals in a row → the run stops itself and the third browser tool
 *      call never reaches the model endpoint.
 *
 * ## Conventions (inherited from tests/e2e/browser-view-lifecycle.spec.ts)
 *
 * - A loopback-only OpenAI-compatible SSE mock (no credential, no network).
 * - The real `electron/main.cjs` entry via Playwright's `_electron`.
 * - `nativeBrowserViewStates()` / `evaluateInNativeView()` as GROUND TRUTH for
 *   the actual native WebContentsView — never the React tab strip, which can
 *   look right while the page underneath is wrong.
 * - `MockReplyPlanEntry` may be a function of the request body, because
 *   `navigate` needs a `tabId` that only exists once the preceding `get_tabs`
 *   result is on the wire.
 *
 * ## Conventions specific to this file
 *
 * - The run is driven the way `tests/e2e/infra-hygiene.spec.ts` drives one:
 *   a `frequency: 'manual'` scheduled task seeded into `abu-schedule`, fired
 *   with "Run Now". No cron, no wall clock.
 * - Every fixture page is a local loopback server started per test, so an
 *   "origin" in these specs is a real origin (scheme + host + PORT) and two
 *   fixtures on two ports are genuinely two sites.
 * - `watchConfirmDialogTitles()` records every dialog heading that appears
 *   from seeding until the assertion, so "no dialog ever appeared" is a
 *   positive observation over the whole run rather than a spot check at the
 *   end.
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
const TEST_API_KEY = 'abu-e2e-browser-unattended-not-a-real-secret';
const TEST_MODEL_ID = 'abu-e2e-browser-unattended-model';
const PROVIDER_ID = 'abu-e2e-browser-unattended-provider';

/**
 * MUST equal the settingsStore's current persisted `version`
 * (`src/stores/settingsStore.ts`, registered in
 * `src/stores/storeVersions.test.ts` as `abu-settings` minVersion). Writing a
 * lower number makes zustand run the migration chain over our injected state
 * on the next reload — and v46's own branch rewrites exactly the three fields
 * these specs inject (`allowUnattendedBrowser`, `browserOperationPolicy`).
 */
const SETTINGS_STORE_VERSION = 46;
/** Same rule for `abu-schedule` (storeVersions.test.ts minVersion 5). */
const SCHEDULE_STORE_VERSION = 5;

const LOCAL_MOCK_PROVIDER_OPTIONS = {
  apiKey: TEST_API_KEY,
  modelId: TEST_MODEL_ID,
  modelLabel: 'Abu E2E deterministic unattended-browser model',
  permissionMode: 'standard',
  providerId: PROVIDER_ID,
  providerName: 'Abu E2E loopback unattended-browser provider',
  supportsReasoning: null,
  supportsTools: true,
} as const;

// ─────────────────────────────────────────────────────────────────────────
// Loopback OpenAI-compatible mock
// ─────────────────────────────────────────────────────────────────────────

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

type MockReplyPlanEntry = MockReplyPlan | ((body: unknown) => MockReplyPlan);

interface OpenAiMock {
  baseUrl: string;
  close: () => Promise<void>;
  requests: MockRequest[];
  /** How many entries of `replyPlans` were actually consumed. A plan entry
   *  that is never consumed proves the run stopped before asking for it. */
  consumedPlans: () => number;
}

interface OpenAiRequestMessage {
  role?: unknown;
  content?: unknown;
  tool_call_id?: unknown;
  tool_calls?: Array<{
    id?: unknown;
    function?: { name?: unknown; arguments?: unknown };
  }>;
}

function sseChunk(delta: Record<string, unknown>, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-abu-e2e-browser-unattended',
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

/** Background requests the agent loop fires on its own — classified so they
 *  never consume a slot in `replyPlans` and desync everything after them. */
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

    if (purpose === 'memory' || purpose === 'compression') {
      res.writeHead(200, {
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'content-type': 'text/event-stream; charset=utf-8',
      });
      res.end(completeSse(purpose === 'memory' ? '[]' : 'Abu E2E compacted conversation summary.'));
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
    // Numeric IPv4 spelling of 127.0.0.1: it avoids the adapter's
    // literal-loopback ⇒ Ollama heuristic, so the real SSE/tools path is used.
    baseUrl: `http://2130706433:${address.port}/v1`,
    close: () => closeServer(server, activeResponses),
    requests,
    consumedPlans: () => taskRequestCount,
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

/** The scripted sequence only, excluding background memory/compression noise. */
function taskRequests(mock: OpenAiMock): MockRequest[] {
  return mock.requests.filter((request) => request.purpose === 'task');
}

/**
 * The `currentTabId` a preceding `abu-browser__get_tabs` put into this
 * request's message history. The tool result is JSON, so a small regex avoids
 * depending on the adapter's exact message-content shape.
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
  if (!match) throw new Error('Could not find currentTabId in the get_tabs tool result');
  return Number(match[1]);
}

/** The tool result the host/gate produced for one tool call, read out of the
 *  NEXT request the mock received. This is what the MODEL was told. */
function toolResultFor(body: unknown, toolName: string): string {
  const messages = (body as { messages?: OpenAiRequestMessage[] } | null)?.messages ?? [];
  const call = messages
    .filter((message) => message.role === 'assistant' && Array.isArray(message.tool_calls))
    .flatMap((message) => message.tool_calls ?? [])
    .find((entry) => entry.function?.name === toolName);
  expect(call, `no ${toolName} tool call in the request body`).toBeDefined();
  const resultMessage = messages.find((message) =>
    message.role === 'tool' && message.tool_call_id === call?.id
  );
  expect(resultMessage, `no tool result for ${toolName}`).toBeDefined();
  return String(resultMessage?.content ?? '');
}

// ─────────────────────────────────────────────────────────────────────────
// Loopback fixture pages
// ─────────────────────────────────────────────────────────────────────────

interface FixturePage {
  url: string;
  origin: string;
  host: string;
  close: () => Promise<void>;
}

async function listenLoopback(server: Server): Promise<FixturePage> {
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
    origin: new URL(url).origin,
    host: new URL(url).host,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

/**
 * A form page with two witnesses the harness can read back out of the LIVE
 * document afterwards:
 *  - `#field` — what a `fill` actually wrote (journey ①).
 *  - `window.__abuE2eScriptSentinel` — untouched unless page script ran
 *    (journey ③). Set by the page itself, so any change to it can only come
 *    from code injected AFTER load.
 *  - `document.body.dataset.clicked` — set by the page's own click handler, so
 *    it distinguishes "the click really landed" from "the tool returned ok".
 */
function formFixtureHtml(marker: string): string {
  return `<!doctype html><html><head><title>${marker}</title></head><body>
<h1>${marker}</h1>
<form id="form" onsubmit="return false">
  <input id="field" name="field" type="text" value="" />
  <button id="submit" type="button">Submit</button>
</form>
<script>
  window.__abuE2eScriptSentinel = 'untouched';
  document.getElementById('submit').addEventListener('click', function () {
    document.body.setAttribute('data-clicked', 'yes');
  });
</script>
</body></html>`;
}

async function startFormFixture(marker: string): Promise<FixturePage> {
  return listenLoopback(createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(formFixtureHtml(marker));
  }));
}

/**
 * A page that answers every request with a real HTTP 302 to another origin.
 * Used for journey ②: the origin the gate approved for `navigate` is NOT the
 * origin the tab ends up on.
 */
async function startRedirectFixture(target: () => string): Promise<FixturePage> {
  return listenLoopback(createServer((_req, res) => {
    res.writeHead(302, { location: target(), 'content-type': 'text/plain; charset=utf-8' });
    res.end('redirecting');
  }));
}

// ─────────────────────────────────────────────────────────────────────────
// Native WebContentsView ground truth
// ─────────────────────────────────────────────────────────────────────────

async function nativeBrowserViewStates(
  electronApp: ElectronApplication,
): Promise<Array<{ url: string; visible: boolean }>> {
  return electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window || window.isDestroyed()) return [];
    return window.contentView.children.flatMap((child) => {
      const candidate = child as unknown as {
        getVisible?: () => boolean;
        webContents?: { getURL: () => string; isDestroyed: () => boolean };
      };
      if (
        typeof candidate.getVisible !== 'function'
        || !candidate.webContents
        || candidate.webContents.isDestroyed()
      ) {
        return [];
      }
      return [{ url: candidate.webContents.getURL(), visible: candidate.getVisible() }];
    });
  });
}

/**
 * Run an expression inside the live document of whichever native view is on
 * `url`, and return its value. Returns `undefined` when no view is there.
 *
 * This is the harness reading the page — NOT the agent scripting it. Journey
 * ③'s whole point is that the agent's `execute_js` never ran; this read is how
 * we find out.
 */
async function evaluateInNativeView(
  electronApp: ElectronApplication,
  url: string,
  expression: string,
): Promise<unknown> {
  return electronApp.evaluate(async ({ BrowserWindow }, payload) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window || window.isDestroyed()) return undefined;
    for (const child of window.contentView.children) {
      const contents = (child as unknown as {
        webContents?: {
          getURL: () => string;
          isDestroyed: () => boolean;
          executeJavaScript: (code: string) => Promise<unknown>;
        };
      }).webContents;
      if (!contents || contents.isDestroyed() || contents.getURL() !== payload.url) continue;
      return await contents.executeJavaScript(payload.expression);
    }
    return undefined;
  }, { url, expression });
}

// ─────────────────────────────────────────────────────────────────────────
// Renderer helpers
// ─────────────────────────────────────────────────────────────────────────

async function waitForApp(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible({ timeout: READY_TIMEOUT });
}

/** Every confirmation-dialog title (`CommandConfirmDialog`'s `<h2>`) that the
 *  browser/command/self-extension confirmation dialogs use. */
const CONFIRM_DIALOG_TITLES = [
  '浏览器操作确认', 'Confirm browser action',       // commandConfirm.browserTitle
  '新增能力确认', 'Confirm new capability',          // commandConfirm.selfExtensionTitle
  '操作确认', 'Confirm Action',                      // commandConfirm.title
  '危险操作确认', 'Dangerous Action',                // commandConfirm.titleDanger
  '操作已阻止', 'Action Blocked',                    // commandConfirm.titleBlock
];

/**
 * Start recording every `<h2>` that appears from now on. Survives until the
 * next page reload, so it must be installed AFTER the last seeding reload and
 * BEFORE the run is fired. A spot check at the end could not see a dialog that
 * appeared and was dismissed; this can.
 */
async function watchConfirmDialogTitles(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __abuE2eDialogTitles?: string[] };
    const seen: string[] = [];
    w.__abuE2eDialogTitles = seen;
    const record = (element: Element): void => {
      const text = (element.textContent ?? '').trim();
      if (text) seen.push(text);
    };
    const scan = (root: Element): void => {
      if (root.tagName === 'H2') record(root);
      for (const heading of root.querySelectorAll('h2')) record(heading);
    };
    scan(document.body);
    new MutationObserver((records) => {
      for (const record_ of records) {
        for (const node of record_.addedNodes) {
          if (node.nodeType === 1) scan(node as Element);
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
}

async function seenDialogTitles(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __abuE2eDialogTitles?: string[] };
    if (!w.__abuE2eDialogTitles) throw new Error('the dialog watcher was not installed (or the page reloaded)');
    return [...w.__abuE2eDialogTitles];
  });
}

async function expectNoConfirmationDialogEverAppeared(page: Page): Promise<void> {
  const titles = await seenDialogTitles(page);
  expect(
    titles.filter((title) => CONFIRM_DIALOG_TITLES.includes(title)),
    `a confirmation dialog appeared during an unattended run (headings seen: ${JSON.stringify(titles)})`,
  ).toEqual([]);
}

type BrowserOperationState = 'allow' | 'deny' | 'ask';

interface UnattendedSeed {
  allowUnattendedBrowser: boolean;
  sitePermissions: Record<string, 'allowed' | 'denied'>;
  /** Overrides on top of the shipped unattended defaults
   *  (readOnly allow / interactive allow / scripting deny). */
  unattendedPolicy?: Partial<Record<'readOnly' | 'interactive' | 'scripting', BrowserOperationState>>;
  scheduleId: string;
  scheduleName: string;
  prompt: string;
}

/**
 * Inject the unattended settings and the manual scheduled task in ONE write,
 * then reload once. Runs AFTER `configureLocalMockProvider` (which writes its
 * own settings snapshot and reloads), so this is the last writer.
 */
async function seedUnattendedRun(page: Page, seed: UnattendedSeed): Promise<void> {
  await page.evaluate((payload) => {
    const raw = window.localStorage.getItem('abu-settings');
    if (!raw) throw new Error('abu-settings was not initialized before seeding the unattended run');
    const persisted = JSON.parse(raw) as { state: Record<string, unknown>; version: number };
    Object.assign(persisted.state, {
      allowUnattendedBrowser: payload.allowUnattendedBrowser,
      browserSitePermissions: payload.sitePermissions,
      browserOperationPolicy: {
        attended: { readOnly: 'allow', interactive: 'allow', scripting: 'ask' },
        unattended: {
          readOnly: 'allow',
          interactive: 'allow',
          scripting: 'deny',
          ...payload.unattendedPolicy,
        },
      },
      activeAutomationTab: 'schedule',
      viewMode: 'automation',
    });
    window.localStorage.setItem('abu-settings', JSON.stringify({
      ...persisted,
      state: persisted.state,
      version: payload.settingsVersion,
    }));

    window.localStorage.setItem('abu-schedule', JSON.stringify({
      state: {
        tasks: {
          [payload.scheduleId]: {
            id: payload.scheduleId,
            name: payload.scheduleName,
            prompt: payload.prompt,
            schedule: { frequency: 'manual' },
            status: 'active',
            createdAt: 1_800_000_000_000,
            updatedAt: 1_800_000_000_000,
            runs: [],
            totalRuns: 0,
          },
        },
      },
      version: payload.scheduleVersion,
    }));
  }, {
    allowUnattendedBrowser: seed.allowUnattendedBrowser,
    prompt: seed.prompt,
    scheduleId: seed.scheduleId,
    scheduleName: seed.scheduleName,
    scheduleVersion: SCHEDULE_STORE_VERSION,
    settingsVersion: SETTINGS_STORE_VERSION,
    sitePermissions: seed.sitePermissions,
    unattendedPolicy: seed.unattendedPolicy ?? {},
  });
  await page.reload();
  await waitForApp(page);
}

async function openScheduledTask(page: Page, taskName: string): Promise<void> {
  await page
    .getByRole('navigation', { name: /^(Main navigation|主导航)$/ })
    .getByRole('button', { name: /^(自动化|Automation)$/ })
    .evaluate((element: HTMLElement) => element.click());
  const tab = page.getByRole('button', { name: /^(定时任务|Scheduled Tasks)$/ });
  await expect(tab).toBeVisible({ timeout: READY_TIMEOUT });
  await tab.click();
  const item = page.getByText(taskName, { exact: true });
  if (!await item.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await page.locator('.border-b').getByRole('button').first().click();
  }
  await expect(item).toBeVisible({ timeout: READY_TIMEOUT });
  await item.click();
}

async function runScheduledTaskNow(page: Page, taskName: string): Promise<void> {
  await openScheduledTask(page, taskName);
  await page.getByRole('button', { name: /^(立即执行|Run Now)$/ }).click();
}

/** Open the conversation the scheduled run created, where the report card lives. */
async function openScheduledRunConversation(page: Page, taskName: string): Promise<void> {
  await openScheduledTask(page, taskName);
  const viewConversation = page.getByTitle(/^(查看会话|View Conversation)$/).first();
  await expect(viewConversation).toBeVisible({ timeout: READY_TIMEOUT });
  await viewConversation.click();
}

// ─────────────────────────────────────────────────────────────────────────
// Report card locators (BrowserRunReportCard.tsx renders a <section
// aria-label={t.browserRunReport.title}> ⇒ role "region")
// ─────────────────────────────────────────────────────────────────────────

const REPORT_CARD_TITLE = /^(浏览器任务报告|Browser task report)$/;
const OUTCOME_COMPLETED = /^(已完成|Completed)$/;
const OUTCOME_ABORTED_DENIALS = /^(连续被拒后已终止|Stopped after repeated refusals)$/;
const NEXT_STEPS_TITLE = /^(接下来可以做什么|What you can do next)$/;
const DENIED_TITLE = /^(被拦下的动作|Blocked actions)$/;
const REASON_SITE_NOT_ALLOWED = /^(该站点没有你的常驻授权|No standing grant for this site)$/;
const REASON_POLICY_DENIED = /^(这类操作被你设为拒绝|You set this class of action to deny)$/;
const REASON_APPROVAL_REFUSED = /^(审批被拒绝或没等到回复|The approval was declined or never answered)$/;
const STEP_ALLOW_SITE = /始终允许此站点|always allow this site/;
const STEP_RELAX_POLICY = /浏览器操作权限 把对应档位改掉|change its setting in Settings/;
const STEP_ANSWER_APPROVAL = /审批请求发到了你的 IM|An approval was sent to your IM/;
const DENIED_ABORT_MESSAGE = /你连续拒绝了我的浏览器操作|You declined my browser actions several times in a row/;

function reportCard(page: Page) {
  return page.getByRole('region', { name: REPORT_CARD_TITLE });
}

async function waitForReportCard(page: Page) {
  const card = reportCard(page);
  await expect(card).toBeVisible({ timeout: READY_TIMEOUT });
  return card;
}

// ─────────────────────────────────────────────────────────────────────────

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;
let mock: OpenAiMock | undefined;
const fixtures: FixturePage[] = [];

async function launchConfiguredApp(baseUrl: string): Promise<Page> {
  dataRoot = createElectronDataRoot();
  const launched = await launchAbuElectron(dataRoot);
  app = launched.app;
  const page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(page);
  await configureLocalMockProvider(page, baseUrl, LOCAL_MOCK_PROVIDER_OPTIONS);
  return page;
}

test.describe.serial('Electron unattended browser authorization E2E', () => {
  test.afterEach(async () => {
    if (app) {
      await closeAbuElectron(app);
      app = undefined;
    }
    if (mock) {
      await mock.close();
      mock = undefined;
    }
    while (fixtures.length > 0) await fixtures.pop()!.close();
    if (dataRoot) {
      removeElectronDataRoot(dataRoot);
      dataRoot = undefined;
    }
  });

  // ① master switch on + site allowed ⇒ the scheduled run really fills the form
  test('runs a scheduled browser form fill unattended, with no confirmation dialog anywhere', async () => {
    const marker = `abu-e2e-unattended-form-${randomUUID().slice(0, 8)}`;
    const fixture = await startFormFixture(marker);
    fixtures.push(fixture);
    const filledValue = `abu-e2e-filled-${randomUUID().slice(0, 8)}`;
    const finalAnswer = `abu-e2e-unattended-done-${randomUUID()}`;

    mock = await startOpenAiMock([
      { kind: 'tool-call', arguments: {}, toolCallId: `call-tabs-${randomUUID()}`, toolName: 'abu-browser__get_tabs' },
      (body) => ({
        kind: 'tool-call',
        arguments: { tabId: extractCurrentTabId(body), url: fixture.url },
        toolCallId: `call-nav-${randomUUID()}`,
        toolName: 'abu-browser__navigate',
      }),
      (body) => ({
        kind: 'tool-call',
        arguments: {
          tabId: extractCurrentTabId(body),
          locator: JSON.stringify({ css: '#field' }),
          value: filledValue,
        },
        toolCallId: `call-fill-${randomUUID()}`,
        toolName: 'abu-browser__fill',
      }),
      (body) => ({
        kind: 'tool-call',
        arguments: { tabId: extractCurrentTabId(body), locator: JSON.stringify({ css: '#submit' }) },
        toolCallId: `call-click-${randomUUID()}`,
        toolName: 'abu-browser__click',
      }),
      { kind: 'complete', responseText: finalAnswer },
    ]);

    const page = await launchConfiguredApp(mock.baseUrl);
    const taskName = `U8 fill ${randomUUID().slice(0, 8)}`;
    await seedUnattendedRun(page, {
      allowUnattendedBrowser: true,
      sitePermissions: { [fixture.origin]: 'allowed' },
      scheduleId: `schedule-u8-fill-${randomUUID()}`,
      scheduleName: taskName,
      prompt: `fill the form at ${fixture.url}`,
    });
    await watchConfirmDialogTitles(page);
    await runScheduledTaskNow(page, taskName);

    // All five scripted turns land — nothing blocked on a dialog nobody could answer.
    await expect.poll(() => taskRequests(mock!).length, { timeout: READY_TIMEOUT }).toBe(5);

    // GROUND TRUTH: the native view is really on the fixture page, and the
    // form value the model asked for is really IN that live document.
    await expect.poll(
      async () => (await nativeBrowserViewStates(app!)).some((state) => state.url === fixture.url),
      { timeout: READY_TIMEOUT },
    ).toBe(true);
    await expect.poll(
      () => evaluateInNativeView(app!, fixture.url, 'document.getElementById("field").value'),
      { timeout: READY_TIMEOUT },
    ).toBe(filledValue);
    // ...and the click really landed on the page's own handler.
    await expect.poll(
      () => evaluateInNativeView(app!, fixture.url, 'document.body.getAttribute("data-clicked")'),
      { timeout: READY_TIMEOUT },
    ).toBe('yes');

    await expectNoConfirmationDialogEverAppeared(page);

    await openScheduledRunConversation(page, taskName);
    const card = await waitForReportCard(page);
    await expect(card.getByText(OUTCOME_COMPLETED)).toBeVisible();
    await expect(card.getByText(fixture.origin, { exact: true })).toBeVisible();
    // A clean run has nothing to advise — the "what you can do next" section
    // exists only for refusals and failing terminals.
    await expect(card.getByText(NEXT_STEPS_TITLE)).toHaveCount(0);
    await expect(card.getByText(DENIED_TITLE)).toHaveCount(0);

    await expectNoConfirmationDialogEverAppeared(page);
  });

  // ② an allowed origin 302s to an unauthorized one ⇒ fail-closed, reason is
  //   "outside the allowed sites", NOT "origin unverified"
  test('fails closed when an allowed origin redirects to an unauthorized one', async () => {
    const destination = await startFormFixture(`abu-e2e-unattended-redirect-target-${randomUUID().slice(0, 8)}`);
    fixtures.push(destination);
    const entry = await startRedirectFixture(() => destination.url);
    fixtures.push(entry);
    // Two loopback servers on two ports ⇒ two genuinely different origins.
    expect(entry.origin).not.toBe(destination.origin);
    const finalAnswer = `abu-e2e-redirect-done-${randomUUID()}`;

    mock = await startOpenAiMock([
      { kind: 'tool-call', arguments: {}, toolCallId: `call-tabs-${randomUUID()}`, toolName: 'abu-browser__get_tabs' },
      (body) => ({
        kind: 'tool-call',
        arguments: { tabId: extractCurrentTabId(body), url: entry.url },
        toolCallId: `call-nav-${randomUUID()}`,
        toolName: 'abu-browser__navigate',
      }),
      (body) => ({
        kind: 'tool-call',
        arguments: { tabId: extractCurrentTabId(body), locator: JSON.stringify({ css: '#submit' }) },
        toolCallId: `call-click-${randomUUID()}`,
        toolName: 'abu-browser__click',
      }),
      { kind: 'complete', responseText: finalAnswer },
    ]);

    const page = await launchConfiguredApp(mock.baseUrl);
    const taskName = `U8 redirect ${randomUUID().slice(0, 8)}`;
    await seedUnattendedRun(page, {
      allowUnattendedBrowser: true,
      // ONLY the entry origin is authorized. The 302 destination is not.
      sitePermissions: { [entry.origin]: 'allowed' },
      scheduleId: `schedule-u8-redirect-${randomUUID()}`,
      scheduleName: taskName,
      prompt: `open ${entry.url} and submit`,
    });
    await watchConfirmDialogTitles(page);
    await runScheduledTaskNow(page, taskName);

    await expect.poll(() => taskRequests(mock!).length, { timeout: READY_TIMEOUT }).toBe(4);

    // The tab really followed the 302 onto the unauthorized origin...
    await expect.poll(
      async () => (await nativeBrowserViewStates(app!)).some((state) => state.url === destination.url),
      { timeout: READY_TIMEOUT },
    ).toBe(true);
    // ...and the click was refused for the RIGHT reason: outside the allowed
    // site set, not "we could not tell which site this is". Those two failure
    // modes look the same from the outside and mean opposite things about
    // whether the gate is working.
    const clickResult = toolResultFor(taskRequests(mock!)[3]!.body, 'abu-browser__click');
    expect(clickResult).toMatch(
      /无人值守运行只能在你已明确允许的网站上操作|may only act on sites you explicitly allowed/,
    );
    expect(clickResult).not.toMatch(
      /无法确认这次操作所在的网站|The site this action targets could not be determined/,
    );

    // No click side effect on the page the tab actually landed on.
    expect(
      await evaluateInNativeView(app!, destination.url, 'document.body.getAttribute("data-clicked")'),
    ).toBeNull();

    await expectNoConfirmationDialogEverAppeared(page);

    await openScheduledRunConversation(page, taskName);
    const card = await waitForReportCard(page);
    await expect(card.getByText(DENIED_TITLE)).toBeVisible();
    await expect(card.getByText(REASON_SITE_NOT_ALLOWED)).toBeVisible();
    // The refused origin is named, as plain text.
    await expect(card.getByText(destination.origin, { exact: true })).toBeVisible();
    // ...and the card tells the user what to do about it.
    await expect(card.getByText(NEXT_STEPS_TITLE)).toBeVisible();
    await expect(card.getByText(STEP_ALLOW_SITE)).toBeVisible();
  });

  // ③ unattended execute_js ⇒ refused, with provably zero JS executed
  test('refuses unattended execute_js and runs no page script at all', async () => {
    const marker = `abu-e2e-unattended-script-${randomUUID().slice(0, 8)}`;
    const fixture = await startFormFixture(marker);
    fixtures.push(fixture);
    const finalAnswer = `abu-e2e-script-denied-${randomUUID()}`;

    mock = await startOpenAiMock([
      { kind: 'tool-call', arguments: {}, toolCallId: `call-tabs-${randomUUID()}`, toolName: 'abu-browser__get_tabs' },
      (body) => ({
        kind: 'tool-call',
        arguments: { tabId: extractCurrentTabId(body), url: fixture.url },
        toolCallId: `call-nav-${randomUUID()}`,
        toolName: 'abu-browser__navigate',
      }),
      (body) => ({
        kind: 'tool-call',
        arguments: {
          tabId: extractCurrentTabId(body),
          // If ANY of this ran, the sentinel below would no longer read
          // 'untouched'.
          code: 'window.__abuE2eScriptSentinel = "EXECUTED"; document.title = "EXECUTED"; "ok"',
        },
        toolCallId: `call-js-${randomUUID()}`,
        toolName: 'abu-browser__execute_js',
      }),
      { kind: 'complete', responseText: finalAnswer },
    ]);

    const page = await launchConfiguredApp(mock.baseUrl);
    const taskName = `U8 script ${randomUUID().slice(0, 8)}`;
    await seedUnattendedRun(page, {
      allowUnattendedBrowser: true,
      // The site is explicitly ALLOWED — a site grant is minted from approving
      // a click and must never be able to authorize page scripting.
      sitePermissions: { [fixture.origin]: 'allowed' },
      scheduleId: `schedule-u8-script-${randomUUID()}`,
      scheduleName: taskName,
      prompt: `read ${fixture.url}`,
    });
    await watchConfirmDialogTitles(page);
    await runScheduledTaskNow(page, taskName);

    await expect.poll(() => taskRequests(mock!).length, { timeout: READY_TIMEOUT }).toBe(4);

    const scriptResult = toolResultFor(taskRequests(mock!)[3]!.body, 'abu-browser__execute_js');
    expect(scriptResult).toMatch(/^Error:/);
    expect(scriptResult).toMatch(/not permitted by the unattended browser policy/);

    // ZERO EXECUTION, read out of the live document: the page's own sentinel
    // and title are exactly what the page shipped with.
    expect(
      await evaluateInNativeView(app!, fixture.url, 'window.__abuE2eScriptSentinel'),
    ).toBe('untouched');
    expect(await evaluateInNativeView(app!, fixture.url, 'document.title')).toBe(marker);

    // An unattended refusal must never fall back to a dialog nobody can answer.
    await expectNoConfirmationDialogEverAppeared(page);

    await openScheduledRunConversation(page, taskName);
    const card = await waitForReportCard(page);
    await expect(card.getByText(DENIED_TITLE)).toBeVisible();
    await expect(card.getByText(REASON_POLICY_DENIED)).toBeVisible();
    // Exactly one blocked action.
    await expect(card.getByText(/^(1 次|1×)$/)).toHaveCount(1);
    await expect(card.getByText(NEXT_STEPS_TITLE)).toBeVisible();
    await expect(card.getByText(STEP_RELAX_POLICY)).toBeVisible();
  });

  /**
   * ④ two refusals in a row ⇒ the run stops itself, and the model is never
   * asked for a third browser action.
   *
   * DEVIATION from the task brief's literal script (`navigate → click →
   * click`), forced by the product's own — correct — semantics, NOT worked
   * around: with `unattended.interactive = 'ask'` and no IM channel, the
   * FIRST `navigate` is already refused, so nothing ever leaves the blank
   * automation tab. A `click` on that tab resolves NO origin, and the gate
   * refuses it as `origin-unverified`, which is standing-configuration shaped
   * and deliberately does NOT count toward the consecutive-denial guard
   * (browserDenialTracker.ts's doc). So a `click` can never be the second
   * COUNTED refusal in this configuration.
   *
   * Repeating `navigate` keeps every element the journey is about: the same
   * `interactive: 'ask'` policy, the same "an ask nobody can answer IS a
   * refusal" ruling, a resolvable origin (navigate reads it from its own
   * input, not from the tab), and two counted refusals in a row.
   */
  test('stops the run after two consecutive refusals and never requests the third action', async () => {
    const fixture = await startFormFixture(`abu-e2e-unattended-abort-${randomUUID().slice(0, 8)}`);
    fixtures.push(fixture);
    const neverReached = `abu-e2e-never-reached-${randomUUID()}`;
    const navigatePlan = (body: unknown): MockReplyPlan => ({
      kind: 'tool-call',
      arguments: { tabId: extractCurrentTabId(body), url: fixture.url },
      toolCallId: `call-nav-${randomUUID()}`,
      toolName: 'abu-browser__navigate',
    });

    mock = await startOpenAiMock([
      { kind: 'tool-call', arguments: {}, toolCallId: `call-tabs-${randomUUID()}`, toolName: 'abu-browser__get_tabs' },
      navigatePlan,
      navigatePlan,
      // Plan entries 4 and 5 must NEVER be consumed: the run aborts itself
      // after the second refusal.
      navigatePlan,
      { kind: 'complete', responseText: neverReached },
    ]);

    const page = await launchConfiguredApp(mock.baseUrl);
    const taskName = `U8 abort ${randomUUID().slice(0, 8)}`;
    await seedUnattendedRun(page, {
      allowUnattendedBrowser: true,
      sitePermissions: { [fixture.origin]: 'allowed' },
      // 'ask' with no IM binding is the U4 ruling's case: an ask nobody can
      // answer IS a refusal, so it counts toward the consecutive-denial guard.
      unattendedPolicy: { interactive: 'ask' },
      scheduleId: `schedule-u8-abort-${randomUUID()}`,
      scheduleName: taskName,
      prompt: `open ${fixture.url} and submit`,
    });
    await watchConfirmDialogTitles(page);
    await runScheduledTaskNow(page, taskName);

    // get_tabs, navigate (refusal 1), navigate (refusal 2) — then the guard trips.
    await expect.poll(() => taskRequests(mock!).length, { timeout: READY_TIMEOUT }).toBe(3);

    const navigateResult = toolResultFor(taskRequests(mock!)[2]!.body, 'abu-browser__navigate');
    expect(navigateResult).toMatch(/^Error:/);
    expect(navigateResult).toMatch(/没有绑定可回复的 IM 频道|bound to no IM chat/);

    await openScheduledRunConversation(page, taskName);
    // The closing message the guard appends, in the run's own conversation.
    await expect(page.getByText(DENIED_ABORT_MESSAGE)).toBeVisible({ timeout: READY_TIMEOUT });

    const card = await waitForReportCard(page);
    await expect(card.getByText(OUTCOME_ABORTED_DENIALS)).toBeVisible();
    await expect(card.getByText(REASON_APPROVAL_REFUSED)).toBeVisible();
    await expect(card.getByText(fixture.origin, { exact: true })).toBeVisible();
    await expect(card.getByText(NEXT_STEPS_TITLE)).toBeVisible();
    await expect(card.getByText(STEP_ANSWER_APPROVAL)).toBeVisible();

    // THE assertion this journey exists for: the fourth plan entry (the second
    // click) was never asked for, so the model never got a chance to keep
    // pushing. Checked after the whole card has rendered, i.e. well past the
    // point where a late turn could still have gone out.
    expect(taskRequests(mock!).length).toBe(3);
    expect(mock!.consumedPlans()).toBe(3);
    await expect(page.getByText(neverReached, { exact: true })).toHaveCount(0);

    await expectNoConfirmationDialogEverAppeared(page);
  });
});
