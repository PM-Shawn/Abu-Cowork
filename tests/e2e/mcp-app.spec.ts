/**
 * The MCP Apps host in the real Electron shell.
 *
 * Everything below runs against `tests/fixtures/mcp-app-demo`, a real stdio MCP
 * server spawned through Abu's normal connector path, driven by a real sidecar
 * turn whose only stub is the model: a loopback OpenAI-compatible SSE server
 * that emits one prepared tool call per request (the same technique as
 * tool-approval.spec.ts). No real credential, endpoint or user file is touched.
 *
 * What only a real shell can prove, and why each of these is here:
 *   - the interface renders in a `sandbox="allow-scripts"` iframe whose srcdoc
 *     really carries the host-built CSP;
 *   - a button inside that sandbox reaches Abu's approval dialog before its
 *     `tools/call` executes, and leaves an audit row behind;
 *   - `ui/message` lands in the composer as a draft and is NOT sent;
 *   - `ui/open-link` needs consent, and cancelling is recorded;
 *   - the browser actually blocks what the CSP and the sandbox say it should —
 *     asserted from markers the hostile fixture writes into its own DOM, since
 *     a unit test can only prove which policy STRING was generated.
 *
 * ## Why the approval assertion needs the reload in the middle
 * A plain third-party MCP tool is `allow` by design — model-initiated and
 * app-initiated calls are classified identically (that is the whole point of
 * the app bridge reusing `checkToolApproval`), and neither asks. The dialog
 * appears for *plugin-contributed* connectors. So the run arms that gate the
 * way a real boot does — `abu-plugins`'s persisted `knownMcpServerNames`, which
 * `onRehydrateStorage` feeds to `setPluginServerNames` — and reloads. The
 * reload is also what clears the per-conversation grant minted by an approval,
 * and it doubles as the spec's "reopen the conversation, the interface comes
 * back" acceptance item.
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
  REPO_ROOT,
  type ElectronDataRoot,
} from './electronHelpers';

const READY_TIMEOUT = 45_000;
const CHAT_PLACEHOLDER = '想让阿布帮你做点什么？';
const TEST_API_KEY = 'abu-e2e-mcp-app-not-a-real-secret';
const TEST_MODEL_ID = 'abu-e2e-mcp-app-model';
const SERVER_NAME = 'mcp-app-demo';
// `chat.mcpAppNotConnected` with `{server}` filled in — the block's own
// disconnected placeholder (spec §6.5b). Spelled out rather than imported so a
// silent wording change has to be acknowledged here.
const NOT_CONNECTED = new RegExp(`^(连接 ${SERVER_NAME} 以显示界面|Connect ${SERVER_NAME} to show the app view)$`);
const FIXTURE_ENTRY = path.join(REPO_ROOT, 'tests', 'fixtures', 'mcp-app-demo', 'server.ts');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

const LOCAL_MOCK_PROVIDER_OPTIONS = {
  apiKey: TEST_API_KEY,
  modelId: TEST_MODEL_ID,
  modelLabel: 'Abu E2E MCP Apps model',
  permissionMode: 'standard',
  providerId: 'abu-e2e-mcp-app-provider',
  providerName: 'Abu E2E loopback MCP Apps provider',
  supportsReasoning: null,
  supportsTools: true,
} as const;

type MockReplyPlan =
  | { kind: 'tool-call'; arguments: Record<string, unknown>; toolCallId: string; toolName: string }
  | { kind: 'complete'; responseText: string };

interface OpenAiMock {
  baseUrl: string;
  close: () => Promise<void>;
  requestCount: () => number;
}

function sseChunk(delta: Record<string, unknown>, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-abu-e2e-mcp-app',
    object: 'chat.completion.chunk',
    created: 0,
    model: TEST_MODEL_ID,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function planToSse(plan: MockReplyPlan): string {
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

async function startOpenAiMock(replyPlans: readonly MockReplyPlan[]): Promise<OpenAiMock> {
  let served = 0;
  const activeResponses = new Set<ServerResponse>();
  const server = createServer(async (req, res) => {
    activeResponses.add(res);
    res.once('close', () => activeResponses.delete(res));

    const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    for await (const chunk of req) void chunk;

    if (req.method !== 'POST' || requestUrl.pathname !== '/v1/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unexpected local E2E mock route' }));
      return;
    }

    const replyPlan = replyPlans[served];
    served += 1;
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
    res.end(planToSse(replyPlan));
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
    // 2130706433 is the numeric IPv4 spelling of 127.0.0.1 — still loopback,
    // but it sidesteps the adapter's literal-loopback => Ollama heuristic so
    // the real SSE/tools path is exercised.
    baseUrl: `http://2130706433:${address.port}/v1`,
    close: () => closeServer(server, activeResponses),
    requestCount: () => served,
  };
}

function closeServer(server: Server, activeResponses: ReadonlySet<ServerResponse>): Promise<void> {
  for (const response of activeResponses) response.destroy();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.closeAllConnections?.();
      reject(new Error('Timed out closing the local OpenAI E2E mock'));
    }, 5_000);
    server.close((error) => {
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    });
    server.closeAllConnections?.();
  });
}

async function waitForApp(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible({ timeout: READY_TIMEOUT });
}

/**
 * Register the fixture as a stdio connector the way the connector form does,
 * then let the app's own boot path (`initMCPStoreSync` → `connectAllEnabled`)
 * spawn it. `node <tsx cli>` with absolute paths rather than `npx tsx …` so the
 * spawn never depends on the child's working directory or on npx resolving a
 * package from a registry.
 */
