/**
 * The single confirmation seam for unattended runs.
 *
 * Three entry points execute agent turns with nobody in front of the screen —
 * the scheduler, the trigger engine, and the IM channel router. Each of them
 * used to hand `registry.ts` its own hand-rolled "always deny" closure, so
 * "what happens when an unattended run needs approval?" was answered in three
 * places with three different amounts of care (the IM `full` tier answered it
 * with `async () => true`, i.e. auto-approving browser scripting over chat).
 *
 * This module is that answer, once:
 * - `resolveUnattendedConfirmation` is the seam. Its DEFAULT implementation is
 *   fail-closed — an unattended run has no channel to ask through, so the
 *   request is refused and the reason recorded. A later task swaps in an IM
 *   approval round-trip via `setUnattendedConfirmationResolver`.
 * - `createUnattendedConfirmation` wraps that seam into the
 *   `CommandConfirmCallback` shape the three entry points pass to the agent
 *   loop, with an `onDenied` hook so a caller can keep its own denial log
 *   (the scheduler surfaces those lines in the run result).
 *
 * Today the behavior is identical to the closures it replaces (always false);
 * the point is that it is now ONE behavior with one place to change.
 */

import type { ConfirmationInfo } from '../tools/commandSafety';
import { getSettingsReader } from '../agent/ports/settingsReader';
import { getLoopContext } from '../agent/permissionBridge';
import { createLogger } from '../logging/logger';
import {
  DEFAULT_BROWSER_OPERATION_POLICY,
  decideBrowserOperation,
  getSiteVerdict,
} from './browserToolPolicy';

/**
 * Structurally identical to `registry.ts`'s `CommandConfirmCallback`, spelled
 * out here rather than imported so this module has no edge — not even a
 * type-only one — back into the registry it is consumed by.
 */
const logger = createLogger('unattendedConfirmation');

type UnattendedConfirmCallback = (
  info: ConfirmationInfo,
  loopId?: string,
) => Promise<boolean>;

/** Where an unattended run could deliver an approval request, when the run
 *  came from an IM channel. Carried through the seam so the IM approval
 *  implementation knows who to ask; unused by the fail-closed default. */
export interface UnattendedImTarget {
  platform: string;
  /** Configured channel id, used to pick the outbound adapter. */
  channelId?: string;
  /** The chat the run is answering — where an approval prompt would land.
   *  Absent when the inbound message carried no reply target, which is itself
   *  a reason an approval can never be delivered. */
  chatId?: string;
  /**
   * The person this run belongs to. When set, only their reply counts as an
   * answer: a group chat is not a voting booth, and a bystander must not be
   * able to approve automation running inside someone else's logged-in
   * browser sessions. Absent means "anyone in that chat may answer", which is
   * correct for a 1:1 chat and the only option when the binding names nobody.
   */
  senderId?: string;
}

export type UnattendedRunSource = 'scheduler' | 'trigger' | 'im';

export interface UnattendedConfirmationRequest {
  /** What the agent wants to do, exactly as `registry.ts` describes it to a
   *  desktop confirmation dialog. */
  info: ConfirmationInfo;
  /** Which unattended entry point this run came from. */
  source: UnattendedRunSource;
  conversationId?: string;
  /**
   * Identity of the single agent run this request belongs to (the loop id).
   * An approval channel uses it to scope coalescing and answer caching to ONE
   * run: a tool like `execute_js` can be called dozens of times in a turn, and
   * without a run key every call would be a separate message to a human.
   * Absent means "this run cannot be identified", and a channel must then
   * refuse to cache — a cached answer with no run boundary would silently
   * outlive the decision it belongs to.
   */
  runKey?: string;
  imTarget?: UnattendedImTarget;
  /**
   * The run's cancellation signal. An approval channel that waits minutes for
   * a human MUST honor it: without this, pressing Stop leaves a prompt sitting
   * in a chat, and a `同意` typed afterwards would be swallowed as the answer
   * to a run that no longer exists instead of reaching the model as an
   * ordinary message. In-process only — never serialized (see
   * `ToolExecutionContext.abortSignal`).
   */
  abortSignal?: AbortSignal;
}

