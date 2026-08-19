/**
 * Always-ask floor — which actions may never be approved permanently.
 *
 * The product rule (permission plan §4.3/§4.6) is "danger level decides
 * whether you are allowed to settle it once and for all". Transfers,
 * deletions, permission/API-key changes, CAPTCHA solving, software installs,
 * and messages sent as the user must be asked every single time; only the
 * quiet, repetitive actions earn a standing grant. Competitor shells
 * implement the same asymmetry by dispatching the *allowed persistence
 * scopes* per request instead of letting the approval UI decide.
 *
 * This module is the floor for that decision. `allowPersistentGrant` on a
 * confirmation request is a request from the caller, not a guarantee — the
 * dialog runs it through here first, so a caller that gets a classification
 * wrong (or a future caller that forgets the rule) still cannot mint a
 * permanent grant for a high-consequence action. Same shape as Claude Code's
 * `classifierFloor`: a request may only ever be pushed stricter here, never
 * looser.
 *
 * ── What this can and cannot recognize ──
 * It reuses the classifications the codebase already has, and deliberately
 * does not invent a parallel taxonomy:
 *   - `DangerLevel` ('danger' / 'block') from `commandSafety` — covers data
 *     deletion, permission/ownership changes, credential writes, and package
 *     installs, all of which its pattern table already scores.
 *   - `kind === 'self-extension'` from `selfExtensionPolicy` — installing an
 *     MCP server, creating a subagent, rewriting the persona. These are the
 *     in-app form of "install software / change permissions".
 *   - Browser scripting tools, which `browserToolPolicy` already excludes by
 *     passing `allowPersistentGrant: false`.
 *
 * TODO — categories from §4.6 that no current classifier can identify, so
 * they are NOT covered here. Wiring any of them needs a real signal first
 * (page/action semantics), not a guess:
 *   - Money movement (transfer / payment / trade). A browser `click` on a
 *     bank's "confirm transfer" button is indistinguishable from any other
 *     click at this layer.
 *   - Sending a message as the user (mail / IM / social post) through the
 *     browser. Computer Use covers the *app* form of this: mail and IM
 *     bundle ids sit in `computerUsePolicy.json`'s `approvalRequired`, whose
 *     `modePolicy` row is 'confirm' in every permission mode and which has no
 *     persistent-grant concept at all — nothing to tighten there.
 *   - CAPTCHA solving.
 *   - Medical actions.
 */

import type { DangerLevel } from '../tools/commandSafety';

/** The subset of a confirmation request that decides the persistence floor. */
export interface PersistenceFloorInput {
  level: DangerLevel;
  kind?: 'command' | 'browser' | 'self-extension';
}

/**
 * Action classes that are always asked fresh, no matter what the requester
 * passed for `allowPersistentGrant`.
 */
export function isAlwaysAskAction(info: PersistenceFloorInput): boolean {
  // 'block' never reaches an approve button at all, but it belongs in the
  // floor so the answer stays right if the dialog ever renders one.
  if (info.level === 'danger' || info.level === 'block') return true;
  // Adding or rewriting a long-lived capability is the in-app "install
  // software / change permissions" case. It has no persistent-grant path
  // today; pinning it here keeps that true if one is ever added.
  if (info.kind === 'self-extension') return true;
  return false;
}

/**
 * Whether the confirmation dialog may offer a permanent (never-expiring)
 * grant for this request. The caller's `allowPersistentGrant` is a ceiling;
 * this function only ever lowers it.
 */
export function mayOfferPersistentGrant(
  info: PersistenceFloorInput & { allowPersistentGrant?: boolean },
): boolean {
  if (info.allowPersistentGrant !== true) return false;
  return !isAlwaysAskAction(info);
}
