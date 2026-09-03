// U7 / G1 + G2 — the browser gate's refusals and the human decisions behind
// them must leave a trace.
//
// Before U7 neither did. A refusal produced a sentence in the run result and a
// diagnostic in the tool result, and NOTHING in the observability buffer — so
// the unattended task report's "blocked actions" section was structurally
// always empty. And the one human decision in the whole unattended path (a
// person typing 同意 into a chat) landed without any record at all.
//
// These cases drive the REAL gate, not a model of it: a signal that is only
// recorded in a helper nobody calls is the same as no signal.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkToolApproval } from './registry';
import { mcpManager } from '../mcp/client';
import { useChatStore } from '../../stores/chatStore';
import { useSettingsStore } from '../../stores/settingsStore';
import {
  DEFAULT_BROWSER_OPERATION_POLICY,
  __resetBrowserGrantsForTests,
} from '../permissions/browserToolPolicy';
import {
  __resetUnattendedConfirmationForTests,
  setUnattendedConfirmationResolver,
} from '../permissions/unattendedConfirmation';
import {
  clearBrowserSignals,
  getRecentBrowserSignals,
  type StoredBrowserSignalRecord,
} from '../observability/browserSignals';

vi.mock('@/core/enterprise/policy/enforcer', () => ({
  getCurrentPolicy: () => ({ mode: 'test-policy' }),
}));
vi.mock('@/core/enterprise/policy/matcher', () => ({
  checkTool: () => ({ decision: 'allow' as const }),
}));

const ALLOWED_SITE = 'https://allowed.com';
const ALLOWED_URL = `${ALLOWED_SITE}/report`;
const UNKNOWN_URL = 'https://unknown.com/report';
const BLOCKED_SITE = 'https://blocked.com';

const unattended = { conversationId: 'run-1', interactionMode: 'background', loopId: 'loop-9' } as never;
const attended = { conversationId: 'conv-1', loopId: 'loop-8' } as never;

let mockCallTool: ReturnType<typeof vi.fn>;

function denials(): Extract<StoredBrowserSignalRecord, { kind: 'gate_denied' }>[] {
  return getRecentBrowserSignals().filter(
    (s): s is Extract<StoredBrowserSignalRecord, { kind: 'gate_denied' }> => s.kind === 'gate_denied',
  );
}
function approvals(): Extract<StoredBrowserSignalRecord, { kind: 'approval' }>[] {
  return getRecentBrowserSignals().filter(
    (s): s is Extract<StoredBrowserSignalRecord, { kind: 'approval' }> => s.kind === 'approval',
  );
}

