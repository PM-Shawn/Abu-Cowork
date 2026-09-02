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
}

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
      };
    }
    return {
      approved: true,
      reason: result.reason ?? 'approved',
      ...(typeof result.userFacingReason === 'string' && result.userFacingReason !== ''
        ? { userFacingReason: result.userFacingReason }
        : {}),
    };
  } catch (error) {
    return {
      approved: false,
      reason: `unattended confirmation failed: ${error instanceof Error ? error.message : String(error)}`,
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
 */
export function createUnattendedConfirmation(
  options: CreateUnattendedConfirmationOptions,
): UnattendedConfirmCallback {
  return async (info: ConfirmationInfo) => {
    // Already-refused notification (see `ConfirmationInfo.deniedNotice`):
    // account for it and stop. It must never reach the resolver — asking a
    // human to approve something that is already denied would be a lie, and
    // once the resolver is a real IM round-trip it would also spam the chat.
    if (info.deniedNotice !== undefined) {
      options.onDenied?.(info.deniedNotice, info);
      return false;
    }
    const result = await resolveUnattendedConfirmation({
      info,
      source: options.source,
      ...(options.conversationId !== undefined ? { conversationId: options.conversationId } : {}),
      ...(options.imTarget !== undefined ? { imTarget: options.imTarget } : {}),
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
 * A browser confirmation that arrives without an operation class is treated as
 * `scripting`, the strictest class.
 */
export function mayUnattendedTierApproveBrowser(info: ConfirmationInfo): boolean {
  const settings = getSettingsReader().getSnapshot();
  return (
    decideBrowserOperation({
      opClass: info.browserOperationClass ?? 'scripting',
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
