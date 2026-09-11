/**
 * The unattended-browser journeys, end to end, in a real Electron app.
 *
 * ## Why these exist
 *
 * Every task in the "unattended browser authorization" batch has unit tests
 * pinning its own local invariant, and twice in that batch every layer was
 * green while the CHAIN was broken (U6's detectors silently missing real
 * login pages; U7's audit fields silently dropped at a whitelist boundary).
 * Nothing in the repo ran from "a scheduled task fires" all the way to "a card
 * appears in the conversation". These specs are that witness:
 *
 *   1. master switch on + site allowed  → a scheduled run really fills a form,
 *      with NO confirmation dialog anywhere.
 *   2. an allowed origin 302s to an unauthorized one → the next action is
 *      refused as "outside the allowed sites", not as "origin unverified",
 *      and the card is badged "completed with blocked actions", not "done".
 *   3. unattended `execute_js` → refused, with provably zero JS executed, and
 *      the same refusal badge on the card.
 *   4. two refusals in a row → the run stops itself and the third browser tool
 *      call never reaches the model endpoint.
 *   5. an OVERDUE task caught up by the scheduler's own start-up tick — no
 *      "Run Now", nobody at the keyboard → the tool roster frozen for that run
 *      carries the browser tools, so its first browser call is answered by the
 *      browser and not refused by the ceiling (issue #389).
 *   6. a form living in embedded regions → a same-origin region is covered by
 *      the page's grant (single fill and multi-region batch both land in the
 *      live child document); a cross-origin one the user never authorized is
 *      refused, and the built-in browser says it cannot reach inside it.
 *
 * ## Conventions (inherited from tests/e2e/browser-view-lifecycle.spec.ts)
 *
 * - A loopback-only OpenAI-compatible SSE mock (no credential, no network).
 * - The real `electron/main.cjs` entry via Playwright's `_electron`.
 * - `nativeBrowserViewStates()` / `evaluateInNativeView()` as GROUND TRUTH for
 *   the actual native WebContentsView — never the React tab strip, which can
 *   look right while the page underneath is wrong.
 * - `MockReplyPlanEntry` may be an ASYNC function of the request body, because
 *   a turn that acts on a page can only be synthesized once the previous tool
 *   really finished.
 *
 * ## The fixture rule this file exists under (issue #362)
 *
 * **A scripted turn reads what happened from the TOOL RESULT and from the live
 * host — never from whatever text the request body happens to carry.**
 *
 * Concretely, every turn that acts on a page:
 *   1. calls `lastSuccessfulToolResult(body, <the tool it follows>)`, which
 *      matches by `tool_call_id` and refuses to script anything on top of a
 *      tool that came back `Error:`; and
 *   2. takes its `tabId` from `currentTab()` / `tabOn()`, which resolve it out
 *      of the run's own `get_tabs` result and/or the live `WebContentsView` —
 *      simultaneously the "the navigation (302 chain included) landed" gate
 *      and the "the bundled browser runtime is up" gate.
 *
 * Before that rule, turns quoted a `tabId` back out of the FIRST `get_tabs`
 * result in the history and fired immediately: journeys ① and ③b filled a
 * stale-but-still-valid tab, ② clicked before the 302 landed and read
 * `origin-unverified` where it asserts "outside the allowed sites", and ③a
 * read the same thing where it asserts `no_binding`. All four are load
 * races in the HARNESS, and all four are fail-closed — which is exactly why
 * they had to go: a slow machine and a broken gate were producing the same
 * red. Anything added here must keep both properties: no sleeps, and no
 * assertion about WHY something was refused before the run has reached the
 * state that refusal is about.
 *
 * ## Conventions specific to this file
 *
 * - The run is driven the way `tests/e2e/infra-hygiene.spec.ts` drives one:
 *   a `frequency: 'manual'` scheduled task seeded into `abu-schedule`, fired
 *   with "Run Now". No cron, no wall clock. Journey ⑤ is the one exception:
 *   it seeds a `daily` task whose `lastRunAt` is years stale, so the store's
 *   own cold-start catch-up marks it due on rehydrate and the scheduler's
 *   start-up tick fires it. Still no wall clock — the missed slot is in 2023
 *   whatever today is (see `UnattendedFiring`).
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
import { persistedStoreVersion } from './storeVersions';

const READY_TIMEOUT = 45_000;
const CHAT_PLACEHOLDER = '想让阿布帮你做点什么？';
const TEST_API_KEY = 'abu-e2e-browser-unattended-not-a-real-secret';
const TEST_MODEL_ID = 'abu-e2e-browser-unattended-model';
const PROVIDER_ID = 'abu-e2e-browser-unattended-provider';

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

/**
 * A scripted turn. The function form is ASYNC on purpose: a turn that acts on
 * a page may only be synthesized once the PREVIOUS tool actually finished —
 * see `waitForNativeTab`. Anything a plan needs to know about the run's tabs
 * it reads from the live host, never from a `get_tabs` transcript that may
 * already be stale.
 */
type MockReplyPlanEntry =
  | MockReplyPlan
  | ((body: unknown) => MockReplyPlan | Promise<MockReplyPlan>);

interface OpenAiMock {
  baseUrl: string;
  close: () => Promise<void>;
  requests: MockRequest[];
  /** How many entries of `replyPlans` were actually consumed. A plan entry
   *  that is never consumed proves the run stopped before asking for it. */
  consumedPlans: () => number;
  /**
   * Why the mock could not script a turn (the preceding tool failed, or the
   * tab it was supposed to act on never appeared). Surfaced by
   * `waitForTaskTurns` so the run's own diagnosis is what fails the test,
   * instead of a bare "expected 4 requests, got 2" forty-five seconds later.
   */
  planFailure: () => string | undefined;
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
  let planFailure: string | undefined;
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
    let replyPlan: MockReplyPlan;
    try {
      // A plan may await the previous tool's real effect (see
      // `waitForNativeTab`), so this is the one place the mock blocks. The
      // agent is simply waiting on its own HTTP response meanwhile.
      replyPlan = typeof rawPlan === 'function' ? await rawPlan(body) : rawPlan;
    } catch (error) {
      // Record it and answer, rather than leaving the request hanging: an
      // unanswered SSE response turns a precise "navigate came back Error: …"
      // into an opaque poll timeout.
      planFailure ??= error instanceof Error ? error.message : String(error);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: planFailure }));
      return;
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
    // Numeric IPv4 spelling of 127.0.0.1: it avoids the adapter's
    // literal-loopback ⇒ Ollama heuristic, so the real SSE/tools path is used.
    baseUrl: `http://2130706433:${address.port}/v1`,
    close: () => closeServer(server, activeResponses),
    requests,
    consumedPlans: () => taskRequestCount,
    planFailure: () => planFailure,
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
 * Wait for the run to reach its `count`-th scripted turn, and assert it
 * stopped exactly there.
 *
 * Replaces a bare `expect.poll(...).toBe(count)` so that a turn the mock
 * could not script (a tool that came back `Error:`, a tab that never
 * appeared) fails IMMEDIATELY with that diagnosis instead of timing out
 * forty-five seconds later on a request count.
 */
