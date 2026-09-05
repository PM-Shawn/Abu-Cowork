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
/** Money movement (`highRiskSites.ts`) — the page where "press OK for me" is
 *  the most consequential thing this file can authorize. */
const BANK_SITE = 'https://chase.com';

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
  /** What the fake browser host reports the tab is showing. */
  let pageUrl: string;

  /** The click that raises the dialog, approved by the user. */
  const approveAClick = async (): Promise<void> => {
    const click = await checkToolApproval(
      'abu-browser__click',
      { tabId: TAB, locator: '{"css":"#submit"}' },
      { conversationId: OWNER } as never,
      confirm as never,
    );
    expect(click.decision).toBe('allow');
  };

  const answerDialog = (action: 'accept' | 'dismiss' = 'accept') => checkToolApproval(
    'abu-browser__handle_dialog',
    { tabId: TAB, action },
    { conversationId: OWNER } as never,
    confirm as never,
  );

  beforeEach(() => {
    asked = [];
    confirm = async (info) => { asked.push(info); return true; };

    pageUrl = `${SITE}/form`;
    const callTool = vi.fn((params: { _meta?: Record<string, unknown> }) => {
      if (params._meta?.['abu/conversationId'] !== OWNER) {
        return Promise.resolve({ content: [{ type: 'text', text: '{"windows":[]}' }] });
      }
      return Promise.resolve({
        content: [{
          type: 'text',
          text: JSON.stringify({ windows: [{ windowId: 1, tabs: [{ tabId: TAB, url: pageUrl }] }] }),
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

  // ── F2 (2026-09-06 review): answering a dialog is its own consent ────────
  //
  // The sequence this whole feature exists for is: the model clicks 提交, the
  // page raises a confirm, the model answers it. Before this, that click's own
  // approval minted a 30-minute conversation grant, and the `handle_dialog`
  // seconds later rode it — so the user was asked once, about the click, and
  // Abu then pressed the page's own OK button on the strength of that answer.
  // The question on that button was written by the page.

  it('still asks before answering the dialog the approved click raised', async () => {
    await approveAClick();
    expect(asked).toHaveLength(1);

    const decision = await answerDialog('accept');

    expect(decision.decision).toBe('allow');
    expect(asked).toHaveLength(2);
    expect(asked[1].command).toContain('handle_dialog');
    // …and the box says what is actually being agreed to, and who wrote the
    // question. Not a bare tool name.
    expect(asked[1].reason).toBeTruthy();
    expect(asked[1].reason).not.toBe(asked[0].reason);
  });

  it('asks before a beforeunload answer too — leaving the page discards what is on it', async () => {
    await approveAClick();

    expect((await answerDialog('dismiss')).decision).toBe('allow');
    expect(asked).toHaveLength(2);
    expect(asked[1].command).toContain('handle_dialog');
  });

  it('asks again for the NEXT dialog — one answer covers one dialog', async () => {
    await approveAClick();
    await answerDialog('accept');
    await answerDialog('accept');

    expect(asked).toHaveLength(3);
  });

  it('answers silently where the user said so: 「允许」 on a site they always allow', async () => {
    // The 2026-09-04 ruling's lever, the same one scripting rides (R1): a
    // permission the user granted in so many words is granted. The interactive
    // row ships 'allow', so marking the site 始终允许 is the whole opt-in.
    useSettingsStore.setState({ browserSitePermissions: { [SITE]: 'allowed' } });

    const decision = await answerDialog('accept');

    expect(decision.decision).toBe('allow');
    expect(asked).toEqual([]);
  });

  it('mints no conversation grant of its own — one dialog answered is not half an hour of clicking', async () => {
    // The site carries NO standing verdict, so this asks and the user says
    // yes. What they said yes to is "press OK on this confirm" — not "act in
    // my browser for the next thirty minutes", which is what a minted grant
    // would have sold, silently, on the very next click.
    expect((await answerDialog('accept')).decision).toBe('allow');
    expect(asked).toHaveLength(1);
    expect(asked[0].command).toContain('handle_dialog');

    const click = await checkToolApproval(
      'abu-browser__click',
      { tabId: TAB, locator: '{"css":"#next"}' },
      { conversationId: OWNER } as never,
      confirm as never,
    );

    expect(click.decision).toBe('allow');
    expect(asked).toHaveLength(2);
    expect(asked[1].command).toContain('click');
  });

  it('asks on a money-movement page even on a site the user always allows', async () => {
    pageUrl = `${BANK_SITE}/transfer`;
    useSettingsStore.setState({ browserSitePermissions: { [BANK_SITE]: 'allowed' } });

    const decision = await answerDialog('accept');

    expect(decision.decision).toBe('allow');
    expect(asked).toHaveLength(1);
    // …and no standing grant is offered for a bank's confirm boxes.
    expect(asked[0].allowPersistentGrant).toBe(false);
  });

  it('asks every single time under 「每次询问」, allowed site or not', async () => {
    useSettingsStore.setState({
      browserSitePermissions: { [SITE]: 'allowed' },
      browserOperationPolicy: { readOnly: 'allow', interactive: 'ask', scripting: 'ask' },
    });

    await answerDialog('accept');
    await answerDialog('accept');

    expect(asked).toHaveLength(2);
    expect(asked.every((a) => a.allowPersistentGrant === false)).toBe(true);
  });

  it('says the Chrome channel is PRE-ARMING the next dialog, not answering this one', async () => {
    // The extension cannot see a native dialog at all, so `handle_dialog`
    // there is a blind signature on a question nobody has read yet. Same tool
    // name, materially different consent — so a different sentence.
    (mcpManager as unknown as { servers: Map<string, unknown> }).servers.set(
      'abu-browser-bridge',
      (mcpManager as unknown as { servers: Map<string, unknown> }).servers.get('abu-browser')!,
    );
    try {
      await checkToolApproval(
        'abu-browser-bridge__handle_dialog',
        { tabId: TAB, action: 'accept' },
        { conversationId: OWNER } as never,
        confirm as never,
      );
      await answerDialog('accept');

      expect(asked).toHaveLength(2);
      const [viaExtension, viaBuiltin] = asked;
      expect(viaExtension.reason).not.toBe(viaBuiltin.reason);
      expect(viaExtension.reason).toMatch(/60|next/i);
    } finally {
      (mcpManager as unknown as { servers: Map<string, unknown> }).servers.delete('abu-browser-bridge');
    }
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
