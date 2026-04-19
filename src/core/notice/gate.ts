/**
 * Notice Gate — filters publishes before they reach the Router.
 *
 * Pipeline: Bus → **Gate** → Router → Channels.
 *
 * Gate decides whether a Notice should pass through, be dropped, queued
 * to inbox (桌宠关 / 全屏场景), or have its tier degraded based on learned
 * user preferences.
 *
 * Day 3 skeleton — implemented:
 *   - L1 bypass (必达)
 *   - Fullscreen → queue_inbox (L2) or drop (L3)
 *   - Feedback rule match → drop or degrade
 *
 * Day 4 will add L2 per-hour quota + real feedback-rule reader from
 * memdir. DnD silencing is out-of-scope for MVP (decision 2026-04-19).
 *
 * `filter` is a pure function — callers assemble `GateContext`, Gate
 * returns a `GateDecision` with no side effects.
 */

import type { Notice, NoticeTier } from './types';

// ── Context ─────────────────────────────────────────────────────────────

/**
 * Pet capability state. Router uses this to decide whether `pet_bubble`
 * is a valid target; Gate consumes it via the context so future rules
 * (like "if pet is off, always queue L2 for inbox补推") can branch.
 */
export type PetState = 'off' | 'v1_no_bubble' | 'v2_with_bubble';

/** Everything Gate needs to make a filter decision. Producer-agnostic. */
export interface GateContext {
  now: number;
  mainWindowFocused: boolean;
  currentConversationId: string | null;
  petState: PetState;
  /** Fullscreen app name, if any (from Rust `notice_check_fullscreen`). */
  fullscreenApp: string | null;
  /**
   * Rolling L2 count within the current hour. Day 4 wires the real
   * sliding-window calculator; shape kept stable so gate.ts can
   * compile today.
   */
  recentL2Count: { windowStart: number; count: number };
  /** Parsed learned rules from feedback memory. Day 4 wires the reader. */
  userFeedbackHistory: FeedbackRule[];
}

/**
 * A single learned feedback rule. Day 4 will generate these by
 * aggregating notice_audit (e.g. "19-22 点 dismiss 率 >80% → degrade
 * L2 to L3 in that window"); for now the shape is forward-compatible
 * and tests inject inline rules.
 */
export interface FeedbackRule {
  /** Human-readable label for diagnostics / audit. */
  label: string;
  /** True if this rule applies to `notice` at `now`. */
  matches: (notice: Notice, now: number) => boolean;
  action: 'drop' | 'degrade';
  /** Target tier for `degrade`. Ignored for `drop`. */
  degradeTo?: NoticeTier;
}

// ── Decision ────────────────────────────────────────────────────────────

export type GateDecision =
  | { action: 'allow' }
  | { action: 'drop'; reason: string }
  | { action: 'degrade_tier'; to: NoticeTier; reason: string }
  | { action: 'queue_inbox'; reason: string };

// ── API ─────────────────────────────────────────────────────────────────

/** Decide what to do with a notice. Pure — no I/O, no mutation. */
export function filter(notice: Notice, ctx: GateContext): GateDecision {
  // L1 不可吞 — bypass all rules
  if (notice.tier === 'L1') return { action: 'allow' };

  // Fullscreen app present → protect user; L3 dropped, L2 queued
  if (ctx.fullscreenApp) {
    if (notice.tier === 'L3') {
      return { action: 'drop', reason: `fullscreen:${ctx.fullscreenApp}` };
    }
    return { action: 'queue_inbox', reason: `fullscreen:${ctx.fullscreenApp}` };
  }

  // Learned feedback rules — first match wins
  for (const rule of ctx.userFeedbackHistory) {
    if (!rule.matches(notice, ctx.now)) continue;
    if (rule.action === 'drop') {
      return { action: 'drop', reason: `rule:${rule.label}` };
    }
    if (rule.action === 'degrade' && rule.degradeTo) {
      return {
        action: 'degrade_tier',
        to: rule.degradeTo,
        reason: `rule:${rule.label}`,
      };
    }
  }

  // L2 per-hour quota — Day 4 wires real sliding-window check. Until
  // then, the branch is left as a comment anchor so the Day 4 PR is a
  // targeted uncomment + impl rather than structural surgery.
  //
  // if (notice.tier === 'L2' && !hasL2Quota(ctx.recentL2Count, ctx.now)) {
  //   return { action: 'queue_inbox', reason: 'l2_quota_exceeded' };
  // }

  return { action: 'allow' };
}
