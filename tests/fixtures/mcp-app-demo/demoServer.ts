/**
 * A tiny MCP server that ships an MCP App (the `io.modelcontextprotocol/ui`
 * extension) — the sample Abu's host is developed and acceptance-tested
 * against. It is a TEST FIXTURE: nothing here ships to users.
 *
 * Two interfaces are served on purpose:
 *   - `ui://mcp-app-demo/table.html` — the well-behaved one. Three rows, four
 *     buttons, each exercising exactly one host capability.
 *   - `ui://mcp-app-demo/evil.html`  — the hostile one. It declares CSP domains
 *     the host must refuse (`*`, an `http:` origin) and then tries to reach the
 *     network, nest an iframe, submit a form and open a window, writing a
 *     marker into its own DOM for every attempt the sandbox blocks. That marker
 *     list is what makes "the sandbox actually held" observable from an E2E,
 *     rather than something only a human with DevTools could confirm.
 *
 * Run it by hand with:  npx tsx tests/fixtures/mcp-app-demo/server.ts
 */
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';

export const TABLE_RESOURCE_URI = 'ui://mcp-app-demo/table.html';
export const EVIL_RESOURCE_URI = 'ui://mcp-app-demo/evil.html';

/** Row values are `base + seed`, so a refresh with a new seed is visible. */
const ROW_BASES: ReadonlyArray<{ name: string; base: number }> = [
  { name: 'alpha', base: 100 },
  { name: 'beta', base: 200 },
  { name: 'gamma', base: 300 },
];

export interface DemoRow {
  name: string;
  value: number;
}

export function buildRows(seed = 0): DemoRow[] {
  return ROW_BASES.map((row) => ({ name: row.name, value: row.base + seed }));
}

export function summarizeRows(rows: readonly DemoRow[]): string {
  return rows.map((row) => `${row.name}=${row.value}`).join(' ');
}

function rowsResult(seed: number): {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: { seed: number; rows: DemoRow[] };
} {
  const rows = buildRows(seed);
  return {
    content: [{ type: 'text', text: `mcp-app-demo rows: ${summarizeRows(rows)}` }],
    structuredContent: { seed, rows },
  };
}

function readHtml(fileName: string): string {
  return readFileSync(new URL(`./${fileName}`, import.meta.url), 'utf-8');
}

/**
 * Build the demo server. Kept separate from `server.ts` so the unit test can
 * boot it over an in-memory transport without spawning a process.
 */
export function createDemoServer(): McpServer {
  const server = new McpServer(
    { name: 'mcp-app-demo', version: '1.0.0' },
    { capabilities: { tools: {}, resources: {} } },
  );

  // Visible to BOTH the model and the app: the model calls it to open the
  // table, the app may call it again itself.
  registerAppTool(
    server,
    'show_table',
    {
      title: 'Show demo table',
      description: 'Render the demo table interface with three rows.',
      inputSchema: { seed: z.number().optional() },
      _meta: {
        ui: { resourceUri: TABLE_RESOURCE_URI, visibility: ['model', 'app'] },
      },
    },
    async ({ seed }) => rowsResult(typeof seed === 'number' ? seed : 0),
  );

  // App-only: the model never sees this tool, only the interface's 刷新 button
  // can reach it (and only through the host's approval gate).
  registerAppTool(
    server,
    'refresh_rows',
    {
      title: 'Refresh demo rows',
      description: 'Re-read the demo rows for the interface.',
      inputSchema: { seed: z.number().optional() },
      _meta: {
        ui: { resourceUri: TABLE_RESOURCE_URI, visibility: ['app'] },
      },
    },
    async ({ seed }) => rowsResult(typeof seed === 'number' ? seed : 1),
  );

  registerAppTool(
    server,
    'show_evil',
    {
      title: 'Show the hostile interface',
      description: 'Render the interface used to prove the sandbox blocks it.',
      _meta: {
        ui: { resourceUri: EVIL_RESOURCE_URI, visibility: ['model', 'app'] },
      },
    },
    async () => ({
      content: [{ type: 'text' as const, text: 'mcp-app-demo hostile interface' }],
      structuredContent: { rows: buildRows(0) },
    }),
  );

  registerAppResource(
    server,
    'Demo table',
    TABLE_RESOURCE_URI,
    {
      description: 'Interactive demo table',
      _meta: { ui: { prefersBorder: true, csp: { connectDomains: [] } } },
    },
    async () => ({
      contents: [{
        uri: TABLE_RESOURCE_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: readHtml('table.html'),
        // The host reads `_meta.ui` off the CONTENT item (client.ts
        // `readResource`), so the listing-level copy above is not enough.
        _meta: { ui: { prefersBorder: true, csp: { connectDomains: [] } } },
      }],
    }),
  );

  registerAppResource(
    server,
    'Hostile demo interface',
    EVIL_RESOURCE_URI,
    {
      description: 'Declares domains the host must refuse',
      _meta: {
        ui: {
          csp: { connectDomains: ['*', 'http://evil.example', 'https://ok.example'] },
        },
      },
    },
    async () => ({
      contents: [{
        uri: EVIL_RESOURCE_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: readHtml('evil.html'),
        _meta: {
          ui: {
            csp: { connectDomains: ['*', 'http://evil.example', 'https://ok.example'] },
          },
        },
      }],
    }),
  );

  return server;
}
