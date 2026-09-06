/**
 * The preview and the real gate must never disagree — proved by exhaustion.
 *
 * S12 ships a settings pane that tells the user what Abu can do on a given site
 * right now. It gets that answer from `evaluateBrowserGate`, and so does
 * `checkToolApproval`. This file is the thing that keeps that claim true: for
 * every combination of operation class × policy state × site state × run mode ×
 * master switch, it runs the REAL gate — the same `checkToolApproval` an agent
 * calls, through the real settings store, the real MCP origin resolution, the
 * real approval seam — and asserts the pure function said the same thing.
 *
 * Two things are compared, not one:
 *  - the DECISION (allow / deny), and
 *  - whether a human was ASKED, and through which channel.
 *
 * The second matters as much as the first. 「会询问」 and 「允许」 are different
 * answers to a user planning an unattended task, and a preview that collapsed
 * them would be confidently wrong in the case the whole pane exists for.
 *
 * The gate is driven through its real ask sites: the attended
 * `onRequireConfirmation` callback and the unattended
 * `setUnattendedConfirmationResolver` seam. Both APPROVE here — the question
 * is whether the gate asks at all, and what it does with a yes. The refusal
 * halves are covered by `registry.operationPolicy.test.ts`.
 *
 * Deliberately NOT asserting a hand-written expected table: that would be a
 * third copy of the rules, and the one most likely to be written by reading the
 * implementation. The property under test is agreement, and agreement is what
 * breaks when someone edits one side.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkToolApproval } from '../tools/registry';
import { mcpManager } from '../mcp/client';
import { useChatStore } from '../../stores/chatStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { testSiteVerdicts } from '../../test/browserSiteVerdicts';
import {
  __resetBrowserGrantsForTests,
  DEFAULT_BROWSER_OPERATION_POLICY,
  type BrowserOperationClass,
  type BrowserOperationPolicy,
  type BrowserOperationState,
  type DecideBrowserOperationSiteVerdict,
} from './browserToolPolicy';
import {
  __resetUnattendedConfirmationForTests,
  setUnattendedConfirmationResolver,
} from './unattendedConfirmation';
import { evaluateBrowserGate, browserGatePreviewVerdict } from './browserGateEvaluation';

vi.mock('@/core/enterprise/policy/enforcer', () => ({
  getCurrentPolicy: () => ({ mode: 'test-policy' }),
}));
vi.mock('@/core/enterprise/policy/matcher', () => ({
  checkTool: () => ({ decision: 'allow' as const }),
}));

const OWNER = 'contract-owner';
const OWNED_TAB_ID = 91;

/** The four site states the preview offers, and the URL that produces each. */
const SITE_STATES = {
  default: { url: 'https://unknown.example.com/page', stored: undefined },
  allowed: { url: 'https://allowed.example.com/page', stored: 'allowed' as const },
  denied: { url: 'https://blocked.example.com/page', stored: 'denied' as const },
  // Stored 'allowed' AND money-movement: the gate replaces the verdict with
  // 'high-risk', which is the state a preview has to be able to show.
  'high-risk': { url: 'https://www.paypal.com/pay', stored: 'allowed' as const },
} satisfies Record<string, { url: string; stored?: 'allowed' | 'denied' }>;

type SiteState = keyof typeof SITE_STATES;

/** One representative tool per operation class. */
const OP_CLASS_TOOLS: Record<BrowserOperationClass, { tool: string; input: Record<string, unknown> }> = {
  'read-only': { tool: 'abu-browser__snapshot', input: { tabId: OWNED_TAB_ID } },
  interactive: { tool: 'abu-browser__click', input: { tabId: OWNED_TAB_ID, ref: 'ref_1' } },
  scripting: { tool: 'abu-browser__execute_js', input: { tabId: OWNED_TAB_ID, code: '1' } },
};

const POLICY_KEY: Record<BrowserOperationClass, keyof BrowserOperationPolicy> = {
  'read-only': 'readOnly',
  interactive: 'interactive',
  scripting: 'scripting',
};

let mockCallTool: ReturnType<typeof vi.fn>;

function withTabOrigin(url: string) {
  mockCallTool.mockImplementation((params: { _meta?: Record<string, unknown> }) =>
    Promise.resolve(
      params._meta?.['abu/conversationId'] === OWNER
        ? {
            content: [{
              type: 'text',
              text: JSON.stringify({
                windows: [{ windowId: 1, tabs: [{ tabId: OWNED_TAB_ID, url }] }],
              }),
            }],
          }
        : { content: [{ type: 'text', text: JSON.stringify({ windows: [] }) }] },
    ),
  );
}

/** What the gate actually did, in the vocabulary the pure function speaks. */
interface ObservedGate {
  outcome: 'allow' | 'deny';
  askChannel: 'dialog' | 'im' | null;
}