describe('browser gate — denial and approval signals', () => {
  beforeEach(() => {
    clearBrowserSignals();
    mockCallTool = vi.fn(() => Promise.resolve({
      content: [{ type: 'text', text: JSON.stringify({ windows: [] }) }],
    }));
    (mcpManager as unknown as { servers: Map<string, unknown> }).servers.set('abu-browser', {
      config: { name: 'abu-browser' },
      client: { callTool: mockCallTool },
      transport: {},
      tools: new Map(),
    });
    useChatStore.setState({ conversations: {}, conversationIndex: {}, activeConversationId: null });
    useSettingsStore.setState({
      permissionMode: 'standard',
      browserSitePermissions: { [ALLOWED_SITE]: 'allowed', [BLOCKED_SITE]: 'denied' },
      browserOperationPolicy: DEFAULT_BROWSER_OPERATION_POLICY,
      allowUnattendedBrowser: false,
    });
    __resetBrowserGrantsForTests();
    __resetUnattendedConfirmationForTests();
  });

  afterEach(() => {
    (mcpManager as unknown as { servers: Map<string, unknown> }).servers.delete('abu-browser');
    __resetUnattendedConfirmationForTests();
    __resetBrowserGrantsForTests();
    clearBrowserSignals();
  });

  // ── G1 ──────────────────────────────────────────────────────────────────
  describe('G1: a refusal is recorded', () => {
    it('records the master switch as the reason, with the run mode and tool', async () => {
      const decision = await checkToolApproval(
        'abu-browser__navigate', { tabId: 1, url: ALLOWED_URL }, unattended, (async () => true) as never,
      );
      expect(decision.decision).toBe('deny');

      expect(denials()).toHaveLength(1);
      expect(denials()[0]).toMatchObject({
        kind: 'gate_denied',
        tool: 'abu-browser__navigate',
        opClass: 'interactive',
        reason: 'master-switch-off',
        runMode: 'unattended',
        conversationId: 'run-1',
        loopId: 'loop-9',
      });
    });

    it('records a read-only refusal too — the switch is the whole surface', async () => {
      await checkToolApproval(
        'abu-browser__snapshot', { tabId: 1 }, unattended, (async () => true) as never,
      );
      expect(denials()[0]).toMatchObject({ opClass: 'read-only', reason: 'master-switch-off' });
    });

    it('records a blocked site under its own reason, not the master switch', async () => {
      useSettingsStore.setState({ allowUnattendedBrowser: true });
      await checkToolApproval(
        'abu-browser__navigate', { tabId: 1, url: `${BLOCKED_SITE}/x` }, unattended,
        (async () => true) as never,
      );
      expect(denials().map((d) => d.reason)).toEqual(['site-denied']);
    });

    it('records "no standing grant for this site" separately from a block', async () => {
      useSettingsStore.setState({ allowUnattendedBrowser: true });
      await checkToolApproval(
        'abu-browser__navigate', { tabId: 1, url: UNKNOWN_URL }, unattended,
        (async () => true) as never,
      );
      expect(denials().map((d) => d.reason)).toEqual(['site-not-allowed']);
    });

    it('records an attended dialog the user dismissed, as an attended refusal', async () => {
      const decision = await checkToolApproval(
        'abu-browser__navigate', { tabId: 1, url: UNKNOWN_URL }, attended,
        (async () => false) as never,
      );
      expect(decision.decision).toBe('deny');
      expect(denials()).toHaveLength(1);
      expect(denials()[0]).toMatchObject({
        reason: 'user-cancelled',
        runMode: 'attended',
        loopId: 'loop-8',
      });
    });

    it('records the refusal when there is no confirmation channel at all', async () => {
      const decision = await checkToolApproval(
        'abu-browser__navigate', { tabId: 1, url: UNKNOWN_URL }, attended, undefined,
      );
      expect(decision.decision).toBe('deny');
      expect(denials()[0]).toMatchObject({ reason: 'approval-refused', runMode: 'attended' });
    });

    it('does not record anything when the gate allows the call', async () => {
      const decision = await checkToolApproval(
        'abu-browser__navigate', { tabId: 1, url: ALLOWED_URL }, attended, (async () => true) as never,
      );
      expect(decision.decision).toBe('allow');
      expect(denials()).toHaveLength(0);
    });
  });

  // ── G2 ──────────────────────────────────────────────────────────────────
  describe('G2: the human decision is recorded', () => {
    beforeEach(() => {
      useSettingsStore.setState({
        allowUnattendedBrowser: true,
        browserOperationPolicy: {
          ...DEFAULT_BROWSER_OPERATION_POLICY,
          unattended: { ...DEFAULT_BROWSER_OPERATION_POLICY.unattended, interactive: 'ask' },
        },
      });
    });

    it('records an approval a person actually gave', async () => {
      setUnattendedConfirmationResolver(async () => ({
        approved: true, reason: 'approved over IM', outcome: 'approved', fresh: true,
      }));
      const decision = await checkToolApproval(
        'abu-browser__navigate', { tabId: 1, url: ALLOWED_URL }, unattended, (async () => true) as never,
      );

      expect(decision.decision).toBe('allow');
      expect(approvals()).toHaveLength(1);
      expect(approvals()[0]).toMatchObject({
        kind: 'approval',
        via: 'im',
        outcome: 'approved',
        opClass: 'interactive',
        conversationId: 'run-1',
        loopId: 'loop-9',
      });
    });

    it('records a refusal a person gave, and the gate still refuses', async () => {
      setUnattendedConfirmationResolver(async () => ({
        approved: false, reason: 'denied over IM by the user', outcome: 'declined', fresh: true,
      }));
      const decision = await checkToolApproval(
        'abu-browser__navigate', { tabId: 1, url: ALLOWED_URL }, unattended, (async () => true) as never,
      );

      expect(decision.decision).toBe('deny');
      expect(approvals().map((a) => a.outcome)).toEqual(['declined']);
      // and the refusal itself is still recorded, under the unified taxonomy
      expect(denials().map((d) => d.reason)).toEqual(['approval-refused']);
    });

    it('does NOT count a replayed answer — one 同意 stays one decision', async () => {
      let calls = 0;
      setUnattendedConfirmationResolver(async () => {
        calls++;
        return {
          approved: true,
          reason: 'approved over IM',
          outcome: 'approved' as const,
          // The channel coalesces a chatty tool's calls onto one prompt and
          // replays the answer for the rest of the run.
          fresh: calls === 1,
        };
      });

      for (let i = 0; i < 5; i++) {
        await checkToolApproval(
          'abu-browser__navigate', { tabId: 1, url: ALLOWED_URL }, unattended, (async () => true) as never,
        );
      }

      expect(calls).toBe(5);
      expect(approvals()).toHaveLength(1);
    });

    it('claims no IM decision when no approval channel was involved', async () => {
      // The fail-closed default resolver: it never asked anyone, so it has no
      // human decision to report. Only the gate's own denial is recorded.
      const decision = await checkToolApproval(
        'abu-browser__navigate', { tabId: 1, url: ALLOWED_URL }, unattended, (async () => true) as never,
      );
      expect(decision.decision).toBe('deny');
      expect(approvals()).toHaveLength(0);
      expect(denials().map((d) => d.reason)).toEqual(['approval-refused']);
    });
  });
});