async function waitForTaskTurns(mock: OpenAiMock, count: number): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT;
  for (;;) {
    const failure = mock.planFailure();
    if (failure) throw new Error(`the mock could not script the next turn — ${failure}`);
    if (taskRequests(mock).length >= count) break;
    if (Date.now() >= deadline) {
      throw new Error(
        `only ${taskRequests(mock).length} of ${count} scripted turns arrived within ${READY_TIMEOUT}ms`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(taskRequests(mock).length).toBe(count);
}

/**
 * Every tool call the model has made in this conversation, paired with the
 * result the host handed back, matched by `tool_call_id` and in call order.
 *
 * Matching by id rather than by "the first tool message that looks right" is
 * the point: journey ④ calls `navigate` twice, and journeys ①/③ have several
 * tool results carrying a tabId. A by-shape search silently answers with the
 * OLDEST of them, which is exactly how a stale tab identity used to get
 * baked into the next turn.
 */
function toolExchanges(body: unknown): Array<{ id: string; name: string; result?: string }> {
  const messages = (body as { messages?: OpenAiRequestMessage[] } | null)?.messages ?? [];
  const results = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'tool' || typeof message.tool_call_id !== 'string') continue;
    results.set(message.tool_call_id, String(message.content ?? ''));
  }
  return messages
    .filter((message) => message.role === 'assistant' && Array.isArray(message.tool_calls))
    .flatMap((message) => message.tool_calls ?? [])
    .flatMap((call) => {
      const id = typeof call.id === 'string' ? call.id : null;
      const name = typeof call.function?.name === 'string' ? call.function.name : null;
      if (id === null || name === null) return [];
      const result = results.get(id);
      return [result === undefined ? { id, name } : { id, name, result }];
    });
}

/**
 * The result of the model's MOST RECENT tool call — what the run was actually
 * told about the action it just took, as opposed to what the harness hoped
 * happened. Throws (naming the tool it found instead, and the result it read)
 * rather than returning something plausible, so a desynced plan says so on
 * the turn it desynced.
 */
function lastToolResult(body: unknown, expectedToolName: string): string {
  const exchanges = toolExchanges(body);
  const last = exchanges[exchanges.length - 1];
  if (!last) {
    throw new Error(
      `expected the run to have called ${expectedToolName}, but the request body carries no tool call at all`,
    );
  }
  if (last.name !== expectedToolName) {
    throw new Error(
      `expected ${expectedToolName} to be the run's last tool call, but it was ${last.name}`,
    );
  }
  if (last.result === undefined) {
    throw new Error(`${expectedToolName} has no tool result in the request body yet`);
  }
  return last.result;
}

/** The most recent result for `toolName` anywhere in the history, or
 *  `undefined` if that tool has not answered yet. */
function latestResultFor(body: unknown, toolName: string): string | undefined {
  const calls = toolExchanges(body).filter((entry) => entry.name === toolName);
  return calls[calls.length - 1]?.result;
}

/** As `lastToolResult`, and refuses to script another turn on top of a tool
 *  the host refused or could not run. A `navigate` that failed under load and
 *  a real regression produce the same red otherwise. */
function lastSuccessfulToolResult(body: unknown, expectedToolName: string): string {
  const result = lastToolResult(body, expectedToolName);
  if (/^Error:/.test(result)) {
    throw new Error(`${expectedToolName} did not succeed: ${result.slice(0, 400)}`);
  }
  return result;
}

/** The tool result the host/gate produced for one tool call, read out of the
 *  NEXT request the mock received. This is what the MODEL was told. The LAST
 *  call wins, so journey ④'s repeated `navigate` reports its second refusal
 *  rather than its first. */
function toolResultFor(body: unknown, toolName: string): string {
  const calls = toolExchanges(body).filter((entry) => entry.name === toolName);
  const call = calls[calls.length - 1];
  expect(call, `no ${toolName} tool call in the request body`).toBeDefined();
  expect(call?.result, `no tool result for ${toolName}`).toBeDefined();
  return String(call?.result ?? '');
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
 * A page whose form lives in EMBEDDED REGIONS — the ordinary shape of an
 * OA/ERP screen, and the shape T4 exists for.
 *
 * Two regions, on purpose:
 *  - `#same` loads `/inner` from THIS server, so it is the same site as the
 *    page and covered by the page's own grant;
 *  - `#vendor` loads a page from a SECOND loopback server, which is genuinely
 *    a different origin (different port ⇒ different site) and therefore has to
 *    be authorized on its own account.
 *
 * `#innerField` is the witness: the harness reads it back out of the LIVE
 * child document afterwards, which is the only way to tell "the fill landed in
 * the region" apart from "the tool returned ok".
 */
async function startFrameHostFixture(marker: string, vendorUrl: string): Promise<FixturePage> {
  return listenLoopback(createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if ((req.url ?? '/').startsWith('/inner')) {
      res.end(`<!doctype html><html><head><title>${marker} inner</title></head><body>
<input id="innerField" name="innerField" type="text" value="" />
</body></html>`);
      return;
    }
    res.end(`<!doctype html><html><head><title>${marker}</title></head><body>
<h1>${marker}</h1>
<input id="outerField" type="text" value="" />
<iframe id="same" src="/inner" width="300" height="120"></iframe>
<iframe id="vendor" src="${vendorUrl}" width="300" height="120"></iframe>
</body></html>`);
  }));
}

/**
 * A page hosting TWO same-origin regions, for the multi-region `batch` journey.
 *
 * Its own fixture rather than a third iframe on `startFrameHostFixture`: that
 * one's regions are addressed by a `/inner` substring, and a second path
 * starting the same way would make the existing journeys pick by luck.
 */
async function startTwoRegionHostFixture(marker: string): Promise<FixturePage> {
  return listenLoopback(createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    const url = req.url ?? '/';
    if (url.startsWith('/regionA') || url.startsWith('/regionB')) {
      const which = url.startsWith('/regionA') ? 'A' : 'B';
      res.end(`<!doctype html><html><head><title>${marker} ${which}</title></head><body>
<input id="field${which}" name="field${which}" type="text" value="" />
</body></html>`);
      return;
    }
    res.end(`<!doctype html><html><head><title>${marker}</title></head><body>
<h1>${marker}</h1>
<iframe id="a" src="/regionA" width="300" height="120"></iframe>
<iframe id="b" src="/regionB" width="300" height="120"></iframe>
</body></html>`);
  }));
}

/**
 * The handle of the region whose address contains `needle`, read out of the
 * snapshot result the model was just given.
 *
 * The handles are minted at runtime and are opaque by design, so the only
 * honest way to name one in a scripted turn is the same way a model would:
 * read it from the `frames` list the previous tool call returned.
 */
function extractFrameId(body: unknown, needle: string): string {
  const snapshot = JSON.parse(toolResultFor(body, 'abu-browser__snapshot')) as {
    frames?: Array<{ frameId?: string; url?: string }>;
  };
  const region = (snapshot.frames ?? []).find((frame) => String(frame.url ?? '').includes(needle));
  if (!region?.frameId) {
    throw new Error(`snapshot listed no region matching ${needle}: ${JSON.stringify(snapshot.frames)}`);
  }
  return region.frameId;
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

interface NativeTabState {
  /** `webContents.id` — the SAME number the host reports as `tabId`
   *  (browserHost.cjs's `automationTabs` builds it from `contents.id`), so
   *  this is a tab identity the browser tools accept verbatim. */
  tabId: number;
  url: string;
  visible: boolean;
}

async function nativeBrowserViewStates(
  electronApp: ElectronApplication,
): Promise<NativeTabState[]> {
  return electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window || window.isDestroyed()) return [];
    // The app's own renderer is not a browser tab. Excluding it by id keeps
    // "the run's only automation tab" an honest question to ask.
    const rendererId = window.webContents.id;
    return window.contentView.children.flatMap((child) => {
      const candidate = child as unknown as {
        getVisible?: () => boolean;
        webContents?: { id: number; getURL: () => string; isDestroyed: () => boolean };
      };
      if (
        typeof candidate.getVisible !== 'function'
        || !candidate.webContents
        || candidate.webContents.isDestroyed()
        || candidate.webContents.id === rendererId
      ) {
        return [];
      }
      return [{
        tabId: candidate.webContents.id,
        url: candidate.webContents.getURL(),
        visible: candidate.getVisible(),
      }];
    });
  });
}

/** How long a scripted turn will wait for the previous tool's real effect. */
const TAB_SETTLE_TIMEOUT = 30_000;

