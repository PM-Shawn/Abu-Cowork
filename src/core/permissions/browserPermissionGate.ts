import type { BrowserDenialReasonCode, BrowserOperationClass } from './browserToolPolicy';
import type { resolveBrowserPermissionConfig } from './browserPermissionConfig';
import { getPermissionStrategy, type PermissionMode } from './permissionMode';
import {
  decideStateChangingToolUnderRunPermissionCeiling,
  type CeilingDecision,
  type RunPermissionCeiling,
} from './runPermissionCeiling';

export interface BrowserGateAsk {
  /** `'dialog'`: in-app confirmation (someone is watching). `'im'`: the unattended approval round-trip. */
  channel: 'dialog' | 'im';
  /** Whether the confirmation may also offer 「以后都允许该网站」. */
  offersPersistentGrant: boolean;
  /** The code to report if the human refuses, or nobody answers in time. */
  refusedReason: BrowserDenialReasonCode;
}

/** Bookkeeping `registry.ts` reads next to the decision (grant minting, denial streak). */
export interface BrowserGateIntermediates {
  scriptAllowedByPolicy: boolean;
  dialogAnswerAllowedByPolicy: boolean;
  /** The configured row says 「每次询问」. */
  asksEveryTime: boolean;
  granted: boolean;
}

export interface BrowserGateEvaluation {
  /** The outcome ASSUMING every confirmation in `ask` is approved. */
  outcome: 'allow' | 'deny';
  /** Set exactly when `outcome === 'deny'`. */
  denialReason: BrowserDenialReasonCode | null;
  /** Set when a human is asked before `outcome` is reached. */
  ask: BrowserGateAsk | null;
  /** Non-null exactly when the refusal came from the run's capability ceiling. */
  ceilingDecision: CeilingDecision | null;
  intermediates: BrowserGateIntermediates;
}

export interface BrowserPermissionGateFacts {
  /** Read-only / interactive / scripting / upload: for a batch, its heaviest step. */
  opClass: BrowserOperationClass;
  runMode: 'attended' | 'unattended';
  /** The user's global permission mode. */
  permissionMode: PermissionMode;
  /** The run's host-owned capability ceiling, or null for an ordinary chat turn. */
  runPermissionCeiling: RunPermissionCeiling | null;
  /** Whether the tool acts on a page at all (`get_tabs` and the like do not). */
  toolTargetsPage: boolean;
  originResolved: boolean;
  /** Whether the tool ANSWERS a page's own dialog (`handle_dialog`). */
  answersPageDialog: boolean;
  /** The host observed a sign-in wall. Advisory: only ever used to REFUSE. */
  loginRequired: boolean;
  /** Without a way to deliver a confirmation, an ask fails closed. */
  confirmationChannelAvailable: boolean;
  /** Whether the origin is known, which is what a persistent grant is keyed by. */
  originKnown: boolean;
  configured: ReturnType<typeof resolveBrowserPermissionConfig>;
  /**
   * The call touches money: an action (not a page visit) on a money-movement
   * domain, or anything at all on one in an unattended run. Asks every time,
   * never remembered; refused unattended.
   */
  highRisk: boolean;
  /**
   * The call ACTS (clicks, fills, submits, runs a script, uploads) on a
   * government site. Opening and reading one is not acting. Asked once per
   * task when attended; refused unattended. Optional so callers that predate
   * the rule read as "not a government action".
   */
  governmentAction?: boolean;
  /** This task already approved acting on that government site (`taskGrants.ts`). */
  governmentTaskGranted?: boolean;
  /** 脚本要在嵌入的第三方区域里执行：站点长期许可会连带宿主页面整站放开脚本，所以不提供 */
  scriptInEmbeddedRegion: boolean;
}

/** Shared configuration; context chooses the confirmation channel only. */
export function evaluateBrowserPermissionGate(facts: BrowserPermissionGateFacts): BrowserGateEvaluation {
  const { configured, opClass, runMode, highRisk } = facts;
  const stateChanging = opClass !== 'read-only';
  const governmentAction = facts.governmentAction === true && !highRisk;
  const governmentAsk = governmentAction && facts.governmentTaskGranted !== true;
  const result: BrowserGateEvaluation = {
    outcome: 'allow', denialReason: null, ask: null, ceilingDecision: null,
    intermediates: { scriptAllowedByPolicy: false, dialogAnswerAllowedByPolicy: false, asksEveryTime: configured.decision === 'ask', granted: false },
  };
  const deny = (reason: NonNullable<BrowserGateEvaluation['denialReason']>): BrowserGateEvaluation => ({ ...result, outcome: 'deny', denialReason: reason });
  if (configured.source === 'site-block') return deny('site-denied');
  if (configured.source === 'unverified-origin') return deny('origin-unverified');
  if (configured.decision === 'deny') return deny('policy-denied');
  if (stateChanging) {
    const ceiling = decideStateChangingToolUnderRunPermissionCeiling(facts.runPermissionCeiling, 'browser', configured.decision);
    if (ceiling.decision === 'deny') return { ...deny('capability-denied'), ceilingDecision: ceiling };
  }
  if (facts.toolTargetsPage && !facts.originResolved) return deny('origin-unverified');
  if (runMode === 'unattended' && stateChanging && facts.loginRequired) return deny('login-required');
  // Nobody can answer for money, or for acting in someone's name on a
  // government site, in an unattended run. Reading a government notice can.
  if (runMode === 'unattended' && (highRisk || governmentAction)) return deny('high-risk-site');
  const explicitlyAllowed = configured.decision === 'allow' && !highRisk;
  const modeDecision = getPermissionStrategy(facts.permissionMode).decideOtherTool(
    stateChanging ? 'state-changing' : 'read-only', explicitlyAllowed,
  );
  const needsConfirmation = configured.decision === 'ask'
    || (stateChanging && (highRisk || governmentAsk || modeDecision !== 'allow'));
  if (!needsConfirmation) return result;
  if (runMode === 'attended' && !facts.confirmationChannelAvailable) return deny('approval-refused');
  return { ...result, ask: {
    channel: runMode === 'attended' ? 'dialog' : 'im',
    // A government site is approved for the task, not for good: the approval
    // itself mints that task grant (`registry.ts`), so no site grant is offered.
    offersPersistentGrant: runMode === 'attended' && !highRisk && !governmentAction && !facts.answersPageDialog && facts.originKnown
      && !facts.scriptInEmbeddedRegion,
    refusedReason: runMode === 'attended' ? 'user-cancelled' : 'approval-refused',
  } };
}