async function seedDemoConnector(page: Page, readyFile: string): Promise<void> {
  await page.evaluate((config) => {
    window.localStorage.setItem('abu-mcp-store', JSON.stringify({
      state: {
        servers: {
          [config.name]: {
            config: {
              name: config.name,
              transport: 'stdio',
              command: config.command,
              args: config.args,
              env: { ABU_MCP_DEMO_READY_FILE: config.readyFile },
              enabled: true,
            },
            status: 'disconnected',
            tools: [],
          },
        },
      },
      version: 1,
    }));
  }, { name: SERVER_NAME, command: process.execPath, args: [TSX_CLI, FIXTURE_ENTRY], readyFile });
}

/**
 * Put Abu's theme on `system` so the suite can repaint the app the way the OS
 * does, with `page.emulateMedia({ colorScheme })`.
 *
 * That is the app's OWN lever: `App.tsx` listens to
 * `matchMedia('(prefers-color-scheme: dark)')` while the theme is `system` and
 * toggles the `dark` class on `<html>`, which is exactly what `McpAppBlock`'s
 * theme MutationObserver watches. Poking the class (or the store) directly
 * would assert the bridge without proving the app is wired to Abu's theme at
 * all. Must run before the reload that `configureLocalMockProvider` performs —
 * it re-reads and re-writes this same key, preserving whatever else is in it.
 */
async function useSystemTheme(page: Page): Promise<void> {
  await page.evaluate(() => {
    const raw = window.localStorage.getItem('abu-settings');
    if (!raw) throw new Error('abu-settings was not initialized before the E2E theme setup');
    const persisted = JSON.parse(raw) as { state: Record<string, unknown> };
    persisted.state.theme = 'system';
    window.localStorage.setItem('abu-settings', JSON.stringify(persisted));
  });
}

/**
 * Flip the demo connector's connection from the real Connectors UI, the way a
 * user would: 扩展 → 连接器 → 我的 → the server card → the connect/disconnect
 * action in its detail header. Going through the UI (rather than reaching into
 * the store) is what makes this evidence for §6.5b: the block reacts to the
 * store status the UI actually writes.
 */