/**
 * Wait until the run has a live automation tab matching `matches`, and answer
 * with it. THE fixture's only source of tab identity and of "the previous
 * navigation finished".
 *
 * ## Why not the `get_tabs` transcript
 *
 * A `tabId` copied out of the first `get_tabs` result is a number the model
 * was told once. Between then and the next action the host may have replaced
 * the view underneath it — `createAutomationView` waits a bounded 2.5s for the
 * renderer to adopt the tab and builds its own if that wait loses, which on a
 * loaded machine it sometimes does. Filling "the tab id from the transcript"
 * then writes into a tab that is still perfectly valid and no longer the one
 * the run is on. Reading the LIVE view instead removes the whole class.
 *
 * ## Why it doubles as the readiness gate
 *
 * No automation view exists until a `get_tabs` really reached the browser
 * runtime. Waiting for one is therefore also the answer to "is the bundled
 * browser MCP server up yet" — with no sleep, no poll count, and no separate
 * probe that could drift from what the tools actually see.
 */
async function waitForNativeTab(
  electronApp: ElectronApplication,
  matches: (tab: NativeTabState) => boolean,
  describeWanted: string,
): Promise<NativeTabState> {
  const deadline = Date.now() + TAB_SETTLE_TIMEOUT;
  for (;;) {
    const seen = await nativeBrowserViewStates(electronApp);
    const found = seen.find(matches);
    if (found) return found;
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out waiting for ${describeWanted}; the run's live tabs were ${JSON.stringify(seen)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** The tab the run is on once `url` has finished loading THERE — the
 *  determinate "the navigation (302 chain included) landed" signal journeys
 *  ② and ③ need before they may act on the page. */
function tabOn(electronApp: ElectronApplication, url: string): Promise<NativeTabState> {
  return waitForNativeTab(electronApp, (tab) => tab.url === url, `a live tab on ${url}`);
}

/**
 * The tab the run is on before anything has navigated: the one its own
 * `get_tabs` named as current, **read out of that call's result** and then
 * confirmed to be a live native view before it is handed to another tool.
 *
 * Both halves are load-bearing.
 *  - Reading the id from the tool RESULT (matched by `tool_call_id`, most
 *    recent call wins) is what makes it the run's answer rather than the
 *    harness's guess.
 *  - Confirming it against the live views is what catches the id going stale:
 *    `createAutomationView` may emit a view for the renderer to adopt, give up
 *    after a bounded 2.5s, and build its own — so on a loaded machine there can
 *    be a second, perfectly valid `WebContentsView` that is not the run's tab.
 *
 * A `get_tabs` that never produced a listing fails here too, which is the
 * readiness gate: no listing means the bundled browser runtime was not up when
 * the run asked, and every assertion after this point would be about that
 * rather than about authorization.
 */
async function currentTab(
  electronApp: ElectronApplication,
  body: unknown,
): Promise<NativeTabState> {
  const listing = latestResultFor(body, 'abu-browser__get_tabs');
  if (listing === undefined) {
    throw new Error('the run never got a get_tabs result to take a tab identity from');
  }
  if (/^Error:/.test(listing)) {
    throw new Error(
      `get_tabs did not return a tab listing — is the bundled browser runtime up? ${listing.slice(0, 400)}`,
    );
  }
  const match = /"currentTabId":\s*(\d+)/.exec(listing);
  if (!match) {
    throw new Error(`get_tabs named no current tab: ${listing.slice(0, 400)}`);
  }
  const tabId = Number(match[1]);
  return waitForNativeTab(
    electronApp,
    (tab) => tab.tabId === tabId,
    `the live automation tab ${tabId} that get_tabs named as current`,
  );
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

/**
 * The same read, but inside an EMBEDDED REGION of that view.
 *
 * A cross-origin region cannot be reached from the host page's own scripts —
 * that is precisely what makes it a different site — so the harness goes
 * around the outside, through the main process's own frame tree
 * (`webContents.mainFrame.framesInSubtree`). This is the test looking at the
 * page from privileged code, never the agent reaching content it was refused.
 */
async function evaluateInNativeViewFrame(
  electronApp: ElectronApplication,
  viewUrl: string,
  frameUrlPrefix: string,
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
          mainFrame: { framesInSubtree: Array<{ url: string; executeJavaScript: (code: string) => Promise<unknown> }> };
        };
      }).webContents;
      if (!contents || contents.isDestroyed() || contents.getURL() !== payload.viewUrl) continue;
      for (const frame of contents.mainFrame.framesInSubtree) {
        if (!frame.url.startsWith(payload.frameUrlPrefix)) continue;
        return await frame.executeJavaScript(payload.expression);
      }
    }
    return undefined;
  }, { viewUrl, frameUrlPrefix, expression });
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
 * The upload confirmation's heading is composed, not fixed — 「上传 2 个文件到
 * oa.example.com」 (acceptance F5) — so it cannot sit in the exact-match list
 * above. It still has to be caught: a guard that says "no dialog appeared"
 * while the one dialog that sends files off the machine slipped past it would
 * be worse than no guard.
 */
const CONFIRM_DIALOG_TITLE_PATTERNS = [/^上传 \d+ 个文件到 /, /^Upload \d+ files? to /];

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
    titles.filter((title) => (
      CONFIRM_DIALOG_TITLES.includes(title)
      || CONFIRM_DIALOG_TITLE_PATTERNS.some((pattern) => pattern.test(title))
    )),
    `a confirmation dialog appeared during an unattended run (headings seen: ${JSON.stringify(titles)})`,
  ).toEqual([]);
}

type BrowserOperationState = 'allow' | 'deny' | 'ask';

/**
 * How the seeded task gets fired.
 *
 * - `run-now` (default): a `frequency: 'manual'` task the journey fires by
 *   clicking "Run Now" once it has finished setting the app up.
 * - `overdue-at-start`: a `daily` task whose `lastRunAt` is years stale.
 *   `applyCatchupOnRehydrate` (src/stores/scheduleStore.ts) turns that into
 *   `nextRunAt = now` the moment the store rehydrates from the seed, and
 *   `schedulerEngine.start()`'s immediate tick fires it — by itself, during
 *   the reload, before any harness code gets to act on the page. This is the
 *   9am task of a laptop that was shut through 9am: the path of issue #389.
 */
type UnattendedFiring = 'run-now' | 'overdue-at-start';

/**
 * The last run of an `overdue-at-start` task: 2023-11-14T22:13:20Z. The daily
 * slot after it is 2023-11-15 09:00 local, which is in the past in every
 * time zone on every day this suite can run, so the catch-up is decided by
 * the seed alone and never by the clock.
 */
const OVERDUE_LAST_RUN_AT = 1_700_000_000_000;

interface UnattendedSeed {
  allowUnattendedBrowser: boolean;
  sitePermissions: Record<string, 'allowed' | 'denied'>;
  /** Overrides on top of the shipped operation policy
   *  (readOnly allow / interactive allow / scripting ask). ONE row per class
   *  since the 2026-09-04 collapse — the run mode no longer picks a column. */
  operationPolicy?: Partial<Record<'readOnly' | 'interactive' | 'scripting', BrowserOperationState>>;
  scheduleId: string;
  scheduleName: string;
  prompt: string;
  /** Defaults to `run-now`. */
  firing?: UnattendedFiring;
}

