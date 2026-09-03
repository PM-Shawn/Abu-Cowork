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
import { mcpManager } from '../mcp/client';
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
import {
  drainConfirmationQueue,
  getPendingCommandConfirmation,
  requestCommandConfirmation,
} from '../agent/permissionBridge';

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
const BLOCKED_SITE = 'https://blocked.com';
const OWNER = 'run-owner';
const OWNED_TAB_ID = 77;

// Tools that carry only a `tabId` (screenshot, extract_text, click, ...) make
// the gate resolve the tab's origin through the browser server's `get_tabs`.
// This fake models the host's ownership rule the same way
// registry.browserGateOwnership.test.ts does.
interface FakeConnectedServer {
  config: { name: string };
  client: { callTool: ReturnType<typeof vi.fn> };
  transport: unknown;
  tools: Map<string, never>;
}

let mockCallTool: ReturnType<typeof vi.fn>;

function withTabOrigin(url: string) {
  mockCallTool.mockImplementation((params: { _meta?: Record<string, unknown> }) =>
    Promise.resolve(
      params._meta?.['abu/conversationId'] === OWNER
        ? {
            content: [{
              type: 'text',
              text: JSON.stringify({ windows: [{ windowId: 1, tabs: [{ tabId: OWNED_TAB_ID, url }] }] }),
            }],
          }
        : { content: [{ type: 'text', text: JSON.stringify({ windows: [] }) }] },
    ),
  );
}

/** An unattended tool context: the flag the agent loop derives for scheduled /
 *  trigger / IM runs. */