export interface UnattendedConfirmationResult {
  approved: boolean;
  /** Why — recorded in the run's denial log and surfaced to the user. Always
   *  set, including on approval, so an audit line can say what happened.
   *  Diagnostic English, aimed at logs and the tool result. */
  reason: string;
  /**
   * The localized sentence a human should read instead of `reason`, when the
   * channel knows something the caller's generic copy cannot say — "you
   * declined this in chat" and "nobody answered within 10 minutes" are not the
   * same event as "there is no confirmation channel". Optional: a channel that
   * has nothing better to say omits it and the caller keeps its own wording.
   */
  userFacingReason?: string;
  /**
   * U7 / G2 — the machine-readable audit trail. REQUIRED (U7 review / B5).
   *
   * Required as an OBJECT, with every code inside it optional. That split is
   * the whole point:
   *
   * - Required on the outside makes the trail fail-loud. The boundary below is
   *   a WHITELIST — it rebuilds the result rather than spreading it — and G2's
   *   first version was silently dropped there: the producer's unit tests were
   *   green and the feature was a no-op in production. With one required
   *   object, the boundary cannot compile without carrying it, and a future
   *   resolver author cannot forget it by omission.
   * - Optional inside lets a caller that asked NOBODY say so honestly. The
   *   fail-closed default resolver is not an approval channel at all, so it
   *   returns `audit: {}` — "there was no human decision", which is a
   *   different statement from "a decision happened and we lost it".
   *
   * Why this is worth the churn: an audit trail that can silently become
   * empty is worse than one that is absent, and this trail records the ONLY
   * human decision in the entire unattended pipeline.
   */
  audit: UnattendedConfirmationAudit;
}

export interface UnattendedConfirmationAudit {
  /**
   * The "同意" a person types into a chat at 09:14 is the ONLY human decision
   * in the entire unattended path, and until U7 it landed without a trace:
   * the run acted on it and nothing anywhere recorded that a human had said
   * yes. These two fields are what lets the morning report say "you approved
   * 2 and declined 1" instead of staying silent about the one moment a person
   * was actually involved.
   *
   * `outcome` is a code, never a parsed sentence — `reason` is diagnostic
   * English and `userFacingReason` is localized, and neither is safe to
   * aggregate on.
   *
   * `fresh` distinguishes a real round-trip from a replayed answer. A tool
   * like `execute_js` is called dozens of times per turn, and the channel
   * coalesces those onto ONE prompt: without this flag an audit that counted
   * resolver returns would report "you approved 14 times" for a single "同意".
   * Only the call that actually owned the round-trip is `fresh`.
   *
   * Both are optional because the fail-closed default resolver is not an
   * approval channel at all — it never asked anyone, so it has no human
   * decision to report, and the gate's own denial signal already records that
   * refusal.
   */
  outcome?: UnattendedApprovalOutcome;
  fresh?: boolean;
}

/**
 * What became of one approval round-trip.
 *
 * Deliberately preserves the distinctions `pendingApprovals.ts` already makes
 * rather than collapsing them: at 8am, "you declined it", "nobody answered in
 * five minutes" and "there was nobody to ask" call for three different
 * actions from the user.
 */
export type UnattendedApprovalOutcome =
  | 'approved'
  | 'declined'
  | 'timeout'
  | 'no-channel'
  | 'too-many'
  | 'undeliverable'
  | 'aborted';

export type UnattendedConfirmationResolver = (
  request: UnattendedConfirmationRequest,
) => Promise<UnattendedConfirmationResult>;

/**
 * Fail-closed default: no approval channel exists for an unattended run, so
 * nothing that needs approval may run. Deliberately NOT "ask the desktop
 * dialog" — nobody is there to answer it, and a run that blocks on an
 * unanswerable prompt is worse than one that reports a clear refusal.
 */
const failClosedResolver: UnattendedConfirmationResolver = async (request) => ({
  approved: false,
  reason: `confirmation is unavailable in this unattended run (${request.source})`,
  // Nobody was asked, so there is no human decision to report. An empty audit
  // says exactly that — which is why the codes inside it are optional.
  audit: {},
});

let resolver: UnattendedConfirmationResolver = failClosedResolver;

/** Install a real approval channel (IM round-trip). Passing `null` restores
 *  the fail-closed default. */
export function setUnattendedConfirmationResolver(
  next: UnattendedConfirmationResolver | null,
): void {
  resolver = next ?? failClosedResolver;
}

export function __resetUnattendedConfirmationForTests(): void {
  resolver = failClosedResolver;
}

/**
 * Ask whatever approval channel this build has for an unattended run.
 * Never throws: a resolver that rejects is treated as a refusal, because a
 * broken approval channel must not become an open one.
 */
