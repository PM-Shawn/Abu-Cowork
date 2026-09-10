// P1-a boundary pins for the browser gate in a TEAM conversation.
//
// The site verdict is what actually silences a repeated browser action: the
// gate's `granted` disjunct reads `browserSitePermissions`, and it does so
// with no reference to whether the conversation is a team. That is the whole
// premise of the strip's 「以后都允许该网站」 button, so it is pinned here —
// and so is the thing the button deliberately does NOT do: normalize a port.
//
// Harness mirrors registry.operationPolicy.test.ts (fake abu-browser server
// answering get_tabs, because a browser tool resolves its target through it).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkToolApproval } from './registry';
import { mcpManager } from '../mcp/client';
import { useChatStore } from '../../stores/chatStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useTeamConfirmationStore } from '../../stores/teamConfirmationStore';
import {
  DEFAULT_BROWSER_OPERATION_POLICY,
  __resetBrowserGrantsForTests,
} from '../permissions/browserToolPolicy';

vi.mock('@/core/enterprise/policy/enforcer', () => ({
  getCurrentPolicy: () => ({ mode: 'test-policy' }),
}));
vi.mock('@/core/enterprise/policy/matcher', () => ({
  checkTool: () => ({ decision: 'allow' as const }),
}));

const PAGE_ORIGIN = 'http://127.0.0.1:8765';
const PAGE_URL = `${PAGE_ORIGIN}/form`;
/** Same host, different port — a DIFFERENT origin, and the gate keeps it so. */
const OTHER_PORT_ORIGIN = 'http://127.0.0.1:8792';
const TEAM_CONV = 'team-conv';
const TAB_ID = 42;

let mockCallTool: ReturnType<typeof vi.fn>;

const teamContext = { conversationId: TEAM_CONV, agentName: 'zz填表员', loopId: 'l1', toolCallId: 'call-1' } as never;
const fillInput = { tabId: TAB_ID, locator: { css: '#q' }, value: 'x' };

function setSitePermissions(entries: Record<string, 'allowed' | 'denied'>) {
  useSettingsStore.setState({ browserSitePermissions: entries } as never);
}

describe('browser gate in a team conversation (P1-a)', () => {
  beforeEach(() => {
    mockCallTool = vi.fn((params: { _meta?: Record<string, unknown> }) => Promise.resolve({
      content: [{
        type: 'text',
        text: JSON.stringify(
          params._meta?.['abu/conversationId'] === TEAM_CONV
            ? { windows: [{ windowId: 1, tabs: [{ tabId: TAB_ID, url: PAGE_URL }] }] }
            : { windows: [] },
        ),
      }],
    }));
    (mcpManager as unknown as { servers: Map<string, unknown> }).servers.set('abu-browser', {
      config: { name: 'abu-browser' },
      client: { callTool: mockCallTool },
      transport: {},
      appTools: new Map(),
      tools: new Map(),
    });
    useChatStore.setState({
      conversations: {
        [TEAM_CONV]: { id: TEAM_CONV, title: 't', teamId: 'team-1', createdAt: 1, updatedAt: 1, status: 'running', messages: [] },
      },
      conversationIndex: {},
      activeConversationId: null,
    } as never);
    useTeamConfirmationStore.setState({ pending: {}, approvedOnce: {}, runRules: {}, retrySelections: {} });
    useSettingsStore.setState({
      permissionMode: 'standard',
      browserOperationPolicy: { ...DEFAULT_BROWSER_OPERATION_POLICY, interactive: 'allow' },
      allowUnattendedBrowser: false,
      browserSiteGrantViaEmbed: {},
    } as never);
    setSitePermissions({});
    __resetBrowserGrantsForTests();
  });

  afterEach(() => {
    (mcpManager as unknown as { servers: Map<string, unknown> }).servers.delete('abu-browser');
    __resetBrowserGrantsForTests();
  });

  it('a site the user allowed silences the ask for a team member too', async () => {
    setSitePermissions({ [PAGE_ORIGIN]: 'allowed' });
    const onRequireConfirmation = vi.fn(async () => true);

    const decision = await checkToolApproval('abu-browser__fill', fillInput, teamContext, onRequireConfirmation);

    expect(decision.decision).toBe('allow');
    expect(onRequireConfirmation).not.toHaveBeenCalled();
  });

  it('without that grant the same call still asks — which is what the strip records', async () => {
    const onRequireConfirmation = vi.fn(async () => false);

    await checkToolApproval('abu-browser__fill', fillInput, teamContext, onRequireConfirmation);

    expect(onRequireConfirmation).toHaveBeenCalledTimes(1);
    expect(onRequireConfirmation.mock.calls[0][0]).toMatchObject({
      kind: 'browser',
      browserOrigin: PAGE_ORIGIN,
      allowPersistentGrant: true,
    });
  });

  it('a grant on another port of the same host does NOT cover this page (no port normalization)', async () => {
    setSitePermissions({ [OTHER_PORT_ORIGIN]: 'allowed' });
    const onRequireConfirmation = vi.fn(async () => false);

    await checkToolApproval('abu-browser__fill', fillInput, teamContext, onRequireConfirmation);

    expect(onRequireConfirmation).toHaveBeenCalledTimes(1);
  });
});
