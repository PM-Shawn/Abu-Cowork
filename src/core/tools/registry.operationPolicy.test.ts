// The browser gate under the operation-class policy (batch-二 §二).
//
// Two columns, three classes, one master switch. The attended column must
// behave EXACTLY as it shipped — that column's regressions are covered by
// `registry.permissionMode.test.ts` and `registry.browserGateOwnership.test.ts`,
// which this change left untouched on purpose; the cases below pin the parts
// those files cannot see: the unattended column, the master switch, the
// cross-origin fail-closed baseline, and the confirmation seam that stands in
// for a human who is not there.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkToolApproval } from './registry';
import { useChatStore } from '../../stores/chatStore';
import { useSettingsStore } from '../../stores/settingsStore';
import {
  DEFAULT_BROWSER_OPERATION_POLICY,
  __resetBrowserGrantsForTests,
  type BrowserOperationPolicy,
} from '../permissions/browserToolPolicy';
import {
  __resetUnattendedConfirmationForTests,
  setUnattendedConfirmationResolver,
} from '../permissions/unattendedConfirmation';
import { buildScheduledRunPermissionCeiling } from '../permissions/runPermissionCeiling';

const policyMocks = vi.hoisted(() => ({
  checkTool: vi.fn(() => ({ decision: 'allow' as const })),
}));

vi.mock('@/core/enterprise/policy/enforcer', () => ({
  getCurrentPolicy: () => ({ mode: 'test-policy' }),
}));

vi.mock('@/core/enterprise/policy/matcher', () => ({
  checkTool: (...args: unknown[]) => policyMocks.checkTool(...args),
}));

const ALLOWED_SITE = 'https://allowed.com';
const ALLOWED_URL = `${ALLOWED_SITE}/report`;
const UNKNOWN_URL = 'https://unknown.com/report';

/** An unattended tool context: the flag the agent loop derives for scheduled /
 *  trigger / IM runs. */
const unattended = { conversationId: 'run-1', interactionMode: 'background' } as never;
/** An attended one — no provenance at all, which is what a chat turn carries. */
const attended = { conversationId: 'conv-1' } as never;

function policyWith(
  column: 'attended' | 'unattended',
  cell: keyof BrowserOperationPolicy['attended'],
  state: 'allow' | 'deny' | 'ask',
): BrowserOperationPolicy {
  return {
    ...DEFAULT_BROWSER_OPERATION_POLICY,
    [column]: { ...DEFAULT_BROWSER_OPERATION_POLICY[column], [cell]: state },
  };
}