const unattended = { conversationId: 'run-1', interactionMode: 'background' } as never;
/** An attended one — no provenance at all, which is what a chat turn carries. */
const attended = { conversationId: 'conv-1' } as never;
/** Same two, for the conversation that owns the fake tab above. */
const unattendedOwner = { conversationId: OWNER, interactionMode: 'background' } as never;
const attendedOwner = { conversationId: OWNER } as never;

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
    mockCallTool = vi.fn(() => Promise.resolve({
      content: [{ type: 'text', text: JSON.stringify({ windows: [] }) }],
    }));
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
    (mcpManager as unknown as { servers: Map<string, unknown> }).servers.delete('abu-browser');
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

    // The gate refuses on its own, but the run still has to be able to EXPLAIN
    // the refusal — a scheduled task that reports only "failed" is the exact
    // failure the scheduler's denial accounting exists to prevent. So the
    // callback is notified, not consulted: it is told the decision and its
    // answer is discarded.
    it('notifies the run\'s callback of the refusal instead of asking it', async () => {
      const confirm = vi.fn(async () => true); // says "yes" — must not matter
      const decision = await checkToolApproval(
        'abu-browser__navigate', { tabId: 1, url: ALLOWED_URL }, unattended, confirm as never,
      );

      expect(decision.decision).toBe('deny');
      expect(confirm).toHaveBeenCalledTimes(1);
      const notice = confirm.mock.calls[0][0] as unknown as {
        deniedNotice?: string; browserOrigin?: string; kind?: string;
      };
      expect(notice.deniedNotice).toContain('Settings');
      expect(notice.kind).toBe('browser');
      // The origin rides along so the run result can say WHERE it happened.
      expect(notice.browserOrigin).toBe(ALLOWED_SITE);
    });

    it('is not derailed by a callback that throws while being notified', async () => {
      const confirm = vi.fn(async () => { throw new Error('recorder exploded'); });
      const decision = await checkToolApproval(
        'abu-browser__navigate', { tabId: 1, url: ALLOWED_URL }, unattended, confirm as never,
      );

      expect(decision.decision).toBe('deny');
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

    it('lets read-only browser tools run on a resolvable page', async () => {
      withTabOrigin(`${ALLOWED_SITE}/report`);

      const decision = await checkToolApproval(
        'abu-browser__snapshot', { tabId: OWNED_TAB_ID }, unattendedOwner, (async () => true) as never,
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
      // The entry point's own callback must never ANSWER an unattended
      // approval — an IM `full` tier's auto-approve would rubber-stamp it. It
      // is only told the outcome afterwards, as a refusal notice.
      expect(confirm).toHaveBeenCalledTimes(1);
      expect((confirm.mock.calls[0][0] as unknown as { deniedNotice?: string }).deniedNotice)
        .toBeDefined();
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

    // The approval channel coalesces per run: without a run key it cannot tell
    // "the same ask again in this turn" from "a new ask next week", so a
    // chatty tool would push one chat message per call.
    it('carries the run key so an approval channel can scope its coalescing', async () => {
      const runKeys: (string | undefined)[] = [];
      setUnattendedConfirmationResolver(async (request) => {
        runKeys.push(request.runKey);
        return { approved: false, reason: 'no' };
      });

      await checkToolApproval(
        'abu-browser__navigate', { tabId: 1, url: ALLOWED_URL },
        { conversationId: 'run-1', interactionMode: 'background', loopId: 'loop-77' } as never,
        undefined,
      );

      expect(runKeys).toEqual(['loop-77']);
    });

    // "You declined this in chat" and "nobody answered in ten minutes" are not
    // the same event as "there is no confirmation channel". The channel knows
    // which; the gate's generic sentence would be wrong about all three.
    it("reports the channel's own localized refusal when it supplies one", async () => {
      const denials: string[] = [];
      setUnattendedConfirmationResolver(async () => ({
        approved: false,
        reason: 'denied over IM by the user',
        userFacingReason: '你在 IM 里回复了「拒绝」',
      }));

      const decision = await checkToolApproval(
        'abu-browser__navigate', { tabId: 1, url: ALLOWED_URL }, unattended,
        (async (info: { deniedNotice?: string }) => {
          if (info.deniedNotice) denials.push(info.deniedNotice);
          return false;
        }) as never,
      );

      expect(decision.decision).toBe('deny');
      expect(denials).toEqual(['你在 IM 里回复了「拒绝」']);
    });

    it('keeps its own wording when the channel has nothing better to say', async () => {
      const denials: string[] = [];
      setUnattendedConfirmationResolver(async () => ({ approved: false, reason: 'nope' }));

      await checkToolApproval(
        'abu-browser__navigate', { tabId: 1, url: ALLOWED_URL }, unattended,
        (async (info: { deniedNotice?: string }) => {
          if (info.deniedNotice) denials.push(info.deniedNotice);
          return false;
        }) as never,
      );

      // The generic key, not the resolver's English diagnostic.
      expect(denials).toHaveLength(1);
      expect(denials[0]).not.toContain('nope');
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

    // U4 (controller ruling): the run MODE follows who started THIS run, not
    // where the conversation came from. Same scheduled conversation, two
    // runs: the scheduler's tick is unattended; the human's typed message is
    // attended and gets the dialog.
    describe('run initiator', () => {
      const SCHEDULED_CONV = 'run-5';

      beforeEach(() => {
        useChatStore.setState({
          conversations: {
            [SCHEDULED_CONV]: { id: SCHEDULED_CONV, scheduledTaskId: 'task-9' },
          } as never,
        });
      });

      it('the scheduler tick in a scheduled conversation is unattended — denied by policy, no dialog', async () => {
        const confirm = vi.fn(async () => true);

        const decision = await checkToolApproval(
          'abu-browser__navigate', { tabId: 1, url: UNKNOWN_URL },
          {
            conversationId: SCHEDULED_CONV,
            interactionMode: 'background',
            initiatedBy: 'automation',
            runPermissionCeiling: buildScheduledRunPermissionCeiling(['abu-browser__navigate']),
          } as never,
          confirm as never,
        );

        expect(decision.decision).toBe('deny');
        // The callback may be NOTIFIED of the refusal (deniedNotice) but is
        // never ASKED — a genuine confirmation request carries no notice.
        for (const [info] of confirm.mock.calls as unknown as Array<[{ deniedNotice?: string }]>) {
          expect(info.deniedNotice).toBeDefined();
        }
      });

      it('a human-typed message in the SAME scheduled conversation is attended — the dialog is offered', async () => {
        const confirm = vi.fn(async () => true);

        const decision = await checkToolApproval(
          'abu-browser__navigate', { tabId: 1, url: UNKNOWN_URL },
          { conversationId: SCHEDULED_CONV, initiatedBy: 'user' } as never,
          confirm as never,
        );

        expect(decision.decision).toBe('allow');
        expect(confirm).toHaveBeenCalledTimes(1);
        const [info] = confirm.mock.calls[0] as unknown as [{ kind?: string; deniedNotice?: string }];
        expect(info.kind).toBe('browser');
        expect(info.deniedNotice).toBeUndefined();
      });

      it('a human-typed message still respects the dialog\'s answer', async () => {
        const decision = await checkToolApproval(
          'abu-browser__navigate', { tabId: 1, url: UNKNOWN_URL },
          { conversationId: SCHEDULED_CONV, initiatedBy: 'user' } as never,
          (async () => false) as never,
        );

        expect(decision.decision).toBe('deny');
      });

      it('a "user" initiator cannot strip a run of its ceiling — still unattended', async () => {
        const confirm = vi.fn(async () => true);

        const decision = await checkToolApproval(
          'abu-browser__navigate', { tabId: 1, url: UNKNOWN_URL },
          {
            conversationId: SCHEDULED_CONV,
            initiatedBy: 'user',
            runPermissionCeiling: buildScheduledRunPermissionCeiling(['abu-browser__navigate']),
          } as never,
          confirm as never,
        );

        expect(decision.decision).toBe('deny');
        for (const [info] of confirm.mock.calls as unknown as Array<[{ deniedNotice?: string }]>) {
          expect(info.deniedNotice).toBeDefined();
        }
      });
    });
  });

  // U4: every refusal the browser gate issues is reported to the run through
  // the narrow `reportBrowserDenial` seam (and an allow through
  // `reportBrowserAllow`), so consecutive ones can stop the loop. Refusals
  // from OTHER gates (commands, files) must not touch it.
  describe('consecutive-denial reporting', () => {
    function reporters() {
      return {
        reportBrowserDenial: vi.fn(),
        reportBrowserAllow: vi.fn(),
      };
    }

    it('an attended dialog "deny" is reported as a browser denial', async () => {
      const r = reporters();

      const decision = await checkToolApproval(
        'abu-browser__navigate', { tabId: 1, url: UNKNOWN_URL },
        { conversationId: 'conv-1', ...r } as never,
        (async () => false) as never,
      );

      expect(decision.decision).toBe('deny');
      expect(r.reportBrowserDenial).toHaveBeenCalledTimes(1);
      expect(r.reportBrowserAllow).not.toHaveBeenCalled();
    });

    it('an attended dialog "allow" resets the streak', async () => {
      const r = reporters();

      const decision = await checkToolApproval(
        'abu-browser__navigate', { tabId: 1, url: UNKNOWN_URL },
        { conversationId: 'conv-1', ...r } as never,
        (async () => true) as never,
      );

      expect(decision.decision).toBe('allow');
      expect(r.reportBrowserAllow).toHaveBeenCalledTimes(1);
      expect(r.reportBrowserDenial).not.toHaveBeenCalled();
    });

    // I1: the streak only measures refusals a human issued, so only an allow a
    // human CONSENTED to may clear it. A read-only action that sails through
    // on the default policy — no dialog, no grant, nobody asked — used to
    // reset it, which made the guard trivially dodgeable: navigate (denied),
    // screenshot (auto-allowed, streak cleared), navigate (denied), ... forever.
    it('a read-only action that passes without a dialog does NOT reset the streak', async () => {
      const r = reporters();

      const decision = await checkToolApproval(
        'abu-browser__screenshot', {},
        { conversationId: 'conv-1', ...r } as never,
        undefined,
      );

      expect(decision.decision).toBe('allow');
      expect(r.reportBrowserAllow).not.toHaveBeenCalled();
      expect(r.reportBrowserDenial).not.toHaveBeenCalled();
    });

    it('a standing site grant applied attended DOES reset the streak', async () => {
      const r = reporters();

      const decision = await checkToolApproval(
        'abu-browser__navigate', { tabId: 1, url: ALLOWED_URL },
        { conversationId: 'conv-1', ...r } as never,
        undefined,
      );

      expect(decision.decision).toBe('allow');
      expect(r.reportBrowserAllow).toHaveBeenCalledTimes(1);
      expect(r.reportBrowserDenial).not.toHaveBeenCalled();
    });

    // I2: a standing-configuration refusal is not an interaction. With the
    // master switch at its shipped default (off), EVERY browser call of an
    // unattended run is refused here — counting those would abort any
    // unattended run that touched the browser twice, though no human ever
    // refused anything.
    it('an unattended refusal from the master switch does NOT count as a denial', async () => {
      const r = reporters();

      const decision = await checkToolApproval(
        'abu-browser__navigate', { tabId: 1, url: ALLOWED_URL },
        { ...unattended, ...r } as never,
        undefined,
      );

      expect(decision.decision).toBe('deny');
      expect(r.reportBrowserDenial).not.toHaveBeenCalled();
      expect(r.reportBrowserAllow).not.toHaveBeenCalled();
    });

    it('a blocked site does NOT count as a denial', async () => {
      useSettingsStore.setState({
        allowUnattendedBrowser: true,
        browserSitePermissions: { [BLOCKED_SITE]: 'denied' },
      });
      withTabOrigin(`${BLOCKED_SITE}/statement`);
      const r = reporters();

      const decision = await checkToolApproval(
        'abu-browser__click', { tabId: OWNED_TAB_ID, selector: 'a' },
        { ...unattendedOwner, ...r } as never,
        undefined,
      );

      expect(decision.decision).toBe('deny');
      expect(r.reportBrowserDenial).not.toHaveBeenCalled();
    });

    it('a policy "deny" cell does NOT count as a denial', async () => {
      useSettingsStore.setState({
        allowUnattendedBrowser: true,
        browserOperationPolicy: policyWith('unattended', 'readOnly', 'deny'),
      });
      const r = reporters();

      const decision = await checkToolApproval(
        'abu-browser__extract_text', { tabId: 1 },
        { ...unattended, ...r } as never,
        undefined,
      );

      expect(decision.decision).toBe('deny');
      expect(r.reportBrowserDenial).not.toHaveBeenCalled();
    });

    it('a run-permission ceiling refusal does NOT count as a denial', async () => {
      useSettingsStore.setState({ allowUnattendedBrowser: true });
      const r = reporters();

      const decision = await checkToolApproval(
        'abu-browser__navigate', { tabId: 1, url: ALLOWED_URL },
        {
          ...unattended,
          runPermissionCeiling: buildScheduledRunPermissionCeiling([]),
          ...r,
        } as never,
        undefined,
      );

      expect(decision.decision).toBe('deny');
      expect(r.reportBrowserDenial).not.toHaveBeenCalled();
    });

    it('an unverifiable origin does NOT count as a denial', async () => {
      useSettingsStore.setState({ allowUnattendedBrowser: true });
      const r = reporters();

      const decision = await checkToolApproval(
        'abu-browser__extract_text', { tabId: 4242 },
        { ...unattended, ...r } as never,
        undefined,
      );

      expect(decision.decision).toBe('deny');
      expect(r.reportBrowserDenial).not.toHaveBeenCalled();
    });

    it('an unattended state-changing action refused for lack of a site grant does NOT count', async () => {
      useSettingsStore.setState({ allowUnattendedBrowser: true });
      withTabOrigin(UNKNOWN_URL);
      const r = reporters();

      const decision = await checkToolApproval(
        'abu-browser__click', { tabId: OWNED_TAB_ID, selector: 'a' },
        { ...unattendedOwner, ...r } as never,
        undefined,
      );

      expect(decision.decision).toBe('deny');
      expect(r.reportBrowserDenial).not.toHaveBeenCalled();
    });

    it('an attended ask with no dialog channel counts as a denial', async () => {
      const r = reporters();

      const decision = await checkToolApproval(
        'abu-browser__navigate', { tabId: 1, url: UNKNOWN_URL },
        { conversationId: 'conv-1', ...r } as never,
        undefined,
      );

      expect(decision.decision).toBe('deny');
      expect(r.reportBrowserDenial).toHaveBeenCalledTimes(1);
    });

    it('an unattended "ask" refused (or timed out) at the approval seam counts as a denial', async () => {
      useSettingsStore.setState({
        allowUnattendedBrowser: true,
        browserOperationPolicy: policyWith('unattended', 'interactive', 'ask'),
      });
      setUnattendedConfirmationResolver(async () => ({ approved: false, reason: 'timeout' }));
      const r = reporters();

      const decision = await checkToolApproval(
        'abu-browser__navigate', { tabId: 1, url: ALLOWED_URL },
        { ...unattended, ...r } as never,
        undefined,
      );

      expect(decision.decision).toBe('deny');
      expect(r.reportBrowserDenial).toHaveBeenCalledTimes(1);
    });

    it('an unattended action approved by policy and site grant resets the streak', async () => {
      useSettingsStore.setState({ allowUnattendedBrowser: true });
      const r = reporters();

      const decision = await checkToolApproval(
        'abu-browser__navigate', { tabId: 1, url: ALLOWED_URL },
        { ...unattended, ...r } as never,
        undefined,
      );

      expect(decision.decision).toBe('allow');
      expect(r.reportBrowserAllow).toHaveBeenCalledTimes(1);
      expect(r.reportBrowserDenial).not.toHaveBeenCalled();
    });

    it('a blocked COMMAND is not a browser denial', async () => {
      const r = reporters();

      const decision = await checkToolApproval(
        'run_command', { command: 'rm -rf /' },
        { conversationId: 'conv-1', ...r } as never,
        (async () => false) as never,
      );

      expect(decision.decision).toBe('deny');
      expect(r.reportBrowserDenial).not.toHaveBeenCalled();
      expect(r.reportBrowserAllow).not.toHaveBeenCalled();
    });

    it('a non-browser tool that passes does not touch the streak either', async () => {
      const r = reporters();

      await checkToolApproval(
        'run_command', { command: 'ls' },
        { conversationId: 'conv-1', ...r } as never,
        (async () => true) as never,
      );

      expect(r.reportBrowserDenial).not.toHaveBeenCalled();
      expect(r.reportBrowserAllow).not.toHaveBeenCalled();
    });
  });

  // I3: an unattended run must not be able to read a site the user blocked.
  // "It was only a screenshot" is not a defense when the page is a logged-in
  // bank statement and nobody is watching the run.
  describe('blocked sites bind read-only actions too, in unattended runs', () => {
    beforeEach(() => {
      useSettingsStore.setState({
        allowUnattendedBrowser: true,
        browserSitePermissions: { [BLOCKED_SITE]: 'denied' },
      });
    });

    it.each(['screenshot', 'extract_text', 'snapshot', 'query_js'])(
      'denies %s on a blocked site',
      async (tool) => {
        withTabOrigin(`${BLOCKED_SITE}/statement`);

        const decision = await checkToolApproval(
          `abu-browser__${tool}`, { tabId: OWNED_TAB_ID }, unattendedOwner, (async () => true) as never,
        );

        expect(decision.decision).toBe('deny');
      },
    );

    it('still allows the same read on a site with no verdict', async () => {
      withTabOrigin('https://neutral.com/page');

      const decision = await checkToolApproval(
        'abu-browser__screenshot', { tabId: OWNED_TAB_ID }, unattendedOwner, (async () => true) as never,
      );

      expect(decision.decision).toBe('allow');
    });

    it('reports the blocked read through the denial accounting, with the origin', async () => {
      withTabOrigin(`${BLOCKED_SITE}/statement`);
      const confirm = vi.fn(async () => true);

      await checkToolApproval(
        'abu-browser__screenshot', { tabId: OWNED_TAB_ID }, unattendedOwner, confirm as never,
      );

      const notice = confirm.mock.calls[0]?.[0] as unknown as {
        deniedNotice?: string; browserOrigin?: string;
      };
      expect(notice?.deniedNotice).toBeDefined();
      expect(notice?.browserOrigin).toBe(BLOCKED_SITE);
    });

    it('leaves ATTENDED read-only on the cheap path — no origin probe at all', async () => {
      withTabOrigin(`${BLOCKED_SITE}/statement`);

      const decision = await checkToolApproval(
        'abu-browser__screenshot', { tabId: OWNED_TAB_ID }, attendedOwner, (async () => true) as never,
      );

      expect(decision.decision).toBe('allow');
      expect(mockCallTool).not.toHaveBeenCalled();
    });

    it('does not probe for a tool that carries no tab (get_tabs stays free)', async () => {
      const decision = await checkToolApproval(
        'abu-browser__get_tabs', {}, unattendedOwner, (async () => true) as never,
      );

      expect(decision.decision).toBe('allow');
      expect(mockCallTool).not.toHaveBeenCalled();
    });
  });

  // Completing I3: a probe that fails must not become permission. If the
  // browser host is wedged, every origin resolves to null and every site
  // verdict to 'default' — which would silently re-open the blocked-site hole
  // by breaking the lookup instead of by policy.
  describe('an unverifiable site is a refusal in unattended runs', () => {
    beforeEach(() => {
      useSettingsStore.setState({ allowUnattendedBrowser: true });
    });

    it.each(['screenshot', 'extract_text', 'snapshot', 'click', 'fill'])(
      'denies %s when the origin cannot be resolved',
      async (tool) => {
        // The host answers, but knows nothing about this tab (wedged host,
        // closed tab, a tab owned by someone else).
        const decision = await checkToolApproval(
          `abu-browser__${tool}`, { tabId: 4242 }, unattendedOwner, (async () => true) as never,
        );

        expect(decision.decision).toBe('deny');
      },
    );

    it('denies a history navigation, whose destination is unknowable', async () => {
      const decision = await checkToolApproval(
        'abu-browser__navigate', { tabId: OWNED_TAB_ID, action: 'back', url: ALLOWED_URL },
        unattendedOwner, (async () => true) as never,
      );

      expect(decision.decision).toBe('deny');
    });

    it('reports the unverifiable site through the denial accounting', async () => {
      const confirm = vi.fn(async () => true);

      await checkToolApproval(
        'abu-browser__screenshot', { tabId: 4242 }, unattendedOwner, confirm as never,
      );

      expect((confirm.mock.calls[0]?.[0] as unknown as { deniedNotice?: string }).deniedNotice)
        .toBeDefined();
    });

    it('exempts tools that act on no page at all', async () => {
      for (const tool of ['get_tabs', 'connection_status', 'get_downloads']) {
        const decision = await checkToolApproval(
          `abu-browser__${tool}`, {}, unattendedOwner, (async () => true) as never,
        );
        expect(decision.decision, tool).toBe('allow');
      }
    });

    it('leaves ATTENDED reads alone — an unresolvable origin still just runs', async () => {
      const decision = await checkToolApproval(
        'abu-browser__screenshot', { tabId: 4242 }, attendedOwner, (async () => true) as never,
      );

      expect(decision.decision).toBe('allow');
    });
  });

  // I2: the unattended scripting cell has no 'allow' — a policy that claims
  // otherwise resolves to 'ask', which fails closed until U3's approval lands.
  describe('unattended scripting can never be silently allowed', () => {
    it('treats a stored unattended scripting "allow" as "ask", not allow', async () => {
      useSettingsStore.setState({
        allowUnattendedBrowser: true,
        browserOperationPolicy: policyWith('unattended', 'scripting', 'allow'),
      });
      const approvals: string[] = [];
      setUnattendedConfirmationResolver(async (request) => {
        approvals.push(request.info.browserOperationClass ?? 'none');
        return { approved: false, reason: 'no channel' };
      });

      withTabOrigin(ALLOWED_URL);
      const decision = await checkToolApproval(
        'abu-browser__execute_js', { tabId: OWNED_TAB_ID, code: '1' },
        unattendedOwner, (async () => true) as never,
      );

      expect(decision.decision).toBe('deny');
      // Routed to the approval seam (the 'ask' behavior), not allowed outright.
      expect(approvals).toEqual(['scripting']);
    });

    it('cannot be stored as allow in the first place', () => {
      useSettingsStore.getState().setBrowserOperationState('unattended', 'scripting', 'allow');

      expect(useSettingsStore.getState().browserOperationPolicy.unattended.scripting).toBe('ask');
    });
  });

  // N1: the run mode is derived from the conversation record, and a
  // scheduled/trigger conversation stays unattended-shaped forever — including
  // after a human opens it from the run history and types into it. That chat
  // dispatches with no confirm callback, so the loop falls back to the desktop
  // bridge. A refusal notice reaching THAT would queue a dialog with no
  // timeout, block the turn on a question about an already-refused action, and
  // discard the click.
  describe('a refusal notice never becomes a desktop dialog', () => {
    beforeEach(() => {
      useSettingsStore.setState({ allowUnattendedBrowser: false });
      useChatStore.setState({
        conversations: {
          'resumed-run': { id: 'resumed-run', scheduledTaskId: 'task-9' },
        } as never,
      });
    });

    afterEach(() => {
      drainConfirmationQueue();
    });

    it('enqueues nothing and still denies, with the real permission bridge as the callback', async () => {
      const decision = await checkToolApproval(
        'abu-browser__navigate', { tabId: 1, url: ALLOWED_URL },
        { conversationId: 'resumed-run' } as never,
        requestCommandConfirmation,
      );

      expect(decision.decision).toBe('deny');
      expect(getPendingCommandConfirmation()).toBeNull();
    });

    it('refuses a notice at the bridge itself, whoever sends one', async () => {
      await expect(requestCommandConfirmation({
        command: 'anything',
        level: 'warn',
        reason: 'already refused',
        deniedNotice: 'already refused',
      })).resolves.toBe(false);
      expect(getPendingCommandConfirmation()).toBeNull();
    });

    it('still queues a genuine confirmation request', async () => {
      // The guard must key on the notice, not on "browser" or "unattended" —
      // an ordinary request from the same bridge still reaches the dialog.
      void requestCommandConfirmation({ command: 'rm -rf /tmp/x', level: 'danger', reason: '' });
      await Promise.resolve();

      expect(getPendingCommandConfirmation()).not.toBeNull();
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