const APPROVAL_OUTCOMES: ReadonlySet<string> = new Set<UnattendedApprovalOutcome>([
  'approved', 'declined', 'timeout', 'no-channel', 'too-many', 'undeliverable', 'aborted',
]);

/**
 * Re-validate the audit fields at the boundary, exactly as the decision itself
 * is re-validated above.
 *
 * This function has to exist because the boundary is a WHITELIST: it rebuilds
 * the result rather than spreading it, so a field the resolver sets and this
 * function does not copy is silently gone by the time the gate reads it. That
 * is the correct design (a malformed resolver must not be able to smuggle
 * anything through) — but it means every new field is opt-in, and forgetting
 * one produces a feature that works in the unit test of the producer and does
 * nothing in production.
 *
 * Two rules beyond shape checking:
 * - An unknown `outcome` string is dropped, not passed on. The report
 *   aggregates on these codes; an unrecognised one would land in a bucket
 *   nobody renders.
 * - An `outcome` that CONTRADICTS the decision is dropped. A resolver that
 *   refuses while reporting 'approved' must not be able to write "a human
 *   approved this" into the user's audit trail — the decision is authoritative
 *   and the audit must agree with it or stay silent.
 */
function auditFieldsOf(
  result: UnattendedConfirmationResult | undefined,
  approved: boolean,
): UnattendedConfirmationAudit {
  const raw = result?.audit;
  const outcome = typeof raw?.outcome === 'string' && APPROVAL_OUTCOMES.has(raw.outcome)
    ? raw.outcome
    : undefined;
  const consistent = outcome === undefined
    ? undefined
    : approved === (outcome === 'approved') ? outcome : undefined;
  if (outcome !== undefined && consistent === undefined) {
    // Discarding this silently is the same blindness class as dropping the
    // field: a resolver that disagrees with itself is a bug in the approval
    // channel, and the audit trail is exactly where nobody would notice.
    logger.warn('discarded an approval outcome that contradicts the decision', {
      outcome,
      approved,
    });
  }
  return {
    ...(consistent !== undefined ? { outcome: consistent } : {}),
    ...(raw?.fresh === true ? { fresh: true } : {}),
  };
}

export async function resolveUnattendedConfirmation(
  request: UnattendedConfirmationRequest,
): Promise<UnattendedConfirmationResult> {
  try {
    const result = await resolver(request);
    // Guard the boundary: a resolver returning a malformed value must not
    // read as approval.
    if (!result || result.approved !== true) {
      return {
        approved: false,
        reason: result?.reason ?? 'unattended confirmation was refused',
        ...(typeof result?.userFacingReason === 'string' && result.userFacingReason !== ''
          ? { userFacingReason: result.userFacingReason }
          : {}),
        audit: auditFieldsOf(result, false),
      };
    }
    return {
      approved: true,
      reason: result.reason ?? 'approved',
      ...(typeof result.userFacingReason === 'string' && result.userFacingReason !== ''
        ? { userFacingReason: result.userFacingReason }
        : {}),
      audit: auditFieldsOf(result, true),
    };
  } catch (error) {
    return {
      approved: false,
      reason: `unattended confirmation failed: ${error instanceof Error ? error.message : String(error)}`,
      // A resolver that threw told us nothing about a human decision.
      audit: {},
    };
  }
}

export interface CreateUnattendedConfirmationOptions {
  source: UnattendedRunSource;
  conversationId?: string;
  imTarget?: UnattendedImTarget;
  /** Called with the refusal reason whenever the request is not approved —
   *  the hook the scheduler uses to build its user-visible denial summary and
   *  the trigger/IM tiers use for their console trail. */
  onDenied?: (reason: string, info: ConfirmationInfo) => void;
}

/**
 * Build the `commandConfirmCallback` an unattended entry point hands to the
 * agent loop. Same shape as the desktop dialog callback, so no caller needs to
 * know whether a human is reachable.
 *
 * The registry calls this as `(info, loopId)` on the run_command and
 * self-extension paths (its browser path builds the seam request itself). The
 * loop id is the run: it becomes the request's `runKey`, and the run's abort
 * signal is looked up from the loop-context registry the same way the
 * registry resolves it for its AI reviewer (`getLoopContext(loopId)?.signal`).
 * Dropping it here would hand the approval channel a prompt Stop cannot
 * cancel and no boundary to coalesce inside.
 */
