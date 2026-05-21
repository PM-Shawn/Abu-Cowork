/**
 * Notice System core types.
 *
 * A Notice = one proactive event raised by a producer (behavior sensing /
 * self-evolving skills / scheduler / IM / agent core) onto the Bus.
 * Gate filters it; Router dispatches it to delivery channels (in-chat
 * card / sidebar badge / menubar / system notification / pet bubble).
 *
 * This file defines the wire format — Notice + NoticeType + Tier +
 * default tier/ttl tables + zod schema for runtime validation. Producers
 * depend on these types; subscribers receive Notice objects unchanged.
 *
 * See `memory/project_notice_system.md` for the full PRD and
 * `memory/project_notice_system_techspec.md` for implementation notes.
 */

import { z } from 'zod';

// ── Tier ────────────────────────────────────────────────────────────────

/**
 * Importance tier.
 *   L1 — 不可吞（time-critical / blocking）；Gate must not drop
 *   L2 — 可吞 (valued but not urgent)；subject to per-hour quota + inbox
 *   L3 — 只动状态灯；never raises a bubble
 */
export type NoticeTier = 'L1' | 'L2' | 'L3';

// ── Source ──────────────────────────────────────────────────────────────

/** Upstream producer that emitted this notice. */
export type NoticeSource =
  | 'behavior'
  | 'self_evolving'
  | 'scheduler'
  | 'im'
  | 'agent'
  | 'core';

// ── NoticeType ──────────────────────────────────────────────────────────

/**
 * Event type enumeration. Keep in sync with the Producers table in
 * PRD-01 (`project_notice_system.md`).
 */
export type NoticeType =
  // L1 必达
  | 'meeting_prep'
  | 'permission_request'
  | 'user_input_needed'
  | 'agent_error'
  | 'schedule_fired'
  | 'task_complete'
  // L2 可吞
  | 'skill_proposal_offer'
  | 'skill_draft_ready'
  | 'skill_patch'
  | 'stuck_detection'
  | 'im_inbound'
  // L2 可吞（续）
  | 'update_available'
  // L3 只动状态灯
  | 'context_resume'
  | 'deep_focus_enter'
  | 'deep_focus_exit';

/**
 * Default tier per event type. Producers can override via
 * PublishInput.tier, but the default should cover >99% of cases.
 */
export const DEFAULT_TIER: Record<NoticeType, NoticeTier> = {
  meeting_prep: 'L1',
  permission_request: 'L1',
  user_input_needed: 'L1',
  agent_error: 'L1',
  schedule_fired: 'L1',
  task_complete: 'L1',
  skill_proposal_offer: 'L2',
  skill_draft_ready: 'L2',
  skill_patch: 'L2',
  stuck_detection: 'L2',
  im_inbound: 'L2',
  update_available: 'L2',
  context_resume: 'L3',
  deep_focus_enter: 'L3',
  deep_focus_exit: 'L3',
};

/**
 * Default TTL (ms) per event type. 0 = no expiry; blocks indefinitely
 * until resolved externally (e.g. permission_request relies on the
 * agent's own timeout, not the Notice TTL).
 */
export const DEFAULT_TTL_MS: Record<NoticeType, number> = {
  meeting_prep: 15 * 60 * 1000,
  permission_request: 0,
  user_input_needed: 0,
  agent_error: 6 * 60 * 60 * 1000,
  schedule_fired: 60 * 60 * 1000,
  task_complete: 6 * 60 * 60 * 1000,
  skill_proposal_offer: 24 * 60 * 60 * 1000,
  skill_draft_ready: 24 * 60 * 60 * 1000,
  skill_patch: 24 * 60 * 60 * 1000,
  stuck_detection: 30 * 60 * 1000,
  im_inbound: 0,
  update_available: 7 * 24 * 60 * 60 * 1000,
  context_resume: 10 * 60 * 1000,
  deep_focus_enter: 10 * 60 * 1000,
  deep_focus_exit: 10 * 60 * 1000,
};

// ── Notice shape ────────────────────────────────────────────────────────

/** One notice event. */
export interface Notice {
  /** Unique id (base36 timestamp + random suffix, prefixed `ntc_`). */
  id: string;
  /** Event type — drives default tier/ttl and router decisions. */
  type: NoticeType;
  /** Importance tier. */
  tier: NoticeTier;
  /** Source producer. */
  source: NoticeSource;
  /** Event-specific payload. Concrete shapes live in producer modules. */
  payload: Record<string, unknown>;
  /**
   * Semantic fingerprint for 2h-window dedup. Producers compute this per
   * the dedupKey rules table in PRD-01. Empty string is not allowed.
   */
  dedupKey: string;
  /** Creation timestamp (ms since epoch). */
  createdAt: number;
  /** Optional TTL (ms). Overrides DEFAULT_TTL_MS. 0 = no expiry. */
  ttl?: number;
}

/**
 * Zod schema — validates the full Notice shape at publish time. Catches
 * producer bugs (wrong type, missing dedupKey, negative timestamps)
 * before they poison the Bus.
 */
export const NoticeSchema = z.object({
  id: z.string().min(1),
  type: z.enum([
    'meeting_prep',
    'permission_request',
    'user_input_needed',
    'agent_error',
    'schedule_fired',
    'task_complete',
    'skill_proposal_offer',
    'skill_draft_ready',
    'skill_patch',
    'stuck_detection',
    'im_inbound',
    'update_available',
    'context_resume',
    'deep_focus_enter',
    'deep_focus_exit',
  ]),
  tier: z.enum(['L1', 'L2', 'L3']),
  source: z.enum(['behavior', 'self_evolving', 'scheduler', 'im', 'agent', 'core']),
  payload: z.record(z.string(), z.unknown()),
  dedupKey: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  ttl: z.number().int().nonnegative().optional(),
});

// ── Publish input ───────────────────────────────────────────────────────

/**
 * Producer-side input for `bus.publish`. `id` and `createdAt` are
 * assigned by the Bus; `tier` and `ttl` default from the tables above
 * when omitted.
 */
export interface PublishInput {
  type: NoticeType;
  source: NoticeSource;
  payload: Record<string, unknown>;
  dedupKey: string;
  tier?: NoticeTier;
  ttl?: number;
}

// ── ID generation ───────────────────────────────────────────────────────

/**
 * Generate a stable notice id. Same base36(timestamp)+random pattern as
 * chatStore / conversation ids, prefixed `ntc_` so grep-ability stays
 * high across logs.
 */
export function generateNoticeId(): string {
  return (
    'ntc_' +
    Date.now().toString(36) +
    Math.random().toString(36).substring(2, 8)
  );
}
