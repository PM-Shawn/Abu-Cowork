import type { BrowserGateEvaluation, BrowserGateFacts } from './browserGateEvaluation';
import type { resolveBrowserPermissionConfig } from './browserPermissionConfig';
import { getPermissionStrategy } from './permissionMode';
import { decideStateChangingToolUnderRunPermissionCeiling } from './runPermissionCeiling';

export type BrowserPermissionGateFacts = Omit<BrowserGateFacts, 'policy' | 'siteVerdict' | 'masterSwitchUnattended' | 'conversationGrant'> & {
  configured: ReturnType<typeof resolveBrowserPermissionConfig>;
  highRisk: boolean;
};

/** Shared configuration; context chooses the confirmation channel only. */
export function evaluateBrowserPermissionGate(facts: BrowserPermissionGateFacts): BrowserGateEvaluation {
  const { configured, opClass, runMode, highRisk } = facts;
  const stateChanging = opClass !== 'read-only';
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
  // Preserve the existing high-risk restriction for unattended operations.
  if (runMode === 'unattended' && highRisk) return deny('high-risk-site');
  const explicitlyAllowed = configured.decision === 'allow' && !highRisk;
  const modeDecision = getPermissionStrategy(facts.permissionMode).decideOtherTool(
    stateChanging ? 'state-changing' : 'read-only', explicitlyAllowed,
  );
  const needsConfirmation = configured.decision === 'ask' || (stateChanging && (highRisk || modeDecision !== 'allow'));
  if (!needsConfirmation) return result;
  if (runMode === 'attended' && !facts.confirmationChannelAvailable) return deny('approval-refused');
  return { ...result, ask: {
    channel: runMode === 'attended' ? 'dialog' : 'im',
    offersPersistentGrant: runMode === 'attended' && opClass !== 'scripting' && !highRisk && !facts.answersPageDialog && facts.originKnown,
    refusedReason: runMode === 'attended' ? 'user-cancelled' : 'approval-refused',
  } };
}