/**
 * Inject the unattended settings and the scheduled task in ONE write, then
 * reload once. Runs AFTER `configureLocalMockProvider` (which writes its own
 * settings snapshot and reloads), so this is the last writer.
 *
 * For an `overdue-at-start` seed that reload IS the app start under test:
 * by the time this returns, the scheduler's start-up tick has already
 * dispatched the task.
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
        readOnly: 'allow',
        interactive: 'allow',
        scripting: 'ask',
        ...payload.operationPolicy,
      },
      activeAutomationTab: 'schedule',
      viewMode: 'automation',
    });
    // Version untouched: the app wrote this entry at the store's current
    // version, so carrying it through is both correct and drift-proof. A
    // literal here would make zustand replay the migration chain over the
    // fields we just injected — and the v46/v47 branches rewrite exactly
    // `allowUnattendedBrowser` / `browserOperationPolicy`.
    window.localStorage.setItem('abu-settings', JSON.stringify(persisted));

    const overdue = payload.firing === 'overdue-at-start';
    window.localStorage.setItem('abu-schedule', JSON.stringify({
      state: {
        tasks: {
          [payload.scheduleId]: {
            id: payload.scheduleId,
            name: payload.scheduleName,
            prompt: payload.prompt,
            schedule: overdue
              ? { frequency: 'daily', time: { hour: 9, minute: 0 } }
              : { frequency: 'manual' },
            status: 'active',
            createdAt: overdue ? payload.overdueLastRunAt : 1_800_000_000_000,
            updatedAt: overdue ? payload.overdueLastRunAt : 1_800_000_000_000,
            // `lastRunAt` is the ONLY field the catch-up reads. `nextRunAt`
            // is recomputed from it on every rehydrate, so a seed that only
            // back-dated nextRunAt would be silently reset to the next 09:00.
            ...(overdue ? { lastRunAt: payload.overdueLastRunAt } : {}),
            runs: [],
            totalRuns: overdue ? 1 : 0,
          },
        },
      },
      version: payload.scheduleVersion,
    }));
  }, {
    allowUnattendedBrowser: seed.allowUnattendedBrowser,
    firing: seed.firing ?? 'run-now',
    overdueLastRunAt: OVERDUE_LAST_RUN_AT,
    prompt: seed.prompt,
    scheduleId: seed.scheduleId,
    scheduleName: seed.scheduleName,
    scheduleVersion: persistedStoreVersion('abu-schedule'),
    sitePermissions: seed.sitePermissions,
    operationPolicy: seed.operationPolicy ?? {},
  });
  await page.reload();
  await waitForApp(page);
}

interface PersistedScheduledTask {
  totalRuns: number;
  nextRunAt?: number;
  runs: Array<{ status: string; completedAt?: number; error?: string }>;
}

/** The seeded task as the schedule store last persisted it — the run history
 *  behind the task page, read from the store rather than from the page. */
function persistedScheduledTask(
  page: Page,
  scheduleId: string,
): Promise<PersistedScheduledTask | undefined> {
  return page.evaluate((id) => {
    const raw = window.localStorage.getItem('abu-schedule');
    if (!raw) return undefined;
    const persisted = JSON.parse(raw) as { state: { tasks: Record<string, PersistedScheduledTask> } };
    return persisted.state.tasks[id];
  }, scheduleId);
}

/** Settings › Capabilities, and the built-in browser row's accessible name —
 *  `<capability> · <status>`, so the badge is part of the name (see
 *  `ChannelCard` in CapabilitiesSection.tsx, and tests/e2e/capabilities.spec.ts
 *  which pins this same row). */
const ACCOUNT_MENU = /^(我|Me)$/;
const SETTINGS_MENU_ITEM = /^(设置|Settings)$/;
const CAPABILITIES_TAB = /^(能力|Capabilities)$/;
const BROWSER_CARD_READY = /^(阿布内置浏览器|Abu built-in browser) · (已就绪|Ready)$/;
/** `SystemSettingsDialog`'s own close affordance. Addressed by its data
 *  attribute rather than by the localized `aria-label`, so the readiness gate
 *  cannot start failing because a translation moved. */
const SETTINGS_DIALOG = '[data-abu-settings-dialog]';
const SETTINGS_DIALOG_CLOSE = '[data-abu-settings-close]';

/**
 * Do not fire "Run Now" until the bundled browser runtime is really connected.
 *
 * ## What this is, since #394
 *
 * `scheduler.runNow` freezes the run's tool roster at dispatch
 * (`buildScheduledRunPermissionCeiling(getToolInvoker().getAllTools())`), and
 * the bundled browser MCP server (`abu-browser`) connects asynchronously after
 * each renderer load — which `seedUnattendedRun` does. Before #394 a click
 * that won that race had EVERY browser tool of the run refused with
 * `is not allowed for this agent run`, for the whole run: this file's single
 * largest source of flake (10/10 reds under load, issue #362) and, as it
 * turned out, a product bug for any overdue task at app start (issue #389).
 * #394 fixed the product: the scheduler now waits up to
 * `BUILTIN_BROWSER_READY_TIMEOUT_MS` (15s) for the built-in runtime before
 * taking the snapshot. Journey ⑤ is the witness for that wait and fires with
 * no gate at all — never add this call there.
 *
 * ## Why journeys ①–④ still gate (evaluated 2026-09-06, not assumed)
 *
 * Measured on an 8-core macOS box with the fix in place: `abu-browser`
 * connects 100–300ms after its connect starts, idle and under four busy-loop
 * CPU hogs alike; this gate reports ready on its first attempt (0.3–0.9s);
 * journey ① with the gate deleted was 3/3 green under that load. So here the
 * gate is not needed for correctness. It stays because these four journeys
 * are about AUTHORIZATION, and the product's 15s budget is a fact about the
 * runtime, not about the gate under test: a runner slow enough to connect in
 * more than 15s would turn all four red with a refusal that reads like a
 * broken gate, whereas this loop gives them `READY_TIMEOUT` (45s) and, if
 * even that runs out, a message naming the runtime. Journey ⑤ carries that
 * 15s exposure alone, so a slow runner shows as one red journey with an
 * explicit cause instead of five. Remove this once a measured target runner
 * shows the 15s budget holds there too; until then it costs about a second
 * per journey.
 *
 * ## Why it re-opens the page instead of waiting on a live locator
 *
 * The badge comes from `mcpManager.isConnected('abu-browser')` read at RENDER
 * time (`readCapabilityRuntimeSnapshot`), and nothing re-renders the section
 * when that flips — `mcpStore` never gets an `abu-browser` entry to change.
 * So each attempt leaves the tab and comes back, which remounts the section
 * and re-reads the live manager. No sleeps, and the thing being polled is the
 * app's own answer to "is the browser ready", not a proxy for it.
 */
async function waitForBuiltinBrowserRuntime(page: Page): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT;
  for (;;) {
    await page.getByRole('button', { name: ACCOUNT_MENU }).click();
    await page.getByRole('menuitem', { name: SETTINGS_MENU_ITEM }).click();
    const capabilitiesTab = page.getByRole('button', { name: CAPABILITIES_TAB });
    await expect(capabilitiesTab).toBeVisible({ timeout: READY_TIMEOUT });
    await capabilitiesTab.click();
    const ready = await page
      .getByRole('button', { name: BROWSER_CARD_READY })
      .waitFor({ state: 'visible', timeout: 2_000 })
      .then(() => true, () => false);
    // Always leave the app as it was found: the dialog is an overlay, and the
    // automation navigation the journey drives next is behind its scrim.
    // Closing is also what remounts the section for the next attempt.
    await page.locator(SETTINGS_DIALOG_CLOSE).click();
    await expect(page.locator(SETTINGS_DIALOG)).toHaveCount(0);
    if (ready) return;
    if (Date.now() >= deadline) {
      throw new Error(
        'the bundled browser runtime never reported ready in Settings › Capabilities, '
        + 'so a scheduled run would have frozen a tool roster without any browser tool in it',
      );
    }
  }
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
/**
 * The outcome badge. Every pattern is ANCHORED, which is what lets a spec
 * assert that a run did NOT get the plain success badge: without `^…$`,
 * `已完成` also matches `已完成，但有操作被拒` and the negative assertion would
 * be vacuous.
 *
 * `OUTCOME_COMPLETED_WITH_REFUSALS` is the badge a run gets when it reached a
 * delivering terminal but the gate refused a state-changing action — journeys
 * ② and ③ both end that way, and both used to show the green "completed"
 * badge over their own blocked-actions section.
 */