describe('browser gate — operation-class policy', () => {
  beforeEach(() => {
    useChatStore.setState({ conversations: {}, conversationIndex: {}, activeConversationId: null });
    useSettingsStore.setState({
      permissionMode: 'standard',
      browserSitePermissions: { [ALLOWED_SITE]: 'allowed' },
      browserOperationPolicy: DEFAULT_BROWSER_OPERATION_POLICY,
      allowUnattendedBrowser: false,
    });
    __resetBrowserGrantsForTests();
    __resetUnattendedConfirmationForTests();
  });

  afterEach(() => {
    __resetUnattendedConfirmationForTests();
    __resetBrowserGrantsForTests();
  });

  describe('master switch (default: off)', () => {
    it('denies an unattended interactive action even on an allowed site, and says why', async () => {
      const decision = await checkToolApproval(
        'abu-browser__navigate', { tabId: 1, url: ALLOWED_URL }, unattended, (async () => true) as never,
      );

      expect(decision.decision).toBe('deny');
      expect(decision.reason).toContain('Settings');
    });

    it('denies unattended READ-ONLY browser tools too — the switch is the whole surface', async () => {
      const decision = await checkToolApproval(
        'abu-browser__snapshot', { tabId: 1 }, unattended, (async () => true) as never,
      );

      expect(decision.decision).toBe('deny');
    });

    it('denies unattended scripting', async () => {
      const decision = await checkToolApproval(
        'abu-browser__execute_js', { tabId: 1, code: 'fetch("/transfer")' }, unattended, (async () => true) as never,
      );

      expect(decision.decision).toBe('deny');
    });

    it('changes nothing for an attended run — the switch is unattended-only', async () => {
      const asked: string[] = [];
      const decision = await checkToolApproval(
        'abu-browser__navigate', { tabId: 1, url: UNKNOWN_URL }, attended,
        (async (info: { command: string }) => { asked.push(info.command); return true; }) as never,
      );

      expect(decision.decision).toBe('allow');
      expect(asked).toHaveLength(1);
    });

    it('never consults the run\'s confirmation callback when the switch is off', async () => {
      const confirm = vi.fn(async () => true);
      await checkToolApproval(
        'abu-browser__navigate', { tabId: 1, url: ALLOWED_URL }, unattended, confirm as never,
      );

      expect(confirm).not.toHaveBeenCalled();
    });
  });

  describe('master switch on', () => {
    beforeEach(() => {
      useSettingsStore.setState({ allowUnattendedBrowser: true });
    });

    it('lets an unattended interactive action run on an ALLOWED site, unprompted', async () => {
      const confirm = vi.fn(async () => true);
      const decision = await checkToolApproval(
        'abu-browser__navigate', { tabId: 1, url: ALLOWED_URL }, unattended, confirm as never,
      );

      expect(decision.decision).toBe('allow');
      expect(confirm).not.toHaveBeenCalled();
    });

    it('denies the same action on a site with no standing grant (cross-origin fail-closed)', async () => {
      const decision = await checkToolApproval(
        'abu-browser__navigate', { tabId: 1, url: UNKNOWN_URL }, unattended, (async () => true) as never,
      );

      expect(decision.decision).toBe('deny');
      expect(decision.reason).toContain('unattended');
    });

    it('still denies scripting — the unattended column denies it by default, allowed site or not', async () => {
      const decision = await checkToolApproval(
        'abu-browser__execute_js', { tabId: 1, url: ALLOWED_URL, code: '1' }, unattended, (async () => true) as never,
      );

      expect(decision.decision).toBe('deny');
    });

    it('lets read-only browser tools run', async () => {
      const decision = await checkToolApproval(
        'abu-browser__snapshot', { tabId: 1 }, unattended, (async () => true) as never,
      );

      expect(decision.decision).toBe('allow');
    });

    it('a blocked site still wins over everything', async () => {
      useSettingsStore.setState({
        browserSitePermissions: { 'https://evil.com': 'denied' },
        browserOperationPolicy: policyWith('unattended', 'interactive', 'allow'),
      });

      const decision = await checkToolApproval(
        'abu-browser__navigate', { tabId: 1, url: 'https://evil.com/x' }, unattended, (async () => true) as never,
      );

      expect(decision.decision).toBe('deny');
    });

    it('a policy cell set to deny stops the class outright', async () => {
      useSettingsStore.setState({
        browserOperationPolicy: policyWith('unattended', 'interactive', 'deny'),
      });

      const decision = await checkToolApproval(
        'abu-browser__navigate', { tabId: 1, url: ALLOWED_URL }, unattended, (async () => true) as never,
      );

      expect(decision.decision).toBe('deny');
    });
  });

  describe('unattended "ask" routes through the confirmation seam, not the run callback', () => {
    beforeEach(() => {
      useSettingsStore.setState({
        allowUnattendedBrowser: true,
        browserOperationPolicy: policyWith('unattended', 'interactive', 'ask'),
      });
    });

    it('fails closed by default — there is no approval channel yet', async () => {
      const confirm = vi.fn(async () => true);
      const decision = await checkToolApproval(
        'abu-browser__navigate', { tabId: 1, url: ALLOWED_URL }, unattended, confirm as never,
      );

      expect(decision.decision).toBe('deny');
      // The entry point's own callback must never be the thing that answers an
      // unattended approval: an IM `full` tier's auto-approve would otherwise
      // rubber-stamp it.
      expect(confirm).not.toHaveBeenCalled();
    });

    it('an installed resolver can approve, and the action then still needs its site grant', async () => {
      setUnattendedConfirmationResolver(async () => ({ approved: true, reason: 'approved in chat' }));

      const allowedSite = await checkToolApproval(
        'abu-browser__navigate', { tabId: 1, url: ALLOWED_URL }, unattended, undefined,
      );
      const unknownSite = await checkToolApproval(
        'abu-browser__navigate', { tabId: 1, url: UNKNOWN_URL }, unattended, undefined,
      );

      expect(allowedSite.decision).toBe('allow');
      expect(unknownSite.decision).toBe('deny');
    });

    it('a resolver that throws is a refusal, not an opening', async () => {
      setUnattendedConfirmationResolver(async () => { throw new Error('IM offline'); });

      const decision = await checkToolApproval(
        'abu-browser__navigate', { tabId: 1, url: ALLOWED_URL }, unattended, undefined,
      );

      expect(decision.decision).toBe('deny');
    });

    it('receives the operation class and origin so an approval prompt can describe the ask', async () => {
      const seen: Array<{ opClass?: string; origin?: string; source: string }> = [];
      setUnattendedConfirmationResolver(async (request) => {
        seen.push({
          ...(request.info.browserOperationClass !== undefined
            ? { opClass: request.info.browserOperationClass }
            : {}),
          ...(request.info.browserOrigin !== undefined ? { origin: request.info.browserOrigin } : {}),
          source: request.source,
        });
        return { approved: false, reason: 'no' };
      });

      await checkToolApproval(
        'abu-browser__navigate', { tabId: 1, url: ALLOWED_URL }, unattended, undefined,
      );

      expect(seen).toEqual([
        { opClass: 'interactive', origin: ALLOWED_SITE, source: 'im' },
      ]);
    });
  });

  describe('run-mode derivation', () => {
    it('treats a run carrying a permission ceiling as unattended even without interactionMode', async () => {
      useSettingsStore.setState({ allowUnattendedBrowser: false });

      const decision = await checkToolApproval(
        'abu-browser__navigate', { tabId: 1, url: ALLOWED_URL },
        {
          conversationId: 'run-2',
          runPermissionCeiling: buildScheduledRunPermissionCeiling(['abu-browser__navigate']),
        } as never,
        (async () => true) as never,
      );

      expect(decision.decision).toBe('deny');
    });

    it('treats a scheduled-task conversation as unattended even without interactionMode', async () => {
      useChatStore.setState({
        conversations: {
          'run-3': { id: 'run-3', scheduledTaskId: 'task-9' },
        } as never,
      });

      const decision = await checkToolApproval(
        'abu-browser__navigate', { tabId: 1, url: ALLOWED_URL },
        { conversationId: 'run-3' } as never,
        (async () => true) as never,
      );

      expect(decision.decision).toBe('deny');
    });

    it('reports the scheduled run as the seam\'s source', async () => {
      useSettingsStore.setState({
        allowUnattendedBrowser: true,
        browserOperationPolicy: policyWith('unattended', 'interactive', 'ask'),
      });
      useChatStore.setState({
        conversations: {
          'run-4': { id: 'run-4', scheduledTaskId: 'task-9' },
        } as never,
      });
      const sources: string[] = [];
      setUnattendedConfirmationResolver(async (request) => {
        sources.push(request.source);
        return { approved: false, reason: 'no' };
      });

      await checkToolApproval(
        'abu-browser__navigate', { tabId: 1, url: ALLOWED_URL },
        { conversationId: 'run-4' } as never,
        undefined,
      );

      expect(sources).toEqual(['scheduler']);
    });
  });

  describe('attended column', () => {
    it('a user-configured deny stops an attended action before any dialog', async () => {
      useSettingsStore.setState({
        browserOperationPolicy: policyWith('attended', 'interactive', 'deny'),
      });
      const confirm = vi.fn(async () => true);

      const decision = await checkToolApproval(
        'abu-browser__navigate', { tabId: 1, url: UNKNOWN_URL }, attended, confirm as never,
      );

      expect(decision.decision).toBe('deny');
      expect(confirm).not.toHaveBeenCalled();
    });

    it('a user-configured ask on read-only asks — the setting is not inert', async () => {
      useSettingsStore.setState({
        browserOperationPolicy: policyWith('attended', 'readOnly', 'ask'),
      });
      const confirm = vi.fn(async () => true);

      const decision = await checkToolApproval(
        'abu-browser__snapshot', { tabId: 1 }, attended, confirm as never,
      );

      expect(decision.decision).toBe('allow');
      expect(confirm).toHaveBeenCalledTimes(1);
    });

    it('read-only stays free under the default policy (no dialog, no origin lookup)', async () => {
      const confirm = vi.fn(async () => true);

      const decision = await checkToolApproval(
        'abu-browser__snapshot', { tabId: 1 }, attended, confirm as never,
      );

      expect(decision.decision).toBe('allow');
      expect(confirm).not.toHaveBeenCalled();
    });
  });
});
