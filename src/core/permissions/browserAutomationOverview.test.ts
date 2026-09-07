import { describe, expect, it, vi } from 'vitest';
import {
  browserPolicyNeedsApproval,
  summarizeBrowserAutomations,
  type BrowserAutomationInput,
} from './browserAutomationOverview';
import {
  DEFAULT_BROWSER_OPERATION_POLICY,
  type BrowserOperationPolicy,
} from './browserToolPolicy';
import type { TriggerAction } from '../../types/trigger';

const ALL_ALLOW: BrowserOperationPolicy = {
  readOnly: 'allow',
  interactive: 'allow',
  scripting: 'allow',
};

function triggerAction(overrides: Partial<TriggerAction> = {}): TriggerAction {
  return { type: 'prompt', prompt: 'do the thing', ...overrides } as TriggerAction;
}

function input(overrides: Partial<BrowserAutomationInput> = {}): BrowserAutomationInput {
  return {
    scheduledTasks: [],
    triggers: [],
    imChannels: [],
    policy: ALL_ALLOW,
    masterSwitchOn: true,
    reachableSiteCount: 1,
    hasApprovalTarget: () => true,
    ...overrides,
  };
}

describe('summarizeBrowserAutomations', () => {
  describe('who is counted as able to use the browser', () => {
    // Its ceiling is built at dispatch from the live tool roster, so nothing
    // static can rule the browser in or out. Counted, never claimed.
    it('counts every scheduled task, because none of them can be ruled out', () => {
      const overview = summarizeBrowserAutomations(input({
        scheduledTasks: [
          { id: 't1', name: 'Nightly report', status: 'active' },
          { id: 't2', name: 'Paused one', status: 'paused' },
        ],
      }));
      expect(overview.counts.schedule).toBe(2);
    });

    it('leaves out a trigger whose tier cannot reach a browser tool', () => {
      const overview = summarizeBrowserAutomations(input({
        triggers: [
          { id: 'r1', name: 'Read only', status: 'active', action: triggerAction({ capability: 'read_tools' } as never) },
          { id: 'r2', name: 'Safe tools', status: 'active', action: triggerAction({ capability: 'safe_tools' } as never) },
        ],
      }));
      expect(overview.counts.trigger).toBe(0);
    });

    it('counts a trigger on the full tier, and a custom one that whitelists browser tools', () => {
      const overview = summarizeBrowserAutomations(input({
        triggers: [
          { id: 'r1', name: 'Full', status: 'active', action: triggerAction({ capability: 'full' } as never) },
          {
            id: 'r2',
            name: 'Custom with browser',
            status: 'active',
            action: triggerAction({
              capability: 'custom',
              permissions: { allowedTools: ['abu-browser__*'] },
            } as never),
          },
          {
            id: 'r3',
            name: 'Custom without browser',
            status: 'active',
            action: triggerAction({
              capability: 'custom',
              permissions: { allowedTools: ['read_file'] },
            } as never),
          },
        ],
      }));
      expect(overview.counts.trigger).toBe(2);
    });

    it('leaves out a chat channel that is switched off, or on a tier without browser access', () => {
      const overview = summarizeBrowserAutomations(input({
        imChannels: [
          { id: 'c1', name: 'Full but off', capability: 'full', enabled: false },
          { id: 'c2', name: 'Chat only', capability: 'chat_only', enabled: true },
          { id: 'c3', name: 'Read tools', capability: 'read_tools', enabled: true },
          { id: 'c4', name: 'Full and on', capability: 'full', enabled: true },
        ],
      }));
      expect(overview.counts.im).toBe(1);
    });

    it('says so when nothing at all can use the browser', () => {
      expect(summarizeBrowserAutomations(input()).anyBrowserCapable).toBe(false);
      expect(summarizeBrowserAutomations(input({
        scheduledTasks: [{ id: 't1', name: 'One', status: 'active' }],
      })).anyBrowserCapable).toBe(true);
    });
  });

  describe('a missing approver', () => {
    // The PRD is explicit: 全允许任务不因没有审批绑定而被阻塞. With no row set
    // to ask, nobody is ever asked, and a red mark here would be a red mark on
    // a correct configuration.
    it('is not an issue while no policy row asks anything', () => {
      const overview = summarizeBrowserAutomations(input({
        policy: ALL_ALLOW,
        scheduledTasks: [{ id: 't1', name: 'Nightly', status: 'active' }],
        hasApprovalTarget: () => false,
      }));
      expect(overview.entries).toEqual([]);
    });

    it('is an issue as soon as one row asks', () => {
      const overview = summarizeBrowserAutomations(input({
        policy: { ...ALL_ALLOW, scripting: 'ask' },
        scheduledTasks: [{ id: 't1', name: 'Nightly', status: 'active' }],
        hasApprovalTarget: () => false,
      }));
      expect(overview.entries).toEqual([
        { id: 't1', source: 'schedule', name: 'Nightly', active: true, issues: ['no-approver'] },
      ]);
    });

    it('is not an issue for a task that HAS a resolvable approver', () => {
      const overview = summarizeBrowserAutomations(input({
        policy: DEFAULT_BROWSER_OPERATION_POLICY,
        scheduledTasks: [{ id: 't1', name: 'Nightly', status: 'active', outputChannelId: 'c1', outputUserIds: 'u1' }],
        hasApprovalTarget: () => true,
      }));
      expect(overview.entries).toEqual([]);
    });

    // Reported, not filtered: it will run the moment somebody resumes it, and
    // the row says 「已暂停」 rather than pretending the gap is not there.
    it('is still reported for a paused automation, flagged as paused', () => {
      const overview = summarizeBrowserAutomations(input({
        policy: DEFAULT_BROWSER_OPERATION_POLICY,
        scheduledTasks: [{ id: 't1', name: 'Nightly', status: 'paused' }],
        hasApprovalTarget: () => false,
      }));
      expect(overview.entries[0]?.active).toBe(false);
      expect(overview.entries[0]?.issues).toEqual(['no-approver']);
    });

    it('offers a webhook trigger no binding at all — a webhook nominates nobody to ask', () => {
      const hasApprovalTarget = vi.fn(() => false);
      summarizeBrowserAutomations(input({
        policy: DEFAULT_BROWSER_OPERATION_POLICY,
        triggers: [{
          id: 'r1',
          name: 'Webhook',
          status: 'active',
          action: triggerAction({ capability: 'full' } as never),
          output: { enabled: true, target: 'webhook', outputChannelId: 'c1', outputUserIds: 'u1' } as never,
        }],
        hasApprovalTarget,
      }));
      expect(hasApprovalTarget).toHaveBeenCalledWith({});
    });

    it('passes an IM trigger its own binding', () => {
      const hasApprovalTarget = vi.fn(() => true);
      summarizeBrowserAutomations(input({
        policy: DEFAULT_BROWSER_OPERATION_POLICY,
        triggers: [{
          id: 'r1',
          name: 'Chat',
          status: 'active',
          action: triggerAction({ capability: 'full' } as never),
          output: {
            enabled: true,
            target: 'im_channel',
            outputChannelId: 'c1',
            outputChatIds: 'chat-1',
            outputUserIds: 'u1',
          } as never,
        }],
        hasApprovalTarget,
      }));
      expect(hasApprovalTarget).toHaveBeenCalledWith({
        outputChannelId: 'c1',
        outputChatIds: 'chat-1',
        outputUserIds: 'u1',
      });
    });

    /*
      A message-started task answers back through the session that started it,
      which exists for the whole life of that run. There is no binding for a
      user to get wrong, so there is nothing here to send them to fix.
    */
    it('is never raised against a chat channel', () => {
      const overview = summarizeBrowserAutomations(input({
        policy: DEFAULT_BROWSER_OPERATION_POLICY,
        imChannels: [{ id: 'c1', name: 'Feishu', capability: 'full', enabled: true }],
        hasApprovalTarget: () => false,
      }));
      expect(overview.counts.im).toBe(1);
      expect(overview.entries).toEqual([]);
    });
  });

  describe('card-level prerequisites', () => {
    it('reports the master switch being off', () => {
      expect(summarizeBrowserAutomations(input({ masterSwitchOn: false })).prerequisites)
        .toEqual(['master-switch-off']);
    });

    // Two reasons for one already-fully-explained state is noise; the switch
    // covers it.
    it('does not also report "no allowed site" while the switch is off', () => {
      expect(summarizeBrowserAutomations(input({
        masterSwitchOn: false,
        reachableSiteCount: 0,
      })).prerequisites).toEqual(['master-switch-off']);
    });

    it('reports having nowhere to act once the switch is on', () => {
      expect(summarizeBrowserAutomations(input({
        masterSwitchOn: true,
        reachableSiteCount: 0,
      })).prerequisites).toEqual(['no-allowed-site']);
    });

    it('reports nothing when both prerequisites are met', () => {
      expect(summarizeBrowserAutomations(input()).prerequisites).toEqual([]);
    });
  });
});

describe('browserPolicyNeedsApproval', () => {
  it('is false when every row is settled one way or the other', () => {
    expect(browserPolicyNeedsApproval(ALL_ALLOW)).toBe(false);
    expect(browserPolicyNeedsApproval({
      readOnly: 'deny', interactive: 'deny', scripting: 'deny',
    })).toBe(false);
  });

  it('is true as soon as any single row asks', () => {
    for (const key of ['readOnly', 'interactive', 'scripting'] as const) {
      expect(browserPolicyNeedsApproval({ ...ALL_ALLOW, [key]: 'ask' })).toBe(true);
    }
  });

  it('is true for the shipped defaults — scripting asks', () => {
    expect(browserPolicyNeedsApproval(DEFAULT_BROWSER_OPERATION_POLICY)).toBe(true);
  });
});
