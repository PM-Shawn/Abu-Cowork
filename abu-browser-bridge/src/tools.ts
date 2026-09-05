/**
 * MCP Tool definitions for browser automation.
 * Each tool sends a browser action through the configured transport.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { evaluateQueryJsOnHtml } from './queryJs.js';

/**
 * MCP `_meta` key the Abu client (`src/core/mcp/client.ts`) uses to carry the
 * owning conversation id on every `callTool` request, so a tool handler can
 * read `extra._meta?.[ABU_CONVERSATION_META_KEY]` without the model ever
 * seeing conversationId in the tool's input schema. `client.ts` duplicates
 * this literal (with a comment pointing back here) rather than importing it,
 * since abu-browser-bridge is published to npm separately and isn't a
 * workspace dependency of the desktop app.
 */
export const ABU_CONVERSATION_META_KEY = 'abu/conversationId';

/**
 * MCP `_meta` key that suppresses `get_tabs`' "provision a tab when the caller
 * owns none" behavior, for callers that need a strictly read-only tab listing
 * (the desktop app's browser permission gate resolves the target tab's origin
 * this way, and must not open a tab while deciding whether to allow one).
 * Same `_meta`-not-input-schema and duplication rationale as above.
 */
export const ABU_CREATE_IF_EMPTY_META_KEY = 'abu/createIfEmpty';

/**
 * MCP `_meta` key carrying the SUBAGENT RUN that issued the call, alongside
 * `ABU_CONVERSATION_META_KEY`'s conversation id. Browser tab ownership in the
 * Abu host is the pair `{conversationId, runKey}` (N6) — one conversation can
 * drive the browser from its own loop and from several delegated subagent runs
 * at once, and without the second half they would share one tab pool and one
 * "current tab" and steal each other's pages. Absent ⇒ the conversation's own
 * loop, which the host reads as the run key `main`, so a caller that never
 * sends this key behaves exactly as it did before. Same
 * `_meta`-not-input-schema and duplication rationale as above.
 */
export const ABU_RUN_META_KEY = 'abu/runKey';

