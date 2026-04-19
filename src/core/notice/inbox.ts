/**
 * Notice Inbox — L2 queue for notices that Gate deferred (queue_inbox).
 *
 * Storage: `{app_data_dir}/notice.sqlite` (notice_inbox table).
 * When Gate returns queue_inbox (fullscreen, quota exceeded), the
 * pipeline stores the notice here. Later, when context changes (user
 * returns, window refocused), `drainInbox` re-routes pending items
 * through the Router so they land on whichever channels are valid now
 * (sidebar badge / menubar / chat card).
 *
 * MVP note: the PRD scenario-5 "main window toast strip" is Phase 2
 * (v2, shipping alongside the desktop pet). For v0.13.0 we reuse
 * existing Phase-1 channels to avoid silent-loss — the user sees a
 * sidebar badge / menubar count when they return, not a bespoke toast.
 *
 * Lifecycle:
 *   1. Pipeline → queueToInbox(notice) on queue_inbox decision
 *   2. Window refocus / app boot → drainInbox(ctx) re-routes pending
 *      items, skipping Gate to avoid re-queuing the same L2
 *   3. Periodic cleanup removes expired + delivered entries
 */

import { invoke } from '@tauri-apps/api/core';
import type { Notice } from './types';
import type { GateContext } from './gate';
import { route } from './router';
import { dispatchTargets } from './pipeline';

// ── Types (mirror Rust InboxEntry) ─────────────────────────────────────

export interface InboxEntry {
  id: number;
  notice_id: string;
  notice_json: string;
  tier: string;
  queued_at: number;
  expires_at: number;
  delivered: boolean;
}

// ── Write ──────────────────────────────────────────────────────────────

/**
 * Queue a notice to inbox. Fire-and-forget.
 */
export function queueToInbox(notice: Notice): void {
  const entry = {
    notice_id: notice.id,
    notice_json: JSON.stringify(notice),
    tier: notice.tier,
    queued_at: notice.createdAt,
    expires_at: notice.createdAt + (notice.ttl ?? 24 * 60 * 60 * 1000),
  };

  invokeInbox('notice_inbox_insert', { entry }).catch((err) => {
    console.warn('[notice:inbox] queue failed:', err);
  });
}

// ── Read ───────────────────────────────────────────────────────────────

/** Get all pending (undelivered, unexpired) inbox entries. */
export async function getPendingInbox(): Promise<InboxEntry[]> {
  const now = Date.now();
  return invokeInbox<InboxEntry[]>('notice_inbox_pending', { now });
}

// ── Lifecycle ──────────────────────────────────────────────────────────

/** Mark a notice as delivered (after toast/badge shown). */
export function markDelivered(noticeId: string): void {
  invokeInbox('notice_inbox_mark_delivered', { noticeId }).catch((err) => {
    console.warn('[notice:inbox] mark delivered failed:', err);
  });
}

/** Remove expired + delivered entries. Returns count deleted. */
export async function cleanupInbox(): Promise<number> {
  const now = Date.now();
  return invokeInbox<number>('notice_inbox_cleanup', { now });
}

// ── Drain ──────────────────────────────────────────────────────────────

const DEFAULT_DRAIN_CAP = 20;

/**
 * Re-route pending inbox entries through the current Router context and
 * mark each one delivered. Returns the number of notices dispatched.
 *
 * Bypasses Gate: a notice queued because `fullscreenApp != null` would
 * just be queued again if we re-ran filter(). The caller is responsible
 * for checking `ctx.fullscreenApp` before calling — if the user is still
 * in a fullscreen app we should defer until the next focus event.
 *
 * Corrupt JSON / expired entries are silently skipped. `cap` bounds the
 * per-call dispatch count so a stale queue doesn't flood the sidebar.
 */
export async function drainInbox(
  ctx: GateContext,
  opts?: { cap?: number },
): Promise<number> {
  const cap = opts?.cap ?? DEFAULT_DRAIN_CAP;

  let pending: InboxEntry[];
  try {
    pending = await getPendingInbox();
  } catch {
    return 0;
  }
  if (pending.length === 0) return 0;

  let delivered = 0;
  for (const entry of pending) {
    if (delivered >= cap) break;
    if (entry.expires_at < ctx.now) continue;

    let notice: Notice;
    try {
      notice = JSON.parse(entry.notice_json) as Notice;
    } catch {
      continue;
    }

    const targets = route(notice, ctx);
    if (targets.length === 0) continue;

    dispatchTargets(notice, targets);
    markDelivered(notice.id);
    delivered++;
  }
  return delivered;
}

// ── Helpers ────────────────────────────────────────────────────────────

async function invokeInbox<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  try {
    const result = invoke(cmd, args);
    if (result && typeof (result as Promise<T>).then === 'function') {
      return await (result as Promise<T>);
    }
    return result as T;
  } catch (err) {
    console.warn(`[notice:inbox] ${cmd} failed:`, err);
    throw err;
  }
}
