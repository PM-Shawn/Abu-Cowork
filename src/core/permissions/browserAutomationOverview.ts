/**
 * "Which of my automations use the browser, and which one is misconfigured?"
 * — answered once, for the settings card that asks it (S11).
 *
 * ## What it will and will not claim
 *
 * Browser settings hold GLOBAL rules. They do not hold an approver or a result
 * channel: those belong to the individual task, trigger or chat channel, and
 * this module only READS them to report a gap and offer a jump to the editor
 * that owns it. Nothing here writes anything, and nothing here runs anything —
 * 「检查配置」 means checking configuration, not opening a page or sending a
 * test message.
 *
 * Two kinds of honesty the PRD asks for and this enforces:
 *
 * 1. **It never guesses that an automation uses the browser.** Only one thing
 *    is knowable without running it: whether the automation's capability tier
 *    could reach a browser tool AT ALL. That is decided by the same function
 *    the runtime uses (`decideToolUnderRunPermissionCeiling`), so a trigger on
 *    the read-only tier is reported as unable — a fact — and everything else is
 *    reported as 「运行时检查」 rather than as a prediction. A scheduled task's
 *    ceiling is built at dispatch from the live tool roster, so it is never
 *    statically decidable and is always 「运行时检查」.
 *
 * 2. **A missing approver is only a problem when the policy needs one.** With
 *    every operation row at allow or deny, nobody is ever asked, and flagging
 *    such a task for having no approval binding would be a red mark on a
 *    correct configuration. The PRD says it plainly: 全允许任务不因没有审批绑定
 *    而被阻塞.
 *
 * Result delivery is deliberately not checked at all: it is optional, and a
 * task with no result channel still runs.
 */

import type { IMCapabilityLevel } from '../../types/imChannel';
import type { TriggerAction, TriggerOutput } from '../../types/trigger';
import type { ImOutputBinding } from '../im/approvalTarget';
import type { BrowserOperationPolicy } from './browserToolPolicy';
import {
  buildIMRunPermissionCeiling,
  buildTriggerRunPermissionCeiling,
  decideToolUnderRunPermissionCeiling,
} from './runPermissionCeiling';

export type BrowserAutomationSource = 'schedule' | 'trigger' | 'im';

/** Why a row is listed. Codes, not copy — the card localizes them. */
export type BrowserAutomationIssue =
  /** The policy asks for a confirmation somewhere, and this automation named
   *  nobody who could answer one. */
  | 'no-approver';

export interface BrowserAutomationEntry {
  id: string;
  source: BrowserAutomationSource;
  name: string;
  /** False for a paused task / trigger or a switched-off channel. Reported
   *  rather than filtered: a paused automation with a broken binding is still
   *  broken, and it will run the moment somebody resumes it. */
  active: boolean;
  issues: BrowserAutomationIssue[];
}

/** A prerequisite that blocks EVERY automation, so it is said once per card. */
export type BrowserAutomationPrerequisite = 'master-switch-off' | 'no-allowed-site';

export interface BrowserAutomationOverview {
  /** How many automations of each kind could reach the browser at all. */
  counts: Record<BrowserAutomationSource, number>;
  /** True when nothing at all can use the browser — a different message from
   *  "nothing needs fixing". */
  anyBrowserCapable: boolean;
  prerequisites: BrowserAutomationPrerequisite[];
  /** Only the automations that need attention. A list of ALL of them would be
   *  a second task manager living in the settings pane. */
  entries: BrowserAutomationEntry[];
}

export interface ScheduledTaskFacts extends ImOutputBinding {
  id: string;
  name: string;
  status: 'active' | 'paused';
}

export interface TriggerFacts {
  id: string;
  name: string;
  status: 'active' | 'paused';
  action: TriggerAction;
  output?: TriggerOutput | undefined;
}

export interface ImChannelFacts {
  id: string;
  name: string;
  capability: IMCapabilityLevel;
  enabled: boolean;
}

export interface BrowserAutomationInput {
  scheduledTasks: readonly ScheduledTaskFacts[];
  triggers: readonly TriggerFacts[];
  imChannels: readonly ImChannelFacts[];
  policy: BrowserOperationPolicy;
  masterSwitchOn: boolean;
  /** How many origins carry a standing `'allowed'` verdict and are reachable
   *  unattended (`summarizeBrowserAuthorization().reachableUnattended`). */
  reachableSiteCount: number;
  /**
   * Whether this binding resolves to somebody who could answer an approval.
   * Injected rather than imported so this module stays testable without the IM
   * channel store; production passes the real `resolveUnattendedImTarget`, so
   * the rule that decides is the same one the gate obeys.
   */
  hasApprovalTarget: (binding: ImOutputBinding) => boolean;
}