async function toggleDemoConnector(page: Page, expectConnected: boolean): Promise<void> {
  await page.getByLabel('Main navigation').getByRole('button', { name: /^(扩展|Extensions)$/ }).click();
  const panel = page.getByRole('main');
  await panel.getByRole('button', { name: /^(连接器|Connectors)$/ }).click({ timeout: READY_TIMEOUT });
  await page.getByTestId('extensions-source-mine').click();
  await panel.getByRole('button', { name: new RegExp(SERVER_NAME) }).first().click();
  const toggle = page.getByTestId('mcp-server-toggle-connection');
  await expect(toggle).toBeVisible({ timeout: READY_TIMEOUT });
  await toggle.click();
  // Wait for the control itself to report the new state before leaving the
  // page: it renders from the connector store's status, so this is the store
  // settling (a spawn, or a process teardown) rather than a sleep.
  await expect(toggle).toHaveAttribute('data-connected', String(expectConnected), {
    timeout: READY_TIMEOUT,
  });
  await page.keyboard.press('Escape');
}

/** Back to the conversation the run opened, from wherever the sidebar is. */
async function openConversation(page: Page, prompt: string): Promise<void> {
  const sidebarToggle = page.getByTitle(/显示侧栏|Show sidebar/);
  if (await sidebarToggle.count()) await sidebarToggle.first().click();
  const recentConversation = page
    .getByRole('button', { name: `${prompt.slice(0, 30)}...` })
    .first();
  await expect(recentConversation).toBeVisible({ timeout: READY_TIMEOUT });
  await recentConversation.click();
}

/** Arm the plugin-tool approval gate for the demo connector (see file header). */
async function armPluginApprovalGate(page: Page): Promise<void> {
  await page.evaluate((serverName) => {
    window.localStorage.setItem('abu-plugins', JSON.stringify({
      state: { marketplaces: [], knownMcpServerNames: [serverName] },
      version: 2,
    }));
  }, SERVER_NAME);
}

function appFrame(page: Page, index: number) {
  return page.locator('[data-testid="mcp-app-frame"]').nth(index);
}

function appFrameContent(page: Page, index: number) {
  return page.frameLocator('[data-testid="mcp-app-frame"]').nth(index);
}

/**
 * Press a control inside the sandboxed interface.
 *
 * First assert the control is really reachable — the host sizes the iframe from
 * the app's `ui/notifications/size-changed`, so a control the host has not made
 * room for yet would be genuinely unusable, and that is worth failing on.
 *
 * Then fire the click with `dispatchEvent` rather than a pointer click. A
 * pointer click is resolved in page coordinates and re-checked against the
 * hit-test, and the host keeps nudging this iframe's height (`size-changed`,
 * then `host-context-changed` from its own ResizeObserver) for several frames
 * after the app renders. A click that lands during one of those nudges is
 * swallowed with no error — observed as a flake where the app's own handler
 * never ran at all. What this test is about is the bridge round-trip behind the
 * button, so take the layout race out of it.
 */
async function clickInApp(content: ReturnType<typeof appFrameContent>, testId: string): Promise<void> {
  const control = content.getByTestId(testId);
  await expect(control).toBeInViewport({ timeout: READY_TIMEOUT });
  await control.dispatchEvent('click');
}

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;
let mock: OpenAiMock | undefined;

