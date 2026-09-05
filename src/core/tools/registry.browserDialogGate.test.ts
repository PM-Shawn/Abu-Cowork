/**
 * The dialog pair at the permission gate — through the REAL entry,
 * `checkToolApproval`.
 *
 * `get_dialog` and `handle_dialog` are deliberately on opposite sides of the
 * gate, and the split is the whole reason they are two tools rather than one
 * `dialog(action?)`: reading what a page asked has to be free, or the model
 * cannot see the thing it is about to be asked to decide, while ANSWERING is
 * pressing the page's own OK button — it submits the form behind the confirm,
 * or leaves the page and discards what is on it.
 *
 * Asserted against the same function the agent loop and the sidecar's
 * `approval.check` call, not against `classifyBrowserTool` underneath it: the
 * classifier could keep answering correctly while the gate stopped consulting
 * it (TESTING §13.3).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkToolApproval } from './registry';
import { mcpManager } from '../mcp/client';
import { useChatStore } from '../../stores/chatStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { __resetBrowserGrantsForTests } from '../permissions/browserToolPolicy';
import type { ToolDefinition } from '../../types';

const OWNER = 'conv-dialog';
const TAB = 41;
const SITE = 'https://erp.example.com';

interface FakeConnectedServer {
  config: { name: string };
  client: { callTool: ReturnType<typeof vi.fn> };
  transport: unknown;
  tools: Map<string, ToolDefinition>;
}

interface ConfirmInfo {
  command: string;
  reason?: string;
  browserOrigin?: string;
  allowPersistentGrant?: boolean;
}

describe('browser permission gate — get_dialog / handle_dialog', () => {
  let asked: ConfirmInfo[];
  let confirm: (info: ConfirmInfo) => Promise<boolean>;

  beforeEach(() => {
    asked = [];
    confirm = async (info) => { asked.push(info); return true; };

    const callTool = vi.fn((params: { _meta?: Record<string, unknown> }) => {
      if (params._meta?.['abu/conversationId'] !== OWNER) {
        return Promise.resolve({ content: [{ type: 'text', text: '{"windows":[]}' }] });
      }
      return Promise.resolve({
        content: [{
          type: 'text',
          text: JSON.stringify({ windows: [{ windowId: 1, tabs: [{ tabId: TAB, url: `${SITE}/form` }] }] }),
        }],
      });
    });
    const fakeServer: FakeConnectedServer = {
      config: { name: 'abu-browser' },
      client: { callTool },
      transport: {},
      tools: new Map(),
    };
    (mcpManager as unknown as { servers: Map<string, FakeConnectedServer> }).servers.set('abu-browser', fakeServer);

    useChatStore.setState({ conversations: {}, conversationIndex: {}, activeConversationId: null });
    useSettingsStore.setState({ permissionMode: 'standard', browserSitePermissions: {} });
    __resetBrowserGrantsForTests();
  });

  afterEach(() => {
    (mcpManager as unknown as { servers: Map<string, FakeConnectedServer> }).servers.delete('abu-browser');
    __resetBrowserGrantsForTests();
  });

  it('lets get_dialog through without asking — reading what the page said is free', async () => {
    const decision = await checkToolApproval(
      'abu-browser__get_dialog',
      { tabId: TAB },
      { conversationId: OWNER } as never,
      confirm as never,
    );

    expect(decision.decision).toBe('allow');
    expect(asked).toEqual([]);
  });

  it('asks before handle_dialog — answering a confirm presses the page\'s own button', async () => {
    const decision = await checkToolApproval(
      'abu-browser__handle_dialog',
      { tabId: TAB, action: 'accept' },
      { conversationId: OWNER } as never,
      confirm as never,
    );

    expect(decision.decision).toBe('allow');
    expect(asked).toHaveLength(1);
    expect(asked[0].browserOrigin).toBe(SITE);
    expect(asked[0].command).toContain('handle_dialog');
    // Ordinary page authority, not scripting: the site may be allowed for it.
    expect(asked[0].allowPersistentGrant).toBe(true);
  });

  it('reading a dialog never mints the grant that answering one would', async () => {
    await checkToolApproval(
      'abu-browser__get_dialog', { tabId: TAB }, { conversationId: OWNER } as never, confirm as never,
    );
    // If `get_dialog` had been classified state-changing and auto-approved,
    // this click would ride a grant nobody was ever asked for.
    const click = await checkToolApproval(
      'abu-browser__click',
      { tabId: TAB, locator: '{"css":"#submit"}' },
      { conversationId: OWNER } as never,
      confirm as never,
    );

    expect(click.decision).toBe('allow');
    expect(asked).toHaveLength(1);
    expect(asked[0].command).toContain('click');
  });

  it('refuses to answer a dialog with nobody to ask, on a site nobody allowed', async () => {
    // An unattended run has no confirmation channel. Answering a page's
    // confirm there would submit a form in the user's logged-in session with
    // no one watching, so the gate fails closed.
    const decision = await checkToolApproval(
      'abu-browser__handle_dialog',
      { tabId: TAB, action: 'accept' },
      { conversationId: OWNER } as never,
      undefined as never,
    );

    expect(decision.decision).toBe('deny');
    expect(decision.reason).toMatch(/^Error:/);

    // Reading it stays available — that is what lets such a run report why it
    // stopped instead of just failing.
    const read = await checkToolApproval(
      'abu-browser__get_dialog', { tabId: TAB }, { conversationId: OWNER } as never, undefined as never,
    );
    expect(read.decision).toBe('allow');
  });

  it('lets a site the user allowed answer its own dialogs unattended', async () => {
    useSettingsStore.setState({ browserSitePermissions: { [SITE]: 'allowed' } });

    const decision = await checkToolApproval(
      'abu-browser__handle_dialog',
      { tabId: TAB, action: 'dismiss' },
      { conversationId: OWNER } as never,
      undefined as never,
    );

    expect(decision.decision).toBe('allow');
  });

  it('keeps a blocked site blocked, dialog or no dialog', async () => {
    useSettingsStore.setState({ browserSitePermissions: { [SITE]: 'denied' } });

    const decision = await checkToolApproval(
      'abu-browser__handle_dialog',
      { tabId: TAB, action: 'accept' },
      { conversationId: OWNER } as never,
      confirm as never,
    );

    expect(decision.decision).toBe('deny');
    expect(asked).toEqual([]);
  });
});