/**
 * One read tool and one acting tool. A tier that can reach NEITHER cannot use
 * the browser in any way, which is the only "no" this module is willing to
 * state. A tier that reaches only the read tool still counts as browser-capable
 * — reading a page is a browser action, and a blocked site matters there too.
 */
const BROWSER_PROBE_TOOLS = ['abu-browser__snapshot', 'abu-browser__click'] as const;

/**
 * Can this capability tier reach a browser tool at all?
 *
 * Asked through the runtime's own roster check rather than by matching names
 * here, so a tier whose allowlist changes changes this answer with it.
 */
function tierCanReachBrowser(
  ceiling: Parameters<typeof decideToolUnderRunPermissionCeiling>[0],
): boolean {
  return BROWSER_PROBE_TOOLS.some(
    (tool) => decideToolUnderRunPermissionCeiling(ceiling, tool, {}).decision === 'allow',
  );
}

/**
 * Does the current policy put a question to a human anywhere?
 *
 * If not, no automation needs an approver and none is flagged for lacking one.
 */
export function browserPolicyNeedsApproval(policy: BrowserOperationPolicy): boolean {
  return policy.readOnly === 'ask'
    || policy.interactive === 'ask'
    || policy.scripting === 'ask';
}

export function summarizeBrowserAutomations(
  input: BrowserAutomationInput,
): BrowserAutomationOverview {
  const {
    scheduledTasks,
    triggers,
    imChannels,
    policy,
    masterSwitchOn,
    reachableSiteCount,
    hasApprovalTarget,
  } = input;

  const needsApproval = browserPolicyNeedsApproval(policy);
  const entries: BrowserAutomationEntry[] = [];

  // A scheduled task's ceiling is frozen at dispatch from whatever tools exist
  // then (`buildScheduledRunPermissionCeiling`), so nothing here can rule the
  // browser out for one. Every scheduled task counts, and none is claimed to
  // use the browser.
  for (const task of scheduledTasks) {
    const issues: BrowserAutomationIssue[] = [];
    if (needsApproval && !hasApprovalTarget({
      outputChannelId: task.outputChannelId,
      outputChatIds: task.outputChatIds,
      outputUserIds: task.outputUserIds,
    })) {
      issues.push('no-approver');
    }
    if (issues.length > 0) {
      entries.push({
        id: task.id,
        source: 'schedule',
        name: task.name,
        active: task.status === 'active',
        issues,
      });
    }
  }

  const browserCapableTriggers = triggers.filter(
    (trigger) => tierCanReachBrowser(buildTriggerRunPermissionCeiling(trigger.action)),
  );
  for (const trigger of browserCapableTriggers) {
    const issues: BrowserAutomationIssue[] = [];
    // A webhook output nominates nobody to ask — `resolveUnattendedImTarget`
    // returns null for it, so the binding is only offered when the trigger
    // actually chose an IM channel.
    const binding: ImOutputBinding = trigger.output?.enabled === true
      && trigger.output.target === 'im_channel'
      ? {
        outputChannelId: trigger.output.outputChannelId,
        outputChatIds: trigger.output.outputChatIds,
        outputUserIds: trigger.output.outputUserIds,
      }
      : {};
    if (needsApproval && !hasApprovalTarget(binding)) issues.push('no-approver');
    if (issues.length > 0) {
      entries.push({
        id: trigger.id,
        source: 'trigger',
        name: trigger.name,
        active: trigger.status === 'active',
        issues,
      });
    }
  }

  /*
    Chat channels are counted but never flagged for a missing approver, and that
    is not an omission. A task started by a message is answered back through the
    session that started it (`pendingApprovals.resolveImTargetForConversation`),
    which exists by construction for the whole life of that run — there is no
    binding for a user to get wrong, so there is nothing here to fix.

    A channel that is switched off, or one on a tier that cannot reach a browser
    tool, is not counted at all.
  */
  const browserCapableChannels = imChannels.filter(
    (channel) => channel.enabled
      && tierCanReachBrowser(buildIMRunPermissionCeiling(channel.capability)),
  );

  const prerequisites: BrowserAutomationPrerequisite[] = [];
  if (!masterSwitchOn) prerequisites.push('master-switch-off');
  // Only worth saying while the switch is on: with it off, "no allowed site" is
  // a second reason for something already fully explained by the first.
  else if (reachableSiteCount === 0) prerequisites.push('no-allowed-site');

  const counts: Record<BrowserAutomationSource, number> = {
    schedule: scheduledTasks.length,
    trigger: browserCapableTriggers.length,
    im: browserCapableChannels.length,
  };

  return {
    counts,
    anyBrowserCapable: counts.schedule + counts.trigger + counts.im > 0,
    prerequisites,
    entries,
  };
}