const OUTCOME_COMPLETED = /^(已完成|Completed)$/;
const OUTCOME_COMPLETED_WITH_REFUSALS = /^(已完成，但有操作被拒|Completed with blocked actions)$/;
const OUTCOME_ABORTED_DENIALS = /^(连续被拒后已终止|Stopped after repeated refusals)$/;
const NEXT_STEPS_TITLE = /^(接下来可以做什么|What you can do next)$/;
const DENIED_TITLE = /^(被拦下的动作|Blocked actions)$/;
const REASON_SITE_NOT_ALLOWED = /^(该站点没有你的常驻授权|No standing grant for this site)$/;
const REASON_POLICY_DENIED = /^(这类操作被你设为拒绝|You set this class of action to deny)$/;
/** The script-run line (2026-09-04 opt-in). Anchored and count-specific, so a
 *  card reporting a DIFFERENT number of scripts fails instead of matching. */
const SCRIPT_RUNS_ONE = /^(在页面里运行了 1 次脚本|Page scripts run: 1)$/;
const REASON_APPROVAL_REFUSED = /^(审批被拒绝或没等到回复|The approval was declined or never answered)$/;
const STEP_ALLOW_SITE = /始终允许此站点|always allow this site/;
const STEP_RELAX_POLICY = /操作权限 把对应档位改掉|change its setting in Settings/;
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
      async (body) => {
        lastSuccessfulToolResult(body, 'abu-browser__get_tabs');
        return {
          kind: 'tool-call',
          arguments: { tabId: (await currentTab(app!, body)).tabId, url: fixture.url },
          toolCallId: `call-nav-${randomUUID()}`,
          toolName: 'abu-browser__navigate',
        };
      },
      async (body) => {
        // The fill may only be scripted once `navigate` really landed the run
        // on the fixture page — and onto the tab it landed on, not the one an
        // older listing named.
        lastSuccessfulToolResult(body, 'abu-browser__navigate');
        return {
          kind: 'tool-call',
          arguments: {
            tabId: (await tabOn(app!, fixture.url)).tabId,
            locator: JSON.stringify({ css: '#field' }),
            value: filledValue,
          },
          toolCallId: `call-fill-${randomUUID()}`,
          toolName: 'abu-browser__fill',
        };
      },
      async (body) => {
        lastSuccessfulToolResult(body, 'abu-browser__fill');
        return {
          kind: 'tool-call',
          arguments: {
            tabId: (await tabOn(app!, fixture.url)).tabId,
            locator: JSON.stringify({ css: '#submit' }),
          },
          toolCallId: `call-click-${randomUUID()}`,
          toolName: 'abu-browser__click',
        };
      },
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
    await waitForBuiltinBrowserRuntime(page);
    await watchConfirmDialogTitles(page);
    await runScheduledTaskNow(page, taskName);

    // All five scripted turns land — nothing blocked on a dialog nobody could answer.
    await waitForTaskTurns(mock, 5);

    // Every browser tool the run made really RAN. Without this a `navigate`
    // that failed under load and a broken gate produce the same red, and the
    // page assertions below have to carry a diagnosis they cannot give.
    for (const [index, toolName] of ([
      [2, 'abu-browser__navigate'],
      [3, 'abu-browser__fill'],
      [4, 'abu-browser__click'],
    ] as const)) {
      expect(
        toolResultFor(taskRequests(mock!)[index]!.body, toolName),
        `${toolName} was refused or failed in an unattended run that should have been allowed`,
      ).not.toMatch(/^Error:/);
    }

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
      async (body) => {
        lastSuccessfulToolResult(body, 'abu-browser__get_tabs');
        return {
          kind: 'tool-call',
          arguments: { tabId: (await currentTab(app!, body)).tabId, url: entry.url },
          toolCallId: `call-nav-${randomUUID()}`,
          toolName: 'abu-browser__navigate',
        };
      },
      async (body) => {
        lastSuccessfulToolResult(body, 'abu-browser__navigate');
        // THE gate this journey turns on: the click may only be scripted once
        // the 302 has actually landed the tab on the unauthorized origin.
        // Click before that and the gate resolves no origin at all, refuses as
        // `origin-unverified`, and the spec reads a fail-closed harness race
        // as a fail-closed product — the two say opposite things about whether
        // the site check works.
        return {
          kind: 'tool-call',
          arguments: {
            tabId: (await tabOn(app!, destination.url)).tabId,
            locator: JSON.stringify({ css: '#submit' }),
          },
          toolCallId: `call-click-${randomUUID()}`,
          toolName: 'abu-browser__click',
        };
      },
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
    await waitForBuiltinBrowserRuntime(page);
    await watchConfirmDialogTitles(page);
    await runScheduledTaskNow(page, taskName);

    await waitForTaskTurns(mock, 4);

    // The tab really followed the 302 onto the unauthorized origin. (The
    // scripted click already waited for exactly this, so a failure here means
    // the tab moved BACK — it is not the load-bearing wait.)
    expect(
      (await nativeBrowserViewStates(app!)).some((state) => state.url === destination.url),
    ).toBe(true);
    const clickResult = toolResultFor(taskRequests(mock!)[3]!.body, 'abu-browser__click');
    // Asserted BEFORE the positive match, so the two failure modes never trade
    // places in the report: "we could not tell which site this is" and
    // "outside the allowed site set" look the same from the outside and mean
    // opposite things about whether the gate is working.
    expect(
      clickResult,
      'the gate could not resolve the origin of a page the run had already landed on',
    ).not.toMatch(
      /无法确认这次操作所在的网站|The site this action targets could not be determined/,
    );
    expect(clickResult).toMatch(
      /无人值守运行只能在你已明确允许的网站上操作|may only act on sites you explicitly allowed/,
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
    // The BADGE, not only the section under it. The run reached `completed`
    // (the model produced a final answer), but the only thing it was asked to
    // change was refused — a green "done" stamp on that is the silent false
    // success this card exists to prevent.
    await expect(card.getByText(OUTCOME_COMPLETED_WITH_REFUSALS)).toBeVisible();
    await expect(card.getByText(OUTCOME_COMPLETED)).toHaveCount(0);
  });

  // ③a shipped default (scripting 「每次询问」, no IM channel bound) ⇒
  //    execute_js refused, provably zero JS executed. ③b below is the same
  //    journey with the user having set that row to 「允许」.
  test('refuses unattended execute_js and runs no page script at all', async () => {
    const marker = `abu-e2e-unattended-script-${randomUUID().slice(0, 8)}`;
    const fixture = await startFormFixture(marker);
    fixtures.push(fixture);
    const finalAnswer = `abu-e2e-script-denied-${randomUUID()}`;

    mock = await startOpenAiMock([
      { kind: 'tool-call', arguments: {}, toolCallId: `call-tabs-${randomUUID()}`, toolName: 'abu-browser__get_tabs' },
      async (body) => {
        lastSuccessfulToolResult(body, 'abu-browser__get_tabs');
        return {
          kind: 'tool-call',
          arguments: { tabId: (await currentTab(app!, body)).tabId, url: fixture.url },
          toolCallId: `call-nav-${randomUUID()}`,
          toolName: 'abu-browser__navigate',
        };
      },
      async (body) => {
        lastSuccessfulToolResult(body, 'abu-browser__navigate');
        // Scripted only once the page is really there: this journey is about
        // what the APPROVAL SEAM does with a script on a site the gate can
        // name, so it must not be run against a tab whose origin the gate
        // cannot resolve yet.
        return {
          kind: 'tool-call',
          arguments: {
            tabId: (await tabOn(app!, fixture.url)).tabId,
            // If ANY of this ran, the sentinel below would no longer read
            // 'untouched'.
            code: 'window.__abuE2eScriptSentinel = "EXECUTED"; document.title = "EXECUTED"; "ok"',
          },
          toolCallId: `call-js-${randomUUID()}`,
          toolName: 'abu-browser__execute_js',
        };
      },
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
    await waitForBuiltinBrowserRuntime(page);
    await watchConfirmDialogTitles(page);
    await runScheduledTaskNow(page, taskName);

    await waitForTaskTurns(mock, 4);

    const scriptResult = toolResultFor(taskRequests(mock!)[3]!.body, 'abu-browser__execute_js');
    expect(scriptResult).toMatch(/^Error:/);
    // The site is CONFIRMED first. `origin-unverified` short-circuits the gate
    // before the approval seam is ever consulted, so asserting `no_binding`
    // over it would be asserting a refusal this journey is not about.
    expect(
      scriptResult,
      'the gate could not resolve the origin of the page the run had navigated to',
    ).not.toMatch(
      /无法确认这次操作所在的网站|The site this action targets could not be determined/,
    );
    /*
      The refusal now comes from the APPROVAL SEAM rather than from the policy
      row: since the 2026-09-04 column collapse the shipped default for
      scripting is 「每次询问」, and an automatic run with no IM channel bound
      has nobody to ask, so `askOverIm` refuses with `no_binding`. What this
      journey pins is unchanged and is the thing that matters — the SHIPPED
      DEFAULT never lets an automatic run execute page script, and no dialog
      is raised in place of the missing channel.
    */
    expect(scriptResult).toMatch(/没有绑定可回复的 IM 频道|bound to no IM chat/);

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
    await expect(card.getByText(REASON_APPROVAL_REFUSED)).toBeVisible();
    // Exactly one blocked action.
    await expect(card.getByText(/^(1 次|1×)$/)).toHaveCount(1);
    await expect(card.getByText(NEXT_STEPS_TITLE)).toBeVisible();
    await expect(card.getByText(STEP_ANSWER_APPROVAL)).toBeVisible();
    // Same as ②: the run finished, the scripting it was asked for did not.
    await expect(card.getByText(OUTCOME_COMPLETED_WITH_REFUSALS)).toBeVisible();
    await expect(card.getByText(OUTCOME_COMPLETED)).toHaveCount(0);
  });

  /**
   * ③b the SAME journey with scripting set to 「允许」, on a site the user set
   * to 始终允许.
   *
   * This is the pair ③a needs to be worth anything. ③a alone proves "the
   * default refuses"; only running the identical script under an explicit
   * allow proves the refusal came from the SETTING and not from something
   * structural that would keep refusing after the user said yes — the failure
   * mode where a setting exists, reads as enabled, and changes nothing.
   *
   * The witnesses are inverted, read out of the same live document: the page's
   * own `__abuE2eScriptSentinel` and `document.title` must now BOTH have been
   * rewritten by the model's code, and the card must report the script rather
   * than a refusal.
   */
  test('runs unattended execute_js once the user allows it on an always-allowed site', async () => {
    const marker = `abu-e2e-unattended-script-allow-${randomUUID().slice(0, 8)}`;
    const fixture = await startFormFixture(marker);
    fixtures.push(fixture);
    const finalAnswer = `abu-e2e-script-ran-${randomUUID()}`;

    mock = await startOpenAiMock([
      { kind: 'tool-call', arguments: {}, toolCallId: `call-tabs-${randomUUID()}`, toolName: 'abu-browser__get_tabs' },
      async (body) => {
        lastSuccessfulToolResult(body, 'abu-browser__get_tabs');
        return {
          kind: 'tool-call',
          arguments: { tabId: (await currentTab(app!, body)).tabId, url: fixture.url },
          toolCallId: `call-nav-${randomUUID()}`,
          toolName: 'abu-browser__navigate',
        };
      },
      async (body) => {
        lastSuccessfulToolResult(body, 'abu-browser__navigate');
        return {
          kind: 'tool-call',
          arguments: {
            tabId: (await tabOn(app!, fixture.url)).tabId,
            // Byte-identical to ③a's payload on purpose: the ONLY difference
            // between the two journeys is the policy cell.
            code: 'window.__abuE2eScriptSentinel = "EXECUTED"; document.title = "EXECUTED"; "ok"',
          },
          toolCallId: `call-js-${randomUUID()}`,
          toolName: 'abu-browser__execute_js',
        };
      },
      { kind: 'complete', responseText: finalAnswer },
    ]);

    const page = await launchConfiguredApp(mock.baseUrl);
    const taskName = `U8 script allow ${randomUUID().slice(0, 8)}`;
    await seedUnattendedRun(page, {
      allowUnattendedBrowser: true,
      sitePermissions: { [fixture.origin]: 'allowed' },
      // Both halves are required: without the standing grant above, an
      // automatic run refuses an allowed script anyway — that conjunction is
      // pinned in the unit suite.
      operationPolicy: { scripting: 'allow' },
      scheduleId: `schedule-u8-script-allow-${randomUUID()}`,
      scheduleName: taskName,
      prompt: `read ${fixture.url}`,
    });
    await waitForBuiltinBrowserRuntime(page);
    await watchConfirmDialogTitles(page);
    await runScheduledTaskNow(page, taskName);

    await waitForTaskTurns(mock, 4);

    const scriptResult = toolResultFor(taskRequests(mock!)[3]!.body, 'abu-browser__execute_js');
    expect(scriptResult).not.toMatch(/^Error:/);
    expect(scriptResult).not.toMatch(/not permitted by the unattended browser policy/);

    // GROUND TRUTH, read out of the live native view: the code really ran.
    await expect.poll(
      () => evaluateInNativeView(app!, fixture.url, 'window.__abuE2eScriptSentinel'),
      { timeout: READY_TIMEOUT },
    ).toBe('EXECUTED');
    expect(await evaluateInNativeView(app!, fixture.url, 'document.title')).toBe('EXECUTED');

    // An allow is a decision made in Settings, NOT an approval round-trip —
    // no dialog may appear here either.
    await expectNoConfirmationDialogEverAppeared(page);

    await openScheduledRunConversation(page, taskName);
    const card = await waitForReportCard(page);
    // The card says out loud that code ran inside the session.
    await expect(card.getByText(SCRIPT_RUNS_ONE)).toBeVisible();
    // ...and there is nothing to report as blocked.
    await expect(card.getByText(DENIED_TITLE)).toHaveCount(0);
    await expect(card.getByText(REASON_POLICY_DENIED)).toHaveCount(0);
    // Nothing was blocked, so the card offers no next step either — least of
    // all "go loosen the setting" for a setting the user has already set.
    await expect(card.getByText(STEP_RELAX_POLICY)).toHaveCount(0);
    await expect(card.getByText(OUTCOME_COMPLETED_WITH_REFUSALS)).toHaveCount(0);
    await expect(card.getByText(OUTCOME_COMPLETED)).toBeVisible();
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
    /**
     * Nothing ever leaves the blank automation tab here — every `navigate` is
     * refused — so the only tab identity to read is the one `get_tabs`
     * provisioned. Read LIVE all the same: the point is that no journey in
     * this file quotes a tab id back out of an older transcript.
     *
     * `navigate` resolves its own origin from its `url` input, so this journey
     * never depends on the gate probing a page; the site is confirmed by
     * construction before the refusal is asserted.
     */
    const navigatePlan = async (body: unknown): Promise<MockReplyPlan> => {
      const previous = toolExchanges(body).at(-1);
      if (previous?.name === 'abu-browser__get_tabs') {
        lastSuccessfulToolResult(body, 'abu-browser__get_tabs');
      }
      return {
        kind: 'tool-call',
        arguments: { tabId: (await currentTab(app!, body)).tabId, url: fixture.url },
        toolCallId: `call-nav-${randomUUID()}`,
        toolName: 'abu-browser__navigate',
      };
    };

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
      operationPolicy: { interactive: 'ask' },
      scheduleId: `schedule-u8-abort-${randomUUID()}`,
      scheduleName: taskName,
      prompt: `open ${fixture.url} and submit`,
    });
    await waitForBuiltinBrowserRuntime(page);
    await watchConfirmDialogTitles(page);
    await runScheduledTaskNow(page, taskName);

    // get_tabs, navigate (refusal 1), navigate (refusal 2) — then the guard trips.
    await waitForTaskTurns(mock, 3);

    const navigateResult = toolResultFor(taskRequests(mock!)[2]!.body, 'abu-browser__navigate');
    expect(navigateResult).toMatch(/^Error:/);
    // Same discipline as ③a: the refusal under test is the approval seam's,
    // so an unresolvable site is a different refusal and must say so.
    expect(navigateResult).not.toMatch(
      /无法确认这次操作所在的网站|The site this action targets could not be determined/,
    );
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

  // ⑤ an overdue task fires by itself at app start ⇒ the roster frozen for
  //   that run carries the browser tools (issue #389)
  test('hands an overdue task caught up at app start its browser tools', async () => {
    const finalAnswer = `abu-e2e-catchup-done-${randomUUID()}`;

    mock = await startOpenAiMock([
      { kind: 'tool-call', arguments: {}, toolCallId: `call-tabs-${randomUUID()}`, toolName: 'abu-browser__get_tabs' },
      async (body) => {
        // Rule 1 of this file: the next turn is scripted only on a get_tabs
        // the BROWSER answered. A ceiling refusal fails right here, quoting
        // its text, instead of surfacing as a request count 45s later.
        lastSuccessfulToolResult(body, 'abu-browser__get_tabs');
        // ...and the tab it named is a live native view, so the run's roster
        // demonstrably reached the runtime, not a stale registry entry.
        await currentTab(app!, body);
        return { kind: 'complete', responseText: finalAnswer };
      },
    ]);

    const page = await launchConfiguredApp(mock.baseUrl);
    const scheduleId = `schedule-u8-catchup-${randomUUID()}`;
    await seedUnattendedRun(page, {
      allowUnattendedBrowser: true,
      sitePermissions: {},
      scheduleId,
      scheduleName: `U8 catch-up ${randomUUID().slice(0, 8)}`,
      prompt: 'list the open browser tabs',
      firing: 'overdue-at-start',
    });
    // Deliberately NO waitForBuiltinBrowserRuntime and NO "Run Now". The
    // reload inside seedUnattendedRun is the app start; the scheduler's
    // start-up tick dispatched the task while abu-browser was still
    // connecting, and the product — not the harness — has to wait for it.
    await waitForTaskTurns(mock, 2);

    const listing = toolResultFor(taskRequests(mock!)[1]!.body, 'abu-browser__get_tabs');
    // THE regression: before #394 the roster was frozen mid-handshake, and
    // this — not a tab listing — is what the model was told, for the whole
    // run, with no retry.
    expect(listing).not.toMatch(/is not allowed for this agent run/);
    expect(listing).not.toMatch(/^Error:/);
    expect(listing).toMatch(/"currentTabId":\s*\d+/);

    // Exactly one catch-up run (the seed already counted one earlier run),
    // completed, and the task is back on its cadence: the next slot is later
    // than the run's own end, so a caught-up task does not fire twice.
    await expect
      .poll(() => persistedScheduledTask(page, scheduleId), { timeout: READY_TIMEOUT })
      .toMatchObject({ totalRuns: 2, runs: [{ status: 'completed' }] });
    const task = await persistedScheduledTask(page, scheduleId);
    expect(task?.nextRunAt).toBeGreaterThan(task?.runs[0]?.completedAt ?? Number.POSITIVE_INFINITY);
    expect(mock!.consumedPlans()).toBe(2);
  });

  // ⑥ embedded regions: a same-origin one is covered by the page's grant, a
  //    cross-origin one is not — and the built-in browser cannot even reach
  //    inside it, which it says rather than failing quietly.
  test('fills a field inside a SAME-origin embedded region, and the value lands in that region\'s document', async () => {
    const marker = `abu-e2e-frames-${randomUUID().slice(0, 8)}`;
    const vendor = await startFormFixture(`${marker}-vendor`);
    fixtures.push(vendor);
    const host = await startFrameHostFixture(marker, vendor.url);
    fixtures.push(host);
    const filledValue = `abu-e2e-in-region-${randomUUID().slice(0, 8)}`;
    const finalAnswer = `abu-e2e-frames-done-${randomUUID()}`;

    mock = await startOpenAiMock([
      { kind: 'tool-call', arguments: {}, toolCallId: `call-tabs-${randomUUID()}`, toolName: 'abu-browser__get_tabs' },
      async (body) => {
        lastSuccessfulToolResult(body, 'abu-browser__get_tabs');
        return {
          kind: 'tool-call',
          arguments: { tabId: (await currentTab(app!, body)).tabId, url: host.url },
          toolCallId: `call-nav-${randomUUID()}`,
          toolName: 'abu-browser__navigate',
        };
      },
      // The handles are runtime values, so the model has to LEARN them — same
      // as a real run: snapshot the page, read `frames`, then act in one.
      async (body) => {
        lastSuccessfulToolResult(body, 'abu-browser__navigate');
        return {
          kind: 'tool-call',
          // `tabOn` rather than `currentTab`: the navigation has to have LANDED
          // before the snapshot, or the frame handles come from whatever the
          // tab was showing a moment ago.
          arguments: { tabId: (await tabOn(app!, host.url)).tabId },
          toolCallId: `call-shot-${randomUUID()}`,
          toolName: 'abu-browser__snapshot',
        };
      },
      async (body) => {
        // A snapshot that failed would make `extractFrameId` throw a message
        // about a missing handle and hide the real cause (#388's rule).
        lastSuccessfulToolResult(body, 'abu-browser__snapshot');
        return {
          kind: 'tool-call',
          arguments: {
            tabId: (await tabOn(app!, host.url)).tabId,
            frameId: extractFrameId(body, '/inner'),
            locator: JSON.stringify({ css: '#innerField' }),
            value: filledValue,
          },
          toolCallId: `call-fill-${randomUUID()}`,
          toolName: 'abu-browser__fill',
        };
      },
      { kind: 'complete', responseText: finalAnswer },
    ]);

    const page = await launchConfiguredApp(mock.baseUrl);
    const taskName = `T4 region fill ${randomUUID().slice(0, 8)}`;
    await seedUnattendedRun(page, {
      allowUnattendedBrowser: true,
      // ONLY the page's own site. The same-origin region is covered by it;
      // nothing here authorizes the vendor.
      sitePermissions: { [host.origin]: 'allowed' },
      scheduleId: `schedule-t4-frames-${randomUUID()}`,
      scheduleName: taskName,
      prompt: `fill the embedded form at ${host.url}`,
    });
    await watchConfirmDialogTitles(page);
    await runScheduledTaskNow(page, taskName);

    await expect.poll(() => taskRequests(mock!).length, { timeout: READY_TIMEOUT }).toBe(5);

    // GROUND TRUTH, read out of the LIVE child document: the value is inside
    // the region, and the identically-named field on the outer page was not
    // touched — which is what "bound to one document" has to mean.
    await expect.poll(
      () => evaluateInNativeView(
        app!, host.url,
        'document.getElementById("same").contentDocument.getElementById("innerField").value',
      ),
      { timeout: READY_TIMEOUT },
    ).toBe(filledValue);
    expect(
      await evaluateInNativeView(app!, host.url, 'document.getElementById("outerField").value'),
    ).toBe('');

    const fillResult = toolResultFor(taskRequests(mock!)[4]!.body, 'abu-browser__fill');
    expect(fillResult).not.toMatch(/^Error:/);
    await expectNoConfirmationDialogEverAppeared(page);
  });

  /**
   * Round-2 F1, end to end in a real Electron shell: a `batch` whose steps act
   * in DIFFERENT embedded regions runs all of them.
   *
   * The regression it guards is the one that made every region-naming batch
   * stop before step 0 — the gate handing the run a pin the run then compared
   * against the wrong thing, and each step carrying the page's origin into a
   * region that checks its own.
   *
   * SAME-origin regions, stated plainly: the built-in browser cannot reach
   * inside a cross-origin region at all (see the journey below), and there is
   * no e2e harness that drives a real Chrome through the extension, which is
   * the only channel that can. So this pins "a batch that names regions runs,
   * and each step lands in the region it named" against a real browser; the
   * CROSS-origin half of the chain — gate → `_meta` → run → per-step payload,
   * with the content script's pin rule applied — is pinned at unit level in
   * `src/core/tools/registry.browserFrameGate.test.ts`.
   */
  test('runs a batch whose steps act in two DIFFERENT embedded regions', async () => {
    const marker = `abu-e2e-batch-frames-${randomUUID().slice(0, 8)}`;
    const host = await startTwoRegionHostFixture(marker);
    fixtures.push(host);
    const valueA = `abu-e2e-region-a-${randomUUID().slice(0, 8)}`;
    const valueB = `abu-e2e-region-b-${randomUUID().slice(0, 8)}`;
    const finalAnswer = `abu-e2e-batch-frames-done-${randomUUID()}`;

    mock = await startOpenAiMock([
      { kind: 'tool-call', arguments: {}, toolCallId: `call-tabs-${randomUUID()}`, toolName: 'abu-browser__get_tabs' },
      async (body) => {
        lastSuccessfulToolResult(body, 'abu-browser__get_tabs');
        return {
          kind: 'tool-call',
          arguments: { tabId: (await currentTab(app!, body)).tabId, url: host.url },
          toolCallId: `call-nav-${randomUUID()}`,
          toolName: 'abu-browser__navigate',
        };
      },
      async (body) => {
        lastSuccessfulToolResult(body, 'abu-browser__navigate');
        return {
          kind: 'tool-call',
          // `tabOn` rather than `currentTab`: the navigation has to have LANDED
          // before the snapshot, or the frame handles come from whatever the
          // tab was showing a moment ago.
          arguments: { tabId: (await tabOn(app!, host.url)).tabId },
          toolCallId: `call-shot-${randomUUID()}`,
          toolName: 'abu-browser__snapshot',
        };
      },
      async (body) => {
        lastSuccessfulToolResult(body, 'abu-browser__snapshot');
        return {
        kind: 'tool-call',
        arguments: {
          tabId: (await tabOn(app!, host.url)).tabId,
          steps: JSON.stringify([
            {
              action: 'fill',
              frameId: extractFrameId(body, '/regionA'),
              locator: { css: '#fieldA' },
              value: valueA,
            },
            {
              action: 'fill',
              frameId: extractFrameId(body, '/regionB'),
              locator: { css: '#fieldB' },
              value: valueB,
            },
          ]),
        },
        toolCallId: `call-batch-${randomUUID()}`,
        toolName: 'abu-browser__batch',
        };
      },
      { kind: 'complete', responseText: finalAnswer },
    ]);

    const page = await launchConfiguredApp(mock.baseUrl);
    const taskName = `T4 region batch ${randomUUID().slice(0, 8)}`;
    await seedUnattendedRun(page, {
      allowUnattendedBrowser: true,
      sitePermissions: { [host.origin]: 'allowed' },
      scheduleId: `schedule-t4-batch-frames-${randomUUID()}`,
      scheduleName: taskName,
      prompt: `fill both embedded forms at ${host.url}`,
    });
    await watchConfirmDialogTitles(page);
    await runScheduledTaskNow(page, taskName);

    await expect.poll(() => taskRequests(mock!).length, { timeout: READY_TIMEOUT }).toBe(5);

    // GROUND TRUTH, read out of the two LIVE child documents: each step landed
    // in the region it named, and neither value crossed over.
    await expect.poll(
      () => evaluateInNativeView(
        app!, host.url,
        'document.getElementById("a").contentDocument.getElementById("fieldA").value',
      ),
      { timeout: READY_TIMEOUT },
    ).toBe(valueA);
    expect(
      await evaluateInNativeView(
        app!, host.url,
        'document.getElementById("b").contentDocument.getElementById("fieldB").value',
      ),
    ).toBe(valueB);

    const batchResult = toolResultFor(taskRequests(mock!)[4]!.body, 'abu-browser__batch');
    expect(batchResult).not.toMatch(/^Error:/);
    const parsed = JSON.parse(batchResult) as {
      stopped?: string; completedSteps?: unknown[]; frameOrigins?: Record<string, string>;
    };
    // The failure this journey exists for: `stopped: 'origin-changed'` with
    // zero completed steps, blaming a tab that never moved.
    expect(parsed.stopped).toBeUndefined();
    expect(parsed.completedSteps).toHaveLength(2);
    expect(Object.values(parsed.frameOrigins ?? {})).toEqual([host.origin, host.origin]);

    await expectNoConfirmationDialogEverAppeared(page);
  });

  test('refuses to act inside a CROSS-origin embedded region the user never authorized', async () => {
    const marker = `abu-e2e-frames-deny-${randomUUID().slice(0, 8)}`;
    const vendor = await startFormFixture(`${marker}-vendor`);
    fixtures.push(vendor);
    const host = await startFrameHostFixture(marker, vendor.url);
    fixtures.push(host);
    const neverWritten = `abu-e2e-should-not-be-written-${randomUUID().slice(0, 8)}`;
    const finalAnswer = `abu-e2e-frames-deny-done-${randomUUID()}`;

    mock = await startOpenAiMock([
      { kind: 'tool-call', arguments: {}, toolCallId: `call-tabs-${randomUUID()}`, toolName: 'abu-browser__get_tabs' },
      async (body) => {
        lastSuccessfulToolResult(body, 'abu-browser__get_tabs');
        return {
          kind: 'tool-call',
          arguments: { tabId: (await currentTab(app!, body)).tabId, url: host.url },
          toolCallId: `call-nav-${randomUUID()}`,
          toolName: 'abu-browser__navigate',
        };
      },
      async (body) => {
        lastSuccessfulToolResult(body, 'abu-browser__navigate');
        return {
          kind: 'tool-call',
          // `tabOn` rather than `currentTab`: the navigation has to have LANDED
          // before the snapshot, or the frame handles come from whatever the
          // tab was showing a moment ago.
          arguments: { tabId: (await tabOn(app!, host.url)).tabId },
          toolCallId: `call-shot-${randomUUID()}`,
          toolName: 'abu-browser__snapshot',
        };
      },
      async (body) => {
        lastSuccessfulToolResult(body, 'abu-browser__snapshot');
        return {
          kind: 'tool-call',
          arguments: {
            tabId: (await tabOn(app!, host.url)).tabId,
            frameId: extractFrameId(body, vendor.host),
            locator: JSON.stringify({ css: '#field' }),
            value: neverWritten,
          },
          toolCallId: `call-fill-${randomUUID()}`,
          toolName: 'abu-browser__fill',
        };
      },
      { kind: 'complete', responseText: finalAnswer },
    ]);

    const page = await launchConfiguredApp(mock.baseUrl);
    const taskName = `T4 region deny ${randomUUID().slice(0, 8)}`;
    await seedUnattendedRun(page, {
      allowUnattendedBrowser: true,
      sitePermissions: { [host.origin]: 'allowed' },
      scheduleId: `schedule-t4-frames-deny-${randomUUID()}`,
      scheduleName: taskName,
      prompt: `fill the vendor form embedded in ${host.url}`,
    });
    await watchConfirmDialogTitles(page);
    await runScheduledTaskNow(page, taskName);

    await expect.poll(() => taskRequests(mock!).length, { timeout: READY_TIMEOUT }).toBe(5);

    const fillResult = toolResultFor(taskRequests(mock!)[4]!.body, 'abu-browser__fill');
    expect(fillResult).toMatch(/^Error:/);
    // GROUND TRUTH: the vendor's own document is untouched. A refusal that
    // still typed into the page would be the whole failure this exists to stop.
    expect(
      await evaluateInNativeViewFrame(
        app!, host.url, vendor.url, 'document.getElementById("field").value',
      ),
    ).toBe('');

    await openScheduledRunConversation(page, taskName);
    const card = await waitForReportCard(page);
    await expect(card.getByText(OUTCOME_COMPLETED_WITH_REFUSALS)).toBeVisible();
    await expect(card.getByText(DENIED_TITLE)).toBeVisible();

    await expectNoConfirmationDialogEverAppeared(page);
  });
});
