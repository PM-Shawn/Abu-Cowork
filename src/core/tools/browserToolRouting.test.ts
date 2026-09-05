/**
 * Every browser tool the bridge registers is routed on BOTH channels.
 *
 * The browser stack keeps the same list in four places and links none of them:
 *
 *   abu-browser-bridge/src/tools.ts        — what the model is offered
 *   abu-chrome-extension/src/background/   — the Chrome extension's router
 *   electron/browserHost.cjs               — the built-in browser's router
 *   src/core/tools/toolPrefetch.ts         — what gets injected into a turn
 *
 * A tool missing from any one of them fails in a way that points nowhere near
 * the cause: an unrouted action answers `Unknown action: find` (which reads to
 * the model as "this tool is broken", and sends it back to scripting the page),
 * while an unprefetched one is simply never offered ("this tool does not
 * exist"). Only the prefetch list had a derived pin, so a probe that registered
 * a new tool and added it nowhere went red in exactly one of the three.
 *
 * This file derives the truth from `registerTools` itself — the handlers are
 * driven with a recording transport, so what is pinned is the wire action each
 * tool actually sends, not a re-typed name — and then checks each channel's own
 * routing source. The extension's list is imported (it is plain data, see
 * `background/contentActions.ts`); `browserHost.cjs` is an Electron main-process
 * module that cannot be imported here, so its routing table is read as text,
 * with anchor assertions so a refactor that breaks the parse fails the test
 * instead of silently passing it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { CONTENT_SCRIPT_ACTIONS } from '../../../abu-chrome-extension/src/background/contentActions.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Arguments good enough to get any handler as far as its `transport.send`.
 *
 * One JSON string satisfies all three of the bridge's parsers at once —
 * `parseLocator` (needs a locator key), `parseFindQuery` (needs a non-empty
 * string key) and `parseCondition` (needs a known `type`) — so a tool added
 * later with any of them still reaches the wire. zod is not enforced here: the
 * fake server hands back the raw handler, so a value that a `z.enum` would
 * reject is passed through untouched, which is all these handlers need.
 */
const ANY_ARG = '{"css":"body","role":"button","type":"appear","locator":{"css":"body"}}';

interface RegisteredTool {
  name: string;
  schema: Record<string, { safeParse(value: unknown): { success: boolean } }> | null;
  handler: (...args: unknown[]) => unknown;
}

/** Tools that legitimately touch no channel — they answer from the bridge. */
const BRIDGE_LOCAL_TOOLS = ['connection_status'];

async function wireActionsByTool(): Promise<Map<string, string[]>> {
  const { registerTools } = await import('../../../abu-browser-bridge/src/tools.js');

  const registered: RegisteredTool[] = [];
  const server = {
    tool: (...args: unknown[]) => {
      registered.push({
        name: args[0] as string,
        schema: (args.length === 4 ? args[2] : null) as RegisteredTool['schema'],
        handler: args[args.length - 1] as RegisteredTool['handler'],
      });
    },
  };

  let sent: string[] = [];
  const transport = {
    isConnected: async () => true,
    // Failing the response on purpose: every handler records its action first
    // and then gives up, so nothing downstream (a query_js worker, a base64
    // screenshot decode) has to run just to learn what was sent.
    send: async (action: string) => { sent.push(action); return { success: false, error: 'recorded' }; },
    getConnectionError: () => 'not connected',
    getStatusMessage: () => 'ok',
  };

  registerTools(
    server as unknown as Parameters<typeof registerTools>[0],
    transport as unknown as Parameters<typeof registerTools>[1],
  );
  expect(registered.length).toBeGreaterThan(15);

  const byTool = new Map<string, string[]>();
  for (const tool of registered) {
    sent = [];
    const args: Record<string, unknown> = {};
    for (const [key, zodType] of Object.entries(tool.schema ?? {})) {
      args[key] = zodType.safeParse(ANY_ARG).success ? ANY_ARG
        : zodType.safeParse(1).success ? 1
          : ANY_ARG;
    }
    try {
      await (tool.schema ? tool.handler(args, {}) : tool.handler({}));
    } catch {
      // The stub response makes most handlers throw once they have sent.
    }
    byTool.set(tool.name, [...sent]);
  }
  return byTool;
}

/** Action names the extension's service worker answers itself. */
function extensionSelfHandledActions(): string[] {
  const source = fs.readFileSync(
    path.join(ROOT, 'abu-chrome-extension/src/background/index.ts'), 'utf8',
  );
  const cases = [...source.matchAll(/case '([a-z_]+)':/g)].map((m) => m[1]);
  // Anchor: if the switch is ever restructured, fail here rather than pass an
  // empty list and declare every channel covered.
  expect(cases).toContain('get_tabs');
  expect(cases).toContain('execute_js');
  return cases;
}

/** Action names `electron/browserHost.cjs` routes, from its own source. */
function builtInBrowserActions(): string[] {
  const source = fs.readFileSync(path.join(ROOT, 'electron/browserHost.cjs'), 'utf8');
  const branches = [...source.matchAll(/action === '([a-z_]+)'/g)].map((m) => m[1]);
  const domActions = /const domActions = new Set\(\[([\s\S]*?)\]\)/.exec(source);
  expect(domActions, 'browserHost.cjs no longer declares `const domActions = new Set([...])`').not.toBeNull();
  const dom = [...domActions![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  expect(dom).toContain('snapshot');
  expect(branches).toContain('navigate');
  return [...branches, ...dom];
}

describe('every registered browser tool reaches a runtime on both channels', () => {
  it('sends exactly one wire action per tool, except the bridge-local ones', async () => {
    const byTool = await wireActionsByTool();

    const silent = [...byTool.entries()].filter(([, actions]) => actions.length === 0).map(([name]) => name);
    // A new tool that reaches no channel is either bridge-local (say so here,
    // deliberately) or broken — either way it must not pass unnoticed.
    expect(silent.sort()).toEqual([...BRIDGE_LOCAL_TOOLS].sort());
  });

  it('routes every wire action through the Chrome extension', async () => {
    const byTool = await wireActionsByTool();
    const selfHandled = new Set(extensionSelfHandledActions());

    const unrouted: string[] = [];
    for (const [tool, actions] of byTool) {
      for (const action of actions) {
        if (!selfHandled.has(action) && !CONTENT_SCRIPT_ACTIONS.has(action)) {
          unrouted.push(`${tool} -> ${action}`);
        }
      }
    }
    expect(unrouted).toEqual([]);
  });

  it('routes every wire action through the built-in Electron browser', async () => {
    const byTool = await wireActionsByTool();
    const routed = new Set(builtInBrowserActions());

    const unrouted: string[] = [];
    for (const [tool, actions] of byTool) {
      for (const action of actions) {
        if (!routed.has(action)) unrouted.push(`${tool} -> ${action}`);
      }
    }
    expect(unrouted).toEqual([]);
  });
});
