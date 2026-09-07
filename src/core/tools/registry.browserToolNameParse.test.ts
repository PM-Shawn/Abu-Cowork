// U9 / C1 — the authorization layer and the dispatcher must agree about which
// tool a namespaced name names.
//
// The defect these cases pin: `classifyBrowserTool` sliced from the FIRST
// `__` and kept the rest as the tool name, so `abu-browser__execute_js__x`
// was the *unknown* tool `execute_js__x` and took the `'interactive'`
// fallback; `executeAnyTool`'s dispatcher parsed the same string with
// `split('__', 2)`, whose limit-2 truncation DISCARDS the suffix, and really
// called `execute_js`. One string, "a click" at the door and arbitrary page
// script inside it — with no test anywhere in the repo using a suffixed name.
//
// Harness mirrors registry.mcpConversationId.test.ts / registry.browserOriginPin.test.ts:
// a fake ConnectedServer injected into the real mcpManager singleton.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkToolApproval, executeAnyTool } from './registry';
import { mcpManager } from '../mcp/client';
import { useChatStore } from '../../stores/chatStore';
import { useSettingsStore } from '../../stores/settingsStore';
import {
  DEFAULT_BROWSER_OPERATION_POLICY,
  __resetBrowserGrantsForTests,
  grantBrowserAutomation,
  type BrowserOperationPolicy,
} from '../permissions/browserToolPolicy';
import {
  __resetUnattendedConfirmationForTests,
  setUnattendedConfirmationResolver,
} from '../permissions/unattendedConfirmation';
import { BROWSER_TOOL_SUFFIXES } from './toolPrefetch';

vi.mock('@/core/enterprise/policy/enforcer', () => ({
  getCurrentPolicy: () => ({ mode: 'test-policy' }),
}));
vi.mock('@/core/enterprise/policy/matcher', () => ({
  checkTool: () => ({ decision: 'allow' as const }),
}));

const ALLOWED_SITE = 'https://allowed.com';
const ALLOWED_URL = `${ALLOWED_SITE}/report`;
const OWNER = 'run-owner';
const OWNED_TAB_ID = 77;
const SERVERS = ['abu-browser', 'abu-browser-bridge'] as const;

interface FakeConnectedServer {
  config: { name: string };
  client: { callTool: ReturnType<typeof vi.fn> };
  transport: unknown;
  tools: Map<string, never>;
}

let mockCallTool: ReturnType<typeof vi.fn>;

/** Both browser servers answer `get_tabs` with the owned tab; anything else
 *  answers `'ok'` — so "did the suffixed name reach the server?" is exactly
 *  "was callTool invoked with that tool name?". */
function serveTabs(url: string): void {
  mockCallTool.mockImplementation((params: { name: string; _meta?: Record<string, unknown> }) => {
    if (params.name === 'get_tabs') {
      return Promise.resolve({
        content: [{
          type: 'text',
          text: JSON.stringify(
            params._meta?.['abu/conversationId'] === OWNER
              ? { windows: [{ windowId: 1, tabs: [{ tabId: OWNED_TAB_ID, url }] }] }
              : { windows: [] },
          ),
        }],
      });
    }
    return Promise.resolve({ content: [{ type: 'text', text: 'ok' }] });
  });
}

/** Every tool name the fake server was actually asked to run. */
function dispatchedToolNames(): string[] {
  return mockCallTool.mock.calls.map((c) => (c[0] as { name: string }).name);
}

const attendedOwner = { conversationId: OWNER } as never;
const unattendedOwner = { conversationId: OWNER, interactionMode: 'background' } as never;

/** The default policy with ONE row overridden. There is no column argument
 *  since the 2026-09-04 collapse: both execution contexts read this value. */
function policyWith(
  cell: keyof BrowserOperationPolicy,
  state: 'allow' | 'deny' | 'ask',
): BrowserOperationPolicy {
  return { ...DEFAULT_BROWSER_OPERATION_POLICY, [cell]: state };
}