test.describe.serial('MCP Apps host in Electron', () => {
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

  test('renders, gates, drafts and sandboxes a connector-provided interface', async () => {
    // One Electron launch, one spawned connector, two model turns and a
    // reload — well past the 90s suite default.
    test.setTimeout(420_000);

    // Four steps up front, one turn each: show_table, its follow-up answer,
    // show_evil, its follow-up answer.
    mock = await startOpenAiMock([
      {
        kind: 'tool-call',
        arguments: {},
        toolCallId: `call-table-${randomUUID()}`,
        toolName: `${SERVER_NAME}__show_table`,
      },
      { kind: 'complete', responseText: `abu-e2e-table-done-${randomUUID()}` },
      {
        kind: 'tool-call',
        arguments: {},
        toolCallId: `call-evil-${randomUUID()}`,
        toolName: `${SERVER_NAME}__show_evil`,
      },
      { kind: 'complete', responseText: `abu-e2e-evil-done-${randomUUID()}` },
    ]);

    dataRoot = createElectronDataRoot();
    const readyFile = path.join(dataRoot.rootDir, 'mcp-app-demo-ready');
    const launched = await launchAbuElectron(dataRoot);
    app = launched.app;
    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForApp(page);

    await seedDemoConnector(page, readyFile);
    // Deterministic starting point for the §6.3 repaint check: `system` theme
    // plus an explicitly emulated LIGHT scheme, so the run does not inherit
    // whatever the machine's OS appearance happens to be.
    await page.emulateMedia({ colorScheme: 'light' });
    await useSystemTheme(page);
    // Reloads on its way out, which is what starts the connector.
    await configureLocalMockProvider(page, mock.baseUrl, LOCAL_MOCK_PROVIDER_OPTIONS);
    await expect
      .poll(() => fs.existsSync(readyFile), { timeout: READY_TIMEOUT })
      .toBe(true);

    // ---- the model opens the interface -----------------------------------
    const prompt = `abu-e2e-mcp-app-${randomUUID()}`;
    const composer = page.getByPlaceholder(CHAT_PLACEHOLDER);
    await composer.fill(prompt);
    await composer.press('Enter');

    const frame = appFrame(page, 0);
    await expect(frame).toBeVisible({ timeout: READY_TIMEOUT });

    // ---- the sandbox is what the spec says it is -------------------------
    await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    await expect(frame).toHaveAttribute('allow', '');
    await expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
    const srcdoc = await frame.getAttribute('srcdoc');
    expect(srcdoc).toContain('Content-Security-Policy');
    expect(srcdoc).toContain("frame-src 'none'");
    expect(srcdoc).toContain("form-action 'none'");
    expect(srcdoc).toContain("connect-src 'none'");

    // ---- the interface handshook and rendered the tool result ------------
    const content = appFrameContent(page, 0);
    await expect(content.getByTestId('demo-row')).toHaveCount(3, { timeout: READY_TIMEOUT });
    await expect(content.getByTestId('demo-value-alpha')).toHaveText('100');
    await expect(content.getByTestId('demo-value-gamma')).toHaveText('300');

    // ---- ui/message drafts, never sends ----------------------------------
    // The buttons below all speak JSON-RPC over the bridge, so wait until the
    // app says it finished the handshake AND received its result before
    // clicking — a click into a not-yet-connected sandbox would post into the
    // void.
    await expect(content.getByTestId('demo-status')).toHaveText('tool-result', {
      timeout: READY_TIMEOUT,
    });
    // ---- §6.3 the interface repaints when Abu switches to dark ----------
    // The marker is written from the `ui/initialize` result's hostContext and
    // rewritten on every `host-context-changed` — so it proves both halves:
    // the app was told its theme at handshake time, and it is told again when
    // the host's theme changes under it.
    const frameBody = content.locator('body');
    await expect(frameBody).toHaveAttribute('data-theme', 'theme:light', {
      timeout: READY_TIMEOUT,
    });
    await page.emulateMedia({ colorScheme: 'dark' });
    // Two separate claims, asserted separately so a failure says which one
    // broke: (1) the emulated OS preference reached the renderer at all,
    // (2) Abu reacted to it.
    await expect
      .poll(() => page.evaluate(() => window.matchMedia('(prefers-color-scheme: dark)').matches), {
        timeout: READY_TIMEOUT,
      })
      .toBe(true);
    // Abu itself went dark (App.tsx's matchMedia listener), which is what the
    // block's MutationObserver reacts to.
    await expect(page.locator('html')).toHaveClass(/(^|\s)dark(\s|$)/, { timeout: READY_TIMEOUT });
    await expect(frameBody).toHaveAttribute('data-theme', 'theme:dark', {
      timeout: READY_TIMEOUT,
    });
    // And back — a one-way notification would look identical above.
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(frameBody).toHaveAttribute('data-theme', 'theme:light', {
      timeout: READY_TIMEOUT,
    });

    const requestsBeforeDraft = mock.requestCount();
    await clickInApp(content, 'demo-send');
    await expect(content.getByTestId('demo-status')).toHaveText('message sent', {
      timeout: READY_TIMEOUT,
    });
    await expect(composer).toHaveValue(/mcp-app-demo table: alpha=100 beta=200 gamma=300/, {
      timeout: READY_TIMEOUT,
    });
    // A draft must not become a turn: nothing in the transcript, no model
    // request. (Scoped to the message list — the composer itself of course
    // holds the text, that is the point.)
    await expect(
      page.locator('[data-testid="virtuoso-item-list"]')
        .getByText('mcp-app-demo table: alpha=100 beta=200 gamma=300'),
    ).toHaveCount(0);
    // The counter only ever grows, so the real property is "still equal after a
    // quiet window", not "equal right now". Hold the probe back until the window
    // has elapsed — an expect.poll that can pass on its first tick would prove
    // nothing about a send that happens 300ms later.
    const quietUntil = Date.now() + 1_000;
    await expect
      .poll(() => (Date.now() < quietUntil ? -1 : mock!.requestCount()), {
        timeout: 10_000,
        intervals: [100],
      })
      .toBe(requestsBeforeDraft);
    await composer.fill('');

    // ---- ui/open-link asks first, and records the refusal ----------------
    // `openWidgetLink` is a renderer-side `window.open` (the popup is then
    // denied and re-routed to `shell.openExternal` by securityBoundary.cjs), so
    // recording it here catches the whole chain at its first link. It records
    // WITHOUT calling through: if the consent gate ever leaked, the assertion
    // below should fail rather than actually launch a browser on the machine
    // running the suite.
    const windowsBeforeLink = app!.windows().length;
    await page.evaluate(() => {
      const w = window as unknown as { __abuOpenedLinks?: string[] };
      w.__abuOpenedLinks = [];
      window.open = ((url?: string | URL) => {
        w.__abuOpenedLinks!.push(String(url));
        return null;
      }) as typeof window.open;
    });
    await clickInApp(content, 'demo-link');
    await expect(page.getByRole('heading', { name: '界面想打开链接' })).toBeVisible({
      timeout: READY_TIMEOUT,
    });
    await expect(page.getByTestId('mcp-app-open-link-url')).toHaveText(
      'https://modelcontextprotocol.io/',
    );
    await page.getByRole('button', { name: '取消' }).click();
    const declinedRow = page.getByTestId('mcp-app-audit-row').filter({ hasText: '界面请求打开链接' });
    await expect(declinedRow).toBeVisible({ timeout: READY_TIMEOUT });
    await declinedRow.click();
    await expect(declinedRow).toContainText('已拒绝打开');
    // Refused means refused: nothing reached the shell, and no window opened.
    expect(
      await page.evaluate(() => (window as unknown as { __abuOpenedLinks?: string[] }).__abuOpenedLinks ?? []),
    ).toEqual([]);
    expect(app!.windows()).toHaveLength(windowsBeforeLink);

    // ---- fullscreen promotes the same iframe, then returns inline --------
    await clickInApp(content, 'demo-fullscreen');
    await expect(page.getByTestId('mcp-app-fullscreen')).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(page.getByTestId('mcp-app-block').first()).toHaveAttribute(
      'data-display-mode',
      'fullscreen',
    );
    // The app kept its state across the promotion — the rows are still there.
    await expect(content.getByTestId('demo-row')).toHaveCount(3);
    await page.getByTestId('mcp-app-fullscreen-exit').click();
    await expect(page.getByTestId('mcp-app-block').first()).toHaveAttribute(
      'data-display-mode',
      'inline',
    );

    // ---- what the interface told the model, on demand --------------------
    const contextExpander = page.getByTestId('mcp-app-context').first();
    await expect(contextExpander).toBeVisible({ timeout: READY_TIMEOUT });
    await contextExpander.getByRole('button').click();
    await expect(contextExpander).toContainText(
      'mcp-app-demo summary: alpha=100 beta=200 gamma=300',
    );

    // ---- arm the plugin gate, reload, reopen the conversation ------------
    await armPluginApprovalGate(page);
    // Drop the readiness marker first: the reload respawns the connector, and
    // the interface can only be rebuilt once that connection is back. Reopening
    // the conversation before then renders nothing at all — the step's `ui`
    // cannot be resolved from a disconnected server, and nothing re-resolves it
    // when the connection later lands (see the report's finding on this).
    fs.rmSync(readyFile, { force: true });
    await page.reload();
    await waitForApp(page);
    await expect
      .poll(() => fs.existsSync(readyFile), { timeout: READY_TIMEOUT })
      .toBe(true);
    await openConversation(page, prompt);

    // The interface comes back from the persisted step (spec §4.4) — same rows.
    const replayed = appFrameContent(page, 0);
    await expect(replayed.getByTestId('demo-row')).toHaveCount(3, { timeout: READY_TIMEOUT });
    await expect(replayed.getByTestId('demo-value-alpha')).toHaveText('100');

    // ---- the interface's own tools/call crosses the approval gate --------
    await clickInApp(replayed, 'demo-refresh');
    await expect(page.getByRole('heading', { name: /^(操作确认|Confirm Action)$/ })).toBeVisible({
      timeout: READY_TIMEOUT,
    });
    // Nothing ran yet: the rows are still the ones the model's call produced.
    await expect(replayed.getByTestId('demo-value-alpha')).toHaveText('100');
    await page.getByRole('button', { name: /^(确认执行|Confirm)$/ }).click();

    await expect(replayed.getByTestId('demo-value-alpha')).toHaveText('101', {
      timeout: READY_TIMEOUT,
    });
    await expect(replayed.getByTestId('demo-value-gamma')).toHaveText('301');
    await expect(
      page.getByTestId('mcp-app-audit-row').filter({ hasText: 'refresh_rows' }),
    ).toBeVisible({ timeout: READY_TIMEOUT });

    // ---- §6.5b a disconnected connector takes its interface with it ------
    // The tool card above still shows the plain result; what must go is the
    // live interface, replaced by a line naming the connector to reconnect.
    await toggleDemoConnector(page, false);
    await openConversation(page, prompt);
    await expect(page.getByTestId('mcp-app-status')).toHaveText(NOT_CONNECTED, {
      timeout: READY_TIMEOUT,
    });
    await expect(page.locator('[data-testid="mcp-app-frame"]')).toHaveCount(0);

    // Reconnecting brings it back — with its rows, from the persisted step.
    await toggleDemoConnector(page, true);
    await openConversation(page, prompt);
    const reconnected = appFrameContent(page, 0);
    await expect(reconnected.getByTestId('demo-row')).toHaveCount(3, { timeout: READY_TIMEOUT });

    // ---- the hostile interface -------------------------------------------
    const evilPrompt = `abu-e2e-mcp-app-evil-${randomUUID()}`;
    const composerAfterReload = page.getByPlaceholder(CHAT_PLACEHOLDER);
    await composerAfterReload.fill(evilPrompt);
    await composerAfterReload.press('Enter');

    await expect(page.locator('[data-testid="mcp-app-frame"]')).toHaveCount(2, {
      timeout: READY_TIMEOUT,
    });
    const disclosure = page.getByTestId('mcp-app-unsupported').last();
    await expect(disclosure).toBeVisible({ timeout: READY_TIMEOUT });
    // The two domains the host refused are named; the legal one is not.
    await expect(disclosure).toContainText('*');
    await expect(disclosure).toContainText('http://evil.example');

    // Assert on the policy the host BUILT, not on the whole document: the
    // hostile page's own source of course mentions the domains it tries.
    const evilSrcdoc = (await appFrame(page, 1).getAttribute('srcdoc')) ?? '';
    const evilCsp = /<meta[^>]*http-equiv="Content-Security-Policy"[^>]*content="([^"]*)"/i
      .exec(evilSrcdoc)?.[1] ?? '';
    expect(evilCsp).not.toBe('');
    expect(evilCsp).toContain('connect-src https://ok.example');
    expect(evilCsp).not.toContain('evil.example');
    expect(evilCsp).not.toContain('*');
    expect(evilCsp).toContain("frame-src 'none'");

    // The browser really refused every escape the page tried.
    const probe = appFrameContent(page, 1).getByTestId('evil-probe');
    await expect(probe).toContainText('fetch:blocked', { timeout: READY_TIMEOUT });
    await expect(probe).toContainText('iframe:blocked');
    await expect(probe).toContainText('form:blocked');
    await expect(probe).toContainText('open:blocked');
  });
});