export interface BrowserTransportResponse {
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface BrowserTransport {
  send(
    action: string,
    payload?: Record<string, unknown>,
    timeoutMs?: number,
    opts?: { signal?: AbortSignal }
  ): Promise<BrowserTransportResponse>;
  isConnected(): boolean | Promise<boolean>;
  getConnectionError(): string;
  getStatusMessage?(connected: boolean): string;
}

const BROWSER_EXTENSION_NOT_CONNECTED =
  'Browser extension is not connected. Please install and enable the Abu Browser Extension, then check the connection status in the extension popup.';

const chromeWsTransport: BrowserTransport = {
  send: async (action, payload = {}, timeoutMs = 30_000, opts) => {
    const { sendToExtension, isExtensionConnected } = await import('./wsServer.js');
    try {
      return await sendToExtension(action, payload, timeoutMs, opts?.signal);
    } catch (err) {
      if (!isExtensionConnected()) {
        throw new Error(BROWSER_EXTENSION_NOT_CONNECTED, { cause: err });
      }
      throw err;
    }
  },
  isConnected: async () => {
    const { isExtensionConnected } = await import('./wsServer.js');
    return isExtensionConnected();
  },
  getConnectionError: () => BROWSER_EXTENSION_NOT_CONNECTED,
  getStatusMessage: connected =>
    connected
      ? 'Browser extension is connected and ready.'
      : BROWSER_EXTENSION_NOT_CONNECTED,
};

// --- Element Locator Schema (reusable) ---

const LocatorDescription = `How to find the element. Supports multiple strategies:
- { "text": "按钮文字" } — find by visible text content (most common)
- { "css": "#id" } or { "css": ".class" } — find by CSS selector
- { "role": "button", "name": "Submit" } — find by ARIA role
- { "testId": "submit-btn" } — find by data-testid attribute
- { "ref": "e3" } — use reference ID from a previous snapshot
- { "xpath": "//div[@class='x']" } — find by XPath (fallback)`;

// --- Helper ---

async function ensureConnected(transport: BrowserTransport): Promise<void> {
  if (!(await transport.isConnected())) {
    throw new Error(transport.getConnectionError());
  }
}

function metaString(extra: unknown, key: string): string | undefined {
  const meta = (extra as { _meta?: Record<string, unknown> } | undefined)?._meta;
  const value = meta?.[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Pull the calling OWNER — conversation id plus subagent run key — out of a tool
 * handler's `extra` (the MCP SDK's per-request context, `extra._meta?:
 * RequestMeta`), already shaped as the payload fragment every handler merges
 * into its `transport.send()` call, so the `_meta` lookup is not repeated at the
 * 19 call sites below. `extra` is typed as `unknown` here rather than importing
 * the SDK's `RequestHandlerExtra` type, to stay decoupled from its exact shape.
 *
 * Absent keys are OMITTED rather than defaulted: the host owns the "no run id ⇒
 * the conversation's own loop" default, and a payload that never carries the
 * field keeps its exact pre-N6 shape for every caller that sends no run.
 */
function ownerPayloadFromExtra(extra: unknown): Record<string, string> {
  const ownerId = metaString(extra, ABU_CONVERSATION_META_KEY);
  const runId = metaString(extra, ABU_RUN_META_KEY);
  return {
    ...(ownerId ? { ownerId } : {}),
    ...(runId ? { runId } : {}),
  };
}

/**
 * `false` only when the caller explicitly opted out of tab provisioning;
 * `undefined` otherwise, so the payload keeps its historical shape (and the
 * host keeps its create-when-empty default) for every other caller.
 */
function createIfEmptyFromExtra(extra: unknown): false | undefined {
  const meta = (extra as { _meta?: Record<string, unknown> } | undefined)?._meta;
  return meta?.[ABU_CREATE_IF_EMPTY_META_KEY] === false ? false : undefined;
}

/**
 * Pull the per-request `AbortSignal` out of a tool handler's `extra` (the MCP
 * SDK's `RequestHandlerExtra.signal`, set for every request). The SDK fires
 * this when the client sends a `notifications/cancelled` for the request
 * (see B1: the desktop client passes the conversation's abort signal into
 * `callTool`'s SDK options), so a handler that forwards it into
 * `transport.send()` lets an aborted run stop waiting on the extension/host
 * instead of hanging until the tool's own timeout.
 */
function signalFromExtra(extra: unknown): AbortSignal | undefined {
  const signal = (extra as { signal?: unknown } | undefined)?.signal;
  return signal instanceof AbortSignal ? signal : undefined;
}

/**
 * Every handler's `transport.send()` call, with the caller's abort signal
 * always forwarded as the 4th param. Centralized so "pass extra.signal
 * through" isn't repeated (and can't silently drift) at each of the 19 call
 * sites below.
 */
function sendWithSignal(
  transport: BrowserTransport,
  action: string,
  payload: Record<string, unknown>,
  extra: unknown,
  timeoutMs?: number
): Promise<BrowserTransportResponse> {
  return transport.send(action, payload, timeoutMs, { signal: signalFromExtra(extra) });
}

function formatResult(response: BrowserTransportResponse): string {
  if (!response.success) {
    return `Error: ${response.error ?? 'Unknown error'}`;
  }
  if (typeof response.data === 'string') {
    return response.data;
  }
  return JSON.stringify(response.data, null, 2);
}

/**
 * Parse and validate a JSON locator string from LLM input.
 * Ensures the result is a plain object with at least one known locator key.
 */
function parseLocator(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Locator must be a JSON object');
  }
  const validKeys = ['css', 'text', 'tag', 'role', 'name', 'xpath', 'testId', 'ref'];
  const hasValidKey = Object.keys(parsed).some(k => validKeys.includes(k));
  if (!hasValidKey) {
    throw new Error(`Locator must contain at least one of: ${validKeys.join(', ')}`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Parse and validate a JSON wait condition string from LLM input.
 */
function parseCondition(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Condition must be a JSON object');
  }
  const validTypes = ['appear', 'disappear', 'enabled', 'textContains', 'urlContains'];
  if (!validTypes.includes(parsed.type as string)) {
    throw new Error(`Condition type must be one of: ${validTypes.join(', ')}`);
  }
  return parsed as Record<string, unknown>;
}

// --- Register all tools ---

export function registerTools(server: McpServer, transport: BrowserTransport = chromeWsTransport): void {

  // 1. browser_get_tabs
  server.tool(
    'get_tabs',
    'Get all open browser tabs grouped by window. Returns a summary with the current window/tab info, plus a list of windows each containing their tabs. Use this first to find the target tab ID for other browser actions.',
    async (extra) => {
      await ensureConnected(transport);
      const owner = ownerPayloadFromExtra(extra);
      const createIfEmpty = createIfEmptyFromExtra(extra);
      const res = await sendWithSignal(transport, 'get_tabs', {
        ...owner,
        ...(createIfEmpty === false ? { createIfEmpty: false } : {}),
      }, extra);
      return { content: [{ type: 'text' as const, text: formatResult(res) }] };
    }
  );

  // 2. browser_snapshot
  server.tool(
    'snapshot',
    `Get a structured snapshot of all interactive elements on the page (buttons, inputs, links, selects, etc.). Returns each element with a short reference ID (e.g., "e1") that can be used in subsequent actions, plus its \`id\`/\`name\` when the page provides them. Refs stay valid across snapshots for as long as the element stays on the page, so you can snapshot, act, and re-snapshot without re-reading refs you already hold. This is the primary way to understand what's on a page before taking action. If you need to batch-read many DOM nodes, trees, attributes, or tables in one call, use query_js instead of execute_js. If a result says it was truncated, follow the instruction in its message (scope with \`selector\`, or raise \`maxChars\`) rather than switching to execute_js.`,
    {
      tabId: z.coerce.number().describe('Tab ID from get_tabs'),
      selector: z.string().optional().describe('Optional CSS selector to scope the snapshot to a specific area of the page (e.g. the form you are filling). Use this first when a snapshot comes back truncated.'),
      maxChars: z.coerce.number().optional().describe('Maximum serialized size of the element list (default 30000). Raise it if the snapshot is truncated and you cannot scope it with a selector.'),
    },
    async ({ tabId, selector, maxChars }, extra) => {
      await ensureConnected(transport);
      const owner = ownerPayloadFromExtra(extra);
      const res = await sendWithSignal(transport, 'snapshot', { tabId, selector, maxChars, ...owner }, extra);
      return { content: [{ type: 'text' as const, text: formatResult(res) }] };
    }
  );

  // 3. browser_click
  server.tool(
    'click',
    'Click an element on the page. Returns which element was actually hit (ref, tag, id, role, text) — check it is the one you meant before relying on the click. A `text` locator resolves to the innermost matching element, and if several match equally the call fails and lists them so you can pick one by ref. To choose a value from a dropdown use `select` instead — a click only opens it.',
    {
      tabId: z.coerce.number().describe('Tab ID from get_tabs'),
      locator: z.string().describe(`JSON string of element locator. ${LocatorDescription}`),
    },
    async ({ tabId, locator }, extra) => {
      await ensureConnected(transport);
      const parsed = parseLocator(locator);
      const owner = ownerPayloadFromExtra(extra);
      const res = await sendWithSignal(transport, 'click', { tabId, locator: parsed, ...owner }, extra);
      return { content: [{ type: 'text' as const, text: formatResult(res) }] };
    }
  );

  // 4. browser_fill
  server.tool(
    'fill',
    'Fill in a text input, textarea, or other editable field. Clears existing content and types the new value, triggering proper input/change events for framework compatibility (React, Vue, etc.).',
    {
      tabId: z.coerce.number().describe('Tab ID from get_tabs'),
      locator: z.string().describe(`JSON string of element locator. ${LocatorDescription}`),
      value: z.string().describe('The text value to fill into the field'),
    },
    async ({ tabId, locator, value }, extra) => {
      await ensureConnected(transport);
      const parsed = parseLocator(locator);
      const owner = ownerPayloadFromExtra(extra);
      const res = await sendWithSignal(transport, 'fill', { tabId, locator: parsed, value, ...owner }, extra);
      return { content: [{ type: 'text' as const, text: formatResult(res) }] };
    }
  );

  // 5. browser_select
  server.tool(
    'select',
    'Choose a value from a dropdown, in ONE call. Point the locator at the dropdown control itself and pass the option text as `value`. Do NOT click the control open first, and do NOT try to click the option yourself: this tool opens the dropdown, finds the row (scrolling a long list if it has to), clicks it and lets it close. Works with a native <select> and with the custom dropdowns of antd, Element Plus, Arco and similar libraries. If the value is not among the options, the error lists what is actually there — re-issue the call with one of those. Never fall back to execute_js for a dropdown.',
    {
      tabId: z.coerce.number().describe('Tab ID from get_tabs'),
      locator: z.string().describe(`JSON string of element locator. ${LocatorDescription}`),
      value: z.string().describe('The option value or visible text to select'),
    },
    async ({ tabId, locator, value }, extra) => {
      await ensureConnected(transport);
      const parsed = parseLocator(locator);
      const owner = ownerPayloadFromExtra(extra);
      const res = await sendWithSignal(transport, 'select', { tabId, locator: parsed, value, ...owner }, extra);
      return { content: [{ type: 'text' as const, text: formatResult(res) }] };
    }
  );

  // 6. browser_wait_for
  server.tool(
    'wait_for',
    `Wait for a condition to be met on the page. Useful for waiting for elements to appear after a click, waiting for loading to complete, or waiting for page navigation. Returns when the condition is met or times out.`,
    {
      tabId: z.coerce.number().describe('Tab ID from get_tabs'),
      condition: z.string().describe(
        `JSON string of wait condition. Options:
- { "type": "appear", "locator": { "text": "成功" } } — wait for element to appear
- { "type": "disappear", "locator": { "css": ".loading" } } — wait for element to disappear
- { "type": "enabled", "locator": { "text": "提交" } } — wait for element to become clickable
- { "type": "textContains", "locator": { "css": "#status" }, "text": "完成" } — wait for text content
- { "type": "urlContains", "pattern": "/success" } — wait for URL change`
      ),
      timeout: z.coerce.number().optional().default(30000).describe('Maximum wait time in ms (default: 30000)'),
    },
    async ({ tabId, condition, timeout }, extra) => {
      await ensureConnected(transport);
      const parsed = parseCondition(condition);
      const owner = ownerPayloadFromExtra(extra);
      const res = await sendWithSignal(
        transport,
        'wait_for',
        { tabId, condition: parsed, timeout, ...owner },
        extra,
        timeout + 5000
      );
      return { content: [{ type: 'text' as const, text: formatResult(res) }] };
    }
  );

  // 7. browser_extract_text
  server.tool(
    'extract_text',
    'Extract text content from the page or a specific element. Useful for reading content, checking values, or verifying results. For structured batch reads across many nodes, use query_js against the detached read-only DOM copy.',
    {
      tabId: z.coerce.number().describe('Tab ID from get_tabs'),
      selector: z.string().optional().describe('CSS selector to extract text from. If omitted, extracts the full page text (may be large).'),
    },
    async ({ tabId, selector }, extra) => {
      await ensureConnected(transport);
      const owner = ownerPayloadFromExtra(extra);
      const res = await sendWithSignal(transport, 'extract_text', { tabId, selector, ...owner }, extra);
      return { content: [{ type: 'text' as const, text: formatResult(res) }] };
    }
  );

  // 8. browser_extract_table
  server.tool(
    'extract_table',
    'Extract structured data from an HTML table on the page. Returns headers and rows as arrays.',
    {
      tabId: z.coerce.number().describe('Tab ID from get_tabs'),
      selector: z.string().optional().describe('CSS selector for the target table. If omitted, extracts the largest table on the page.'),
    },
    async ({ tabId, selector }, extra) => {
      await ensureConnected(transport);
      const owner = ownerPayloadFromExtra(extra);
      const res = await sendWithSignal(transport, 'extract_table', { tabId, selector, ...owner }, extra);
      return { content: [{ type: 'text' as const, text: formatResult(res) }] };
    }
  );

  // 9. browser_scroll
  server.tool(
    'scroll',
    'Scroll the page or a specific element.',
    {
      tabId: z.coerce.number().describe('Tab ID from get_tabs'),
      direction: z.enum(['up', 'down', 'left', 'right']).describe('Scroll direction'),
      amount: z.coerce.number().optional().default(500).describe('Scroll amount in pixels (default: 500)'),
      selector: z.string().optional().describe('CSS selector for the scrollable element. If omitted, scrolls the whole page.'),
    },
    async ({ tabId, direction, amount, selector }, extra) => {
      await ensureConnected(transport);
      const owner = ownerPayloadFromExtra(extra);
      const res = await sendWithSignal(transport, 'scroll', { tabId, direction, amount, selector, ...owner }, extra);
      return { content: [{ type: 'text' as const, text: formatResult(res) }] };
    }
  );

  // 10. browser_navigate
  server.tool(
    'navigate',
    'Navigate a tab to a specific URL, or go back/forward in history.',
    {
      tabId: z.coerce.number().describe('Tab ID from get_tabs'),
      url: z.string().optional().describe('URL to navigate to. Omit for back/forward.'),
      action: z.enum(['goto', 'back', 'forward', 'reload']).optional().default('goto').describe('Navigation action (default: goto)'),
    },
    async ({ tabId, url, action }, extra) => {
      await ensureConnected(transport);
      const owner = ownerPayloadFromExtra(extra);
      const res = await sendWithSignal(transport, 'navigate', { tabId, url, action, ...owner }, extra);
      return { content: [{ type: 'text' as const, text: formatResult(res) }] };
    }
  );

  // 11. browser_keyboard
  server.tool(
    'keyboard',
    'Send keyboard events to the page. Supports key combinations.',
    {
      tabId: z.coerce.number().describe('Tab ID from get_tabs'),
      key: z.string().describe('Key to press (e.g., "Enter", "Tab", "Escape", "a", "ArrowDown")'),
      modifiers: z.array(z.enum(['ctrl', 'shift', 'alt', 'meta'])).optional().describe('Modifier keys to hold'),
    },
    async ({ tabId, key, modifiers }, extra) => {
      await ensureConnected(transport);
      const owner = ownerPayloadFromExtra(extra);
      const res = await sendWithSignal(transport, 'keyboard', { tabId, key, modifiers, ...owner }, extra);
      return { content: [{ type: 'text' as const, text: formatResult(res) }] };
    }
  );

  // 12. browser_execute_js
  server.tool(
    'execute_js',
    'Execute arbitrary JavaScript in the live page. LAST RESORT: it holds the page\'s full authority, so every single run interrupts the user for its own approval — a task that reaches for it repeatedly is a task the user experiences as broken. For read-only batch DOM work (querySelectorAll, walking trees/tables, collecting text or attributes), use query_js: it runs on a detached inert DOM copy and shows no approval prompt. Before using execute_js, check the tool that already covers what you want: read the page with `snapshot`, `extract_text`, `extract_table`, or `query_js`; wait for something with `wait_for`, whose timeout reports what the page actually looks like; choose from a dropdown with `select`. To confirm an action worked — a toast, a validation error, a redirect — use `wait_for` then `extract_text`, not a live-page script. Read the error a tool returns before switching away from it: it usually names the next step.',
    {
      tabId: z.coerce.number().describe('Tab ID from get_tabs'),
      code: z.string().describe('JavaScript code to execute. The last expression value is returned.'),
    },
    async ({ tabId, code }, extra) => {
      await ensureConnected(transport);
      const owner = ownerPayloadFromExtra(extra);
      const res = await sendWithSignal(transport, 'execute_js', { tabId, code, ...owner }, extra, 60_000);
      return { content: [{ type: 'text' as const, text: formatResult(res) }] };
    }
  );

  // 13. browser_query_js
  server.tool(
    'query_js',
    'Run JavaScript against a detached, inert copy of the page DOM. Reading is fully supported (`querySelectorAll`, `textContent`, attributes, tree/table walks), the real page can never be modified, and no approval prompt is shown. Use this for batch reads that would take many snapshot/extract calls. Not available in the copy: live JS state, computed styles/layout, event dispatch, network, files, or page globals. To interact, use click/fill/select; use execute_js only when the live page itself must run code and the user should approve that single run.',
    {
      tabId: z.coerce.number().optional().describe('Tab ID from get_tabs. If omitted, uses the tab this task last acted on — never whichever tab the user happens to be looking at. Pass one explicitly when this task has no tab of its own yet.'),
      code: z.string().describe('Synchronous JavaScript to evaluate against the detached DOM copy. The completion value is returned as JSON.'),
      selector: z.string().optional().describe('Optional CSS selector to serialize only one subtree before running the query. Use this when the page is large or when you only need one region.'),
    },
    async ({ tabId, code, selector }, extra) => {
      await ensureConnected(transport);
      const owner = ownerPayloadFromExtra(extra);
      const htmlResponse = await sendWithSignal(transport, 'get_html', { tabId, selector, ...owner }, extra);
      if (!htmlResponse.success) {
        throw new Error(htmlResponse.error ?? 'Failed to read page HTML');
      }
      if (typeof htmlResponse.data !== 'string') {
        throw new Error('Browser transport returned invalid HTML for query_js');
      }
      const text = await evaluateQueryJsOnHtml(htmlResponse.data, code);
      return { content: [{ type: 'text' as const, text }] };
    }
  );

  // 14. browser_screenshot
  server.tool(
    'screenshot',
    'Take a screenshot of the visible area of a tab. Returns a base64-encoded PNG image. Useful for visual confirmation of actions.',
    {
      tabId: z.coerce.number().describe('Tab ID from get_tabs'),
    },
    async ({ tabId }, extra) => {
      await ensureConnected(transport);
      const owner = ownerPayloadFromExtra(extra);
      const res = await sendWithSignal(transport, 'screenshot', { tabId, ...owner }, extra);
      if (res.success && typeof res.data === 'string') {
        return {
          content: [{
            type: 'image' as const,
            data: res.data.replace(/^data:image\/png;base64,/, ''),
            mimeType: 'image/png' as const,
          }]
        };
      }
      return { content: [{ type: 'text' as const, text: formatResult(res) }] };
    }
  );

  // 15. browser_screenshot_full_page
  server.tool(
    'screenshot_full_page',
    'Take a full-page screenshot by scrolling and stitching the entire page content. Returns a base64-encoded PNG image of the complete page. Use this when the user asks for a "long screenshot" or wants to capture content beyond the visible viewport. This is slower than a regular screenshot.',
    {
      tabId: z.coerce.number().describe('Tab ID from get_tabs'),
    },
    async ({ tabId }, extra) => {
      await ensureConnected(transport);
      const owner = ownerPayloadFromExtra(extra);
      // Full-page capture needs more time: scroll + multiple captures + stitch
      const res = await sendWithSignal(transport, 'screenshot_full_page', { tabId, ...owner }, extra, 120_000);
      if (res.success && typeof res.data === 'string') {
        return {
          content: [{
            type: 'image' as const,
            data: res.data.replace(/^data:image\/png;base64,/, ''),
            mimeType: 'image/png' as const,
          }]
        };
      }
      return { content: [{ type: 'text' as const, text: formatResult(res) }] };
    }
  );

  // 16. browser_connection_status
  server.tool(
    'connection_status',
    'Check whether the browser transport is connected and ready before performing browser actions.',
    async () => {
      const connected = await transport.isConnected();
      return {
        content: [{
          type: 'text' as const,
          text: transport.getStatusMessage?.(connected) ??
            (connected ? 'Browser transport is connected and ready.' : transport.getConnectionError())
        }]
      };
    }
  );

  // 17. get_downloads — recent download activity
  server.tool(
    'get_downloads',
    'Get recent file downloads from the browser. Useful for confirming that a file was downloaded after clicking a download button.',
    async (extra) => {
      await ensureConnected(transport);
      const owner = ownerPayloadFromExtra(extra);
      const res = await sendWithSignal(transport, 'get_downloads', owner, extra);
      return { content: [{ type: 'text' as const, text: formatResult(res) }] };
    }
  );

  // 18. start_recording — record user interactions
  server.tool(
    'start_recording',
    'Start recording user interactions on a page (clicks, inputs, selects). The user performs actions manually, then call stop_recording to get a list of recorded steps that can be used as an automation template.',
    {
      tabId: z.coerce.number().describe('Tab ID from get_tabs'),
    },
    async ({ tabId }, extra) => {
      await ensureConnected(transport);
      const owner = ownerPayloadFromExtra(extra);
      const res = await sendWithSignal(transport, 'start_recording', { tabId, ...owner }, extra);
      return { content: [{ type: 'text' as const, text: formatResult(res) }] };
    }
  );

  // 19. stop_recording — stop recording and return captured steps
  server.tool(
    'stop_recording',
    'Stop recording user interactions and return the captured steps. Each step includes the action type, element locator, and value. Use these steps as a template to replay the automation.',
    {
      tabId: z.coerce.number().describe('Tab ID from get_tabs'),
    },
    async ({ tabId }, extra) => {
      await ensureConnected(transport);
      const owner = ownerPayloadFromExtra(extra);
      const res = await sendWithSignal(transport, 'stop_recording', { tabId, ...owner }, extra);
      return { content: [{ type: 'text' as const, text: formatResult(res) }] };
    }
  );
}