describe('namespaced tool-name parse: gate and dispatcher agree (U9 C1)', () => {
  beforeEach(() => {
    mockCallTool = vi.fn();
    serveTabs(ALLOWED_URL);
    for (const server of SERVERS) {
      const fakeServer: FakeConnectedServer = {
        config: { name: server },
        client: { callTool: mockCallTool },
        transport: {},
        tools: new Map(),
      };
      (mcpManager as unknown as { servers: Map<string, FakeConnectedServer> }).servers.set(
        server,
        fakeServer,
      );
    }
    useChatStore.setState({ conversations: {}, conversationIndex: {}, activeConversationId: null });
    useSettingsStore.setState({
      permissionMode: 'standard',
      browserSitePermissions: { [ALLOWED_SITE]: 'allowed' },
      browserOperationPolicy: DEFAULT_BROWSER_OPERATION_POLICY,
      allowUnattendedBrowser: true,
    });
    __resetBrowserGrantsForTests();
    __resetUnattendedConfirmationForTests();
  });

  afterEach(() => {
    for (const server of SERVERS) {
      (mcpManager as unknown as { servers: Map<string, unknown> }).servers.delete(server);
    }
    __resetBrowserGrantsForTests();
    __resetUnattendedConfirmationForTests();
  });

  describe('the whole class, not just execute_js', () => {
    const MALFORMED_SUFFIXES = ['__x', '__', '__a__b'];
    const CASES: Array<[string, string, string]> = SERVERS.flatMap((server) =>
      BROWSER_TOOL_SUFFIXES.flatMap((tool) =>
        MALFORMED_SUFFIXES.map((suffix) => [server, tool, suffix] as [string, string, string]),
      ),
    );

    it.each(CASES)(
      '%s__%s%s never reaches the server — fail-closed like an unknown builtin',
      async (server, tool, suffix) => {
        const name = `${server}__${tool}${suffix}`;

        const result = await executeAnyTool(
          name, { tabId: OWNED_TAB_ID, code: 'fetch("/transfer")' },
          (async () => true) as never, undefined, attendedOwner,
        );

        expect(result).toBe(`Error: Unknown tool "${name}"`);
        // The truncated name must never have been dispatched. `get_tabs` is
        // allowed here: it is the gate's own origin probe, not this call.
        expect(dispatchedToolNames().filter((n) => n !== 'get_tabs')).toEqual([]);
      },
    );

    it('still dispatches the well-formed names exactly as before', async () => {
      const result = await executeAnyTool(
        'abu-browser__snapshot', { tabId: OWNED_TAB_ID },
        (async () => true) as never, undefined, attendedOwner,
      );

      expect(result).toBe('ok');
      expect(dispatchedToolNames()).toContain('snapshot');
    });

    it('a non-browser MCP server keeps working', async () => {
      const other: FakeConnectedServer = {
        config: { name: 'other-server' },
        client: { callTool: mockCallTool },
        transport: {},
        tools: new Map(),
      };
      (mcpManager as unknown as { servers: Map<string, FakeConnectedServer> }).servers.set(
        'other-server', other,
      );
      try {
        const result = await executeAnyTool('other-server__do_thing', {}, undefined, undefined, attendedOwner);
        expect(result).toBe('ok');
        expect(dispatchedToolNames()).toContain('do_thing');
      } finally {
        (mcpManager as unknown as { servers: Map<string, unknown> }).servers.delete('other-server');
      }
    });
  });

  // The reachable-without-any-unattended-configuration half of the Critical:
  // `registry.ts`'s attended branch asked `isScriptingBrowserTool(name)`,
  // which said false for the suffixed name, so `granted` could be satisfied by
  // the 30-minute conversation grant and `decideOtherTool` returned allow —
  // arbitrary page JS with no dialog, directly contradicting the comment three
  // lines above it ("must ride neither the conversation grant nor a site
  // grant"). Trigger condition: one ordinary browser click approved in the
  // last 30 minutes.
  describe('attended, with a live 30-minute conversation grant', () => {
    it('does not silently run suffixed execute_js on the strength of a click grant', async () => {
      grantBrowserAutomation(OWNER);
      const confirm = vi.fn(async () => true);

      const result = await executeAnyTool(
        'abu-browser__execute_js__x', { tabId: OWNED_TAB_ID, code: 'document.cookie' },
        confirm as never, undefined, attendedOwner,
      );

      expect(dispatchedToolNames()).not.toContain('execute_js');
      expect(result).toBe('Error: Unknown tool "abu-browser__execute_js__x"');
    });

    it('control: the well-formed execute_js still asks, grant or no grant', async () => {
      grantBrowserAutomation(OWNER);
      const confirm = vi.fn(async () => true);

      await executeAnyTool(
        'abu-browser__execute_js', { tabId: OWNED_TAB_ID, code: 'document.cookie' },
        confirm as never, undefined, attendedOwner,
      );

      expect(confirm).toHaveBeenCalledTimes(1);
      expect(dispatchedToolNames()).toContain('execute_js');
    });
  });

  // The unattended half. Reachability is narrower than it first looks: the
  // scheduled path is defended by `runPermissionCeiling`'s EXACT-STRING
  // roster, which a suffixed name is not on. What is actually reachable is a
  // trigger or IM channel configured at the `full` tier, which the ceiling
  // waves through unconditionally — and that is the target configuration for
  // the unattended browser feature.
  describe('unattended at the full tier', () => {
    it('does not run suffixed execute_js through the interactive cell', async () => {
      useSettingsStore.setState({
        browserOperationPolicy: policyWith('interactive', 'allow'),
      });

      const result = await executeAnyTool(
        'abu-browser__execute_js__x', { tabId: OWNED_TAB_ID, code: 'fetch("/transfer")' },
        (async () => true) as never, undefined, unattendedOwner,
      );

      expect(dispatchedToolNames()).not.toContain('execute_js');
      expect(result).toBe('Error: Unknown tool "abu-browser__execute_js__x"');
    });
  });

  // Two secondary effects of the same misclassification, each on its own.
  // Both live inside the browser block and are fed by `opClass`, so a name the
  // gate calls "a click" poisons them both.
  describe('secondary effect 1 — the denial taxonomy', () => {
    it('never reports a suffixed execute_js refusal as the weaker "other" kind', async () => {
      useSettingsStore.setState({
        browserOperationPolicy: policyWith('interactive', 'ask'),
      });
      setUnattendedConfirmationResolver(async () => ({
        approved: false,
        reason: 'declined in chat',
        audit: { outcome: 'declined', fresh: true },
      }));
      const reportBrowserDenial = vi.fn();

      await checkToolApproval(
        'abu-browser__execute_js__x', { tabId: OWNED_TAB_ID, code: '1' },
        { ...(unattendedOwner as object), reportBrowserDenial } as never,
        (async () => true) as never,
      );

      // Before the fix this was called with 'other' — a scripting refusal
      // filed under the bucket a later click grant is allowed to clear.
      expect(reportBrowserDenial).not.toHaveBeenCalledWith('other');
    });

    it('control: the well-formed execute_js refusal is filed as scripting', async () => {
      useSettingsStore.setState({
        browserOperationPolicy: policyWith('scripting', 'ask'),
      });
      setUnattendedConfirmationResolver(async () => ({
        approved: false,
        reason: 'declined in chat',
        audit: { outcome: 'declined', fresh: true },
      }));
      const reportBrowserDenial = vi.fn();

      await checkToolApproval(
        'abu-browser__execute_js', { tabId: OWNED_TAB_ID, code: '1' },
        { ...(unattendedOwner as object), reportBrowserDenial } as never,
        (async () => true) as never,
      );

      expect(reportBrowserDenial).toHaveBeenCalledWith('scripting');
    });
  });

  describe('secondary effect 2 — a click-grade grant clearing a scripting streak', () => {
    it('a suffixed execute_js never reports a grant-consented allow', async () => {
      useSettingsStore.setState({
        browserOperationPolicy: policyWith('interactive', 'allow'),
      });
      const reportBrowserAllow = vi.fn();

      await checkToolApproval(
        'abu-browser__execute_js__x', { tabId: OWNED_TAB_ID, code: '1' },
        { ...(unattendedOwner as object), reportBrowserAllow } as never,
        (async () => true) as never,
      );

      // U4 Ruling I1's whole point: a grant minted from approving a CLICK must
      // not clear a scripting refusal. Before the fix the gate handed the
      // tracker a 'grant' for an execute_js call, which is that rule being fed
      // false information about what just happened.
      expect(reportBrowserAllow).not.toHaveBeenCalled();
    });

    it('control: a real interactive action on an allowed site still reports its grant', async () => {
      const reportBrowserAllow = vi.fn();

      await checkToolApproval(
        'abu-browser__click', { tabId: OWNED_TAB_ID },
        { ...(unattendedOwner as object), reportBrowserAllow } as never,
        (async () => true) as never,
      );

      expect(reportBrowserAllow).toHaveBeenCalledWith('grant');
    });
  });
});