async function observeRealGate(
  opClass: BrowserOperationClass,
  site: SiteState,
  runMode: 'attended' | 'unattended',
): Promise<ObservedGate> {
  const { tool, input } = OP_CLASS_TOOLS[opClass];
  withTabOrigin(SITE_STATES[site].url);

  let askChannel: 'dialog' | 'im' | null = null;
  setUnattendedConfirmationResolver(async () => {
    askChannel = 'im';
    return { approved: true, reason: 'approved in chat' };
  });
  const onRequireConfirmation = vi.fn(async (info: { deniedNotice?: string }) => {
    // A DENIAL NOTICE is not a question: the unattended paths hand the callback
    // their decision so a run can report it, and counting that as an ask would
    // make every refusal look like a prompt.
    if (info.deniedNotice === undefined) askChannel = 'dialog';
    return true;
  });

  const context = runMode === 'unattended'
    ? { conversationId: OWNER, interactionMode: 'background' }
    : { conversationId: OWNER };

  const decision = await checkToolApproval(
    tool,
    input,
    context as never,
    onRequireConfirmation as never,
  );

  return { outcome: decision.decision === 'allow' ? 'allow' : 'deny', askChannel };
}

function predictedGate(
  opClass: BrowserOperationClass,
  site: SiteState,
  runMode: 'attended' | 'unattended',
  policy: BrowserOperationPolicy,
  masterSwitchUnattended: boolean,
): ObservedGate {
  const stored = SITE_STATES[site].stored;
  // The caller's job, and the gate does exactly this: high-risk REPLACES the
  // stored verdict unless the site is blocked.
  const siteVerdict: DecideBrowserOperationSiteVerdict =
    site === 'high-risk' ? 'high-risk' : (stored ?? 'default');
  const evaluation = evaluateBrowserGate({
    opClass,
    runMode,
    policy,
    masterSwitchUnattended,
    siteVerdict,
    permissionMode: 'standard',
    runPermissionCeiling: null,
    toolTargetsPage: true,
    originResolved: true,
    answersPageDialog: false,
    loginRequired: false,
    conversationGrant: false,
    confirmationChannelAvailable: true,
    originKnown: true,
  });
  return { outcome: evaluation.outcome, askChannel: evaluation.ask?.channel ?? null };
}

describe('browser gate — preview and the real gate agree', () => {
  beforeEach(() => {
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
    __resetBrowserGrantsForTests();
    __resetUnattendedConfirmationForTests();
  });

  afterEach(() => {
    (mcpManager as unknown as { servers: Map<string, unknown> }).servers.delete('abu-browser');
    __resetBrowserGrantsForTests();
    __resetUnattendedConfirmationForTests();
  });

  const opClasses: BrowserOperationClass[] = ['read-only', 'interactive', 'scripting'];
  const states: BrowserOperationState[] = ['allow', 'ask', 'deny'];
  const sites = Object.keys(SITE_STATES) as SiteState[];
  const runModes: Array<'attended' | 'unattended'> = ['attended', 'unattended'];
  const masterSwitches = [true, false];

  const matrix: Array<[BrowserOperationClass, BrowserOperationState, SiteState, 'attended' | 'unattended', boolean]> = [];
  for (const opClass of opClasses) {
    for (const state of states) {
      for (const site of sites) {
        for (const runMode of runModes) {
          for (const masterSwitch of masterSwitches) {
            matrix.push([opClass, state, site, runMode, masterSwitch]);
          }
        }
      }
    }
  }

  it('covers the whole declared matrix (3 classes x 3 states x 4 site states x 2 contexts x 2 switch positions)', () => {
    expect(matrix).toHaveLength(3 * 3 * 4 * 2 * 2);
  });

  it.each(matrix)(
    '%s row=%s site=%s %s masterSwitch=%s',
    async (opClass, state, site, runMode, masterSwitch) => {
      const policy: BrowserOperationPolicy = {
        ...DEFAULT_BROWSER_OPERATION_POLICY,
        [POLICY_KEY[opClass]]: state,
      };
      const stored = SITE_STATES[site].stored;
      useSettingsStore.setState({
        permissionMode: 'standard',
        browserOperationPolicy: policy,
        allowUnattendedBrowser: masterSwitch,
        browserSitePermissions: testSiteVerdicts(
          stored === undefined ? {} : { [new URL(SITE_STATES[site].url).origin]: stored },
        ),
      });

      const observed = await observeRealGate(opClass, site, runMode);
      const predicted = predictedGate(opClass, site, runMode, policy, masterSwitch);

      expect(observed).toEqual(predicted);
    },
  );
});

describe('browserGatePreviewVerdict', () => {
  const base = {
    outcome: 'allow' as const,
    denialReason: null,
    ceilingDecision: null,
    intermediates: {
      scriptAllowedByPolicy: false,
      dialogAnswerAllowedByPolicy: false,
      asksEveryTime: false,
      granted: false,
    },
  };

  it('reads a silent allow as allow', () => {
    expect(browserGatePreviewVerdict({ ...base, ask: null })).toBe('allow');
  });

  it('reads an allow behind a confirmation as ask', () => {
    expect(browserGatePreviewVerdict({
      ...base,
      ask: { channel: 'dialog', offersPersistentGrant: true, refusedReason: 'user-cancelled' },
    })).toBe('ask');
  });

  // The unattended 「每次询问」 on a site with no standing grant: the gate asks a
  // human and refuses anyway. Reporting 「会询问」 would promise a road that
  // dead-ends, so the refusal wins.
  it('reads an ask that is refused anyway as deny', () => {
    expect(browserGatePreviewVerdict({
      ...base,
      outcome: 'deny',
      denialReason: 'site-not-allowed',
      ask: { channel: 'im', offersPersistentGrant: false, refusedReason: 'approval-refused' },
    })).toBe('deny');
  });
});