export function createUnattendedConfirmation(
  options: CreateUnattendedConfirmationOptions,
): UnattendedConfirmCallback {
  return async (info: ConfirmationInfo, loopId?: string) => {
    // Already-refused notification (see `ConfirmationInfo.deniedNotice`):
    // account for it and stop. It must never reach the resolver — asking a
    // human to approve something that is already denied would be a lie, and
    // once the resolver is a real IM round-trip it would also spam the chat.
    if (info.deniedNotice !== undefined) {
      options.onDenied?.(info.deniedNotice, info);
      return false;
    }
    const abortSignal = loopId !== undefined ? getLoopContext(loopId)?.signal : undefined;
    const result = await resolveUnattendedConfirmation({
      info,
      source: options.source,
      ...(options.conversationId !== undefined ? { conversationId: options.conversationId } : {}),
      ...(loopId !== undefined ? { runKey: loopId } : {}),
      ...(options.imTarget !== undefined ? { imTarget: options.imTarget } : {}),
      ...(abortSignal !== undefined ? { abortSignal } : {}),
    });
    if (!result.approved) options.onDenied?.(result.reason, info);
    return result.approved;
  };
}

/**
 * Tell an unattended run's confirmation callback that an action was refused,
 * so the run can account for it — the scheduler turns these into the
 * "blocked acting on example.com" line in its run result, which before this
 * existed was the ONLY way a 3am task explained why it achieved nothing.
 *
 * This is needed because the browser gate now refuses unattended actions on
 * its own (master switch off, policy deny, blocked site, unallowed site)
 * instead of refusing by way of a callback that returned false — which is
 * what used to feed the accounting. Notifying keeps that record without
 * giving the callback a vote: the decision is already made, the return value
 * is discarded, and a throwing callback cannot change the outcome.
 */
export async function notifyUnattendedDenial(
  callback: ((info: ConfirmationInfo, loopId?: string) => Promise<boolean>) | undefined,
  info: ConfirmationInfo & { deniedNotice: string },
  loopId?: string,
): Promise<void> {
  if (!callback) return;
  try {
    await callback(info, loopId);
  } catch {
    // Accounting is best-effort bookkeeping. A callback that throws must not
    // turn a clean refusal into a thrown tool error.
  }
}

/**
 * Whether an unattended run's capability TIER may approve this browser
 * confirmation at all — the independent operation-class check that sits above
 * `authGate`'s IM tiers and `triggerPermission`'s trigger tiers.
 *
 * A tier is a ceiling: it may only remove authority. Before this existed, the
 * IM `full` tier's `commandConfirmCallback: async () => true` auto-approved
 * every browser confirmation reaching it — including `execute_js`, i.e. a chat
 * message could get arbitrary code run inside the user's logged-in sessions
 * with nobody approving anything. `registry.ts` now decides browser operations
 * against the operation-class policy before any callback runs, so that hole is
 * already closed at the gate; this function closes it a second time at the
 * tier, so a future gate refactor (or a new caller of `getCallbacksForLevel`)
 * cannot reopen it.
 *
 * Returns true only when the unattended column of the operation policy says
 * `allow` for this operation class on this site. `ask` is NOT approval — the
 * tier is not an approval channel, `resolveUnattendedConfirmation` is.
 *
 * Scripting is NOT hard-coded here, and deliberately so: since the 2026-09-04
 * ruling the user may opt automatic-task scripting into `allow`, and this
 * function's whole job is to report what the policy says, not to re-litigate
 * it. The opt-in's own scoping (master switch + standing site grant + not
 * high-risk) is inside `decideBrowserOperation`, which is the single place
 * that rule lives.
 *
 * A browser confirmation that arrives with NO operation class is refused
 * outright. Until the ruling, defaulting it to `'scripting'` WAS that
 * refusal, because that cell had no allow tier; it no longer is, so the
 * fallback has to refuse on its own or an unclassified call would quietly
 * inherit the opt-in.
 */
export function mayUnattendedTierApproveBrowser(info: ConfirmationInfo): boolean {
  const opClass = info.browserOperationClass;
  if (opClass === undefined) return false;
  const settings = getSettingsReader().getSnapshot();
  return (
    decideBrowserOperation({
      opClass,
      runMode: 'unattended',
      policy: settings.browserOperationPolicy ?? DEFAULT_BROWSER_OPERATION_POLICY,
      masterSwitchUnattended: settings.allowUnattendedBrowser === true,
      siteVerdict: getSiteVerdict(
        info.browserOrigin ?? null,
        settings.browserSitePermissions ?? {},
      ),
    }) === 'allow'
  );
}
