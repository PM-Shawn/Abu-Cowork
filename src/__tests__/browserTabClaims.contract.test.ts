import { describe, expect, it } from 'vitest';
import { registerTools } from '../../abu-browser-bridge/src/tools';
import { TAB_TARGETED_ACTIONS } from '../../abu-chrome-extension/src/background/tabClaims';

// Derive wire actions from the handlers actually registered for Chrome,
// not every backend's source code. A tab-targeted wire action without an
// extension ownership check must still fail this cross-channel contract.
describe('TAB_TARGETED_ACTIONS', () => {
  /** Every `sendWithSignal(transport, '<action>', { … })` whose payload names a tabId. */
  function bridgeActionsCarryingTabId(source: string): string[] {
    const found = new Set<string>();
    const marker = 'sendWithSignal(';
    for (let at = source.indexOf(marker); at >= 0; at = source.indexOf(marker, at + 1)) {
      const rest = source.slice(at + marker.length);
      const head = /^\s*transport\s*,\s*['"]([a-z_]+)['"]\s*,\s*/.exec(rest);
      if (!head) continue; // the helper's own definition, or a non-literal call
      const payloadStart = rest.slice(head[0].length);
      if (payloadStart[0] !== '{') continue; // payload is not an object literal
      let depth = 0;
      let end = -1;
      for (let i = 0; i < payloadStart.length; i += 1) {
        if (payloadStart[i] === '{') depth += 1;
        else if (payloadStart[i] === '}') {
          depth -= 1;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      if (end < 0) continue;
      if (/\btabId\b/.test(payloadStart.slice(0, end + 1))) found.add(head[1]);
    }
    return Array.from(found).sort();
  }

  it("matches the bridge's own list of tab-targeted tools", () => {
    const handlers: Array<(...args: unknown[]) => unknown> = [];
    const names: string[] = [];
    const server = { tool(name: string, ...args: unknown[]) {
      names.push(name);
      handlers.push(args.at(-1) as (...args: unknown[]) => unknown);
    } };
    // Register the real default Chrome surface, with no socket or network.
    registerTools(server as unknown as Parameters<typeof registerTools>[0], {
      isConnected: async () => true,
      send: async () => { throw new Error('registration must not execute tools'); },
      getConnectionError: () => 'not connected',
    });
    expect(names).not.toContain('close_tab');
    expect(names).not.toContain('create_tab');
    const fromBridge = bridgeActionsCarryingTabId(handlers.map(String).join('\n'));

    // Sanity check on the parser itself: a silent zero here would make the
    // comparison below vacuous.
    expect(fromBridge.length).toBeGreaterThan(10);
    expect(Array.from(TAB_TARGETED_ACTIONS).sort()).toEqual(fromBridge);
    // …and the two that name no tab stay out of it.
    expect(TAB_TARGETED_ACTIONS.has('get_tabs')).toBe(false);
    expect(TAB_TARGETED_ACTIONS.has('get_downloads')).toBe(false);
  });
});
