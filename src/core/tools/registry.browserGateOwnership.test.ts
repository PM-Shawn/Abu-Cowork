// Regression: the browser permission gate must be able to SEE the tab it is
// gating.
//
// Every agent-opened automation tab is now owned by the conversation that
// opened it, and the host shows a caller only its own tabs plus the legacy
// pool. The gate resolves a tabId-based action's target site by asking the
// same browser server for `get_tabs` — so if that internal call carries no
// conversation id it is a legacy caller, sees no owned tab, and resolves
// `origin = null` for EVERY tabId-based state-changing action. That fails
// open (a site the user explicitly blocked stops being denied), silently
// breaks persistent site grants (the dialog loses its origin and its
// "always allow this site" checkbox), and makes pre-authorized unattended
// runs deny everything.
//
// The fake server below models the host's ownership rule directly: it returns
// the owned tab only to a caller whose request `_meta` names that owner.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkToolApproval } from './registry';
import { mcpManager } from '../mcp/client';
import { useChatStore } from '../../stores/chatStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { __resetBrowserGrantsForTests } from '../permissions/browserToolPolicy';
import type { ToolDefinition } from '../../types';

const OWNER = 'conv-owner';
const OWNED_TAB_ID = 77;

// Mirrors the private `ConnectedServer` shape in client.ts (same injection
// technique as registry.mcpConversationId.test.ts).
interface FakeConnectedServer {
  config: { name: string };
  client: { callTool: ReturnType<typeof vi.fn> };
  transport: unknown;
  tools: Map<string, ToolDefinition>;
}

interface ConfirmInfo {
  command: string;
  browserOrigin?: string;
  allowPersistentGrant?: boolean;
}

function tabsPayload(tabs: Array<{ tabId: number; url: string }>) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ windows: [{ windowId: 1, tabs }] }),
      },
    ],
  };
}

describe('browser permission gate ↔ per-conversation tab ownership', () => {
  let mockCallTool: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Owned-tab visibility, exactly as browserHost.cjs applies it: a caller
    // that sent no owner is legacy and never sees another conversation's tab.
    mockCallTool = vi.fn((params: { _meta?: Record<string, unknown> }) => {
      const owner = params._meta?.['abu/conversationId'];
      if (owner !== OWNER) return Promise.resolve(tabsPayload([]));
      return Promise.resolve(
        tabsPayload([{ tabId: OWNED_TAB_ID, url: 'https://example.com/dashboard' }]),
      );
    });

    const fakeServer: FakeConnectedServer = {
      config: { name: 'abu-browser' },
      client: { callTool: mockCallTool },
      transport: {},
      tools: new Map(),
    };
    (mcpManager as unknown as { servers: Map<string, FakeConnectedServer> }).servers.set(
      'abu-browser',
      fakeServer,
    );

    useChatStore.setState({ conversations: {}, conversationIndex: {}, activeConversationId: null });
    useSettingsStore.setState({ permissionMode: 'standard', browserSitePermissions: {} });
    __resetBrowserGrantsForTests();
  });

  afterEach(() => {
    (mcpManager as unknown as { servers: Map<string, FakeConnectedServer> }).servers.delete(
      'abu-browser',
    );
    __resetBrowserGrantsForTests();
  });

  it('resolves the origin of a tab OWNED by the calling conversation', async () => {
    const asked: ConfirmInfo[] = [];
    const confirm = async (info: ConfirmInfo) => { asked.push(info); return true; };

    const decision = await checkToolApproval(
      'abu-browser__click',
      { tabId: OWNED_TAB_ID, locator: '{"ref":"e1"}' },
      { conversationId: OWNER } as never,
      confirm as never,
    );

    expect(decision.decision).toBe('allow');
    expect(asked).toHaveLength(1);
    // The whole point: an owned tab yields a real origin, so the dialog can
    // show the site and offer the persistent "always allow this site" grant.
    expect(asked[0].browserOrigin).toBe('https://example.com');
    expect(asked[0].allowPersistentGrant).toBe(true);
    expect(asked[0].command).toContain('https://example.com');
  });

  it('sends the conversation id and a non-provisioning flag on its internal get_tabs', async () => {
    await checkToolApproval(
      'abu-browser__click',
      { tabId: OWNED_TAB_ID },
      { conversationId: OWNER } as never,
      (async () => true) as never,
    );

    expect(mockCallTool).toHaveBeenCalledTimes(1);
    expect(mockCallTool.mock.calls[0][0]).toMatchObject({
      name: 'get_tabs',
      _meta: {
        'abu/conversationId': OWNER,
        // A gate query must never provision an automation view: the action it
        // is deciding on may well be denied.
        'abu/createIfEmpty': false,
      },
    });
  });

  it('still DENIES a user-blocked site reached through an owned tab (no fail-open)', async () => {
    mockCallTool.mockImplementation((params: { _meta?: Record<string, unknown> }) =>
      Promise.resolve(
        params._meta?.['abu/conversationId'] === OWNER
          ? tabsPayload([{ tabId: OWNED_TAB_ID, url: 'https://evil.com/transfer' }])
          : tabsPayload([]),
      ),
    );
    useSettingsStore.setState({ browserSitePermissions: { 'https://evil.com': 'denied' } });
    const asked: ConfirmInfo[] = [];
    const confirm = async (info: ConfirmInfo) => { asked.push(info); return true; };

    const decision = await checkToolApproval(
      'abu-browser__click',
      { tabId: OWNED_TAB_ID },
      { conversationId: OWNER } as never,
      confirm as never,
    );

    expect(decision.decision).toBe('deny');
    expect(asked).toHaveLength(0);
  });

  it('lets a pre-authorized unattended run act on an owned tab with no confirmation channel', async () => {
    useSettingsStore.setState({
      browserSitePermissions: { 'https://example.com': 'allowed' },
    });

    const decision = await checkToolApproval(
      'abu-browser__click',
      { tabId: OWNED_TAB_ID },
      { conversationId: OWNER } as never,
      undefined,
    );

    expect(decision.decision).toBe('allow');
  });
});
