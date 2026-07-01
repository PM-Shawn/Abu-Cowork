/**
 * Pet status bridge — main-window side (Phase B).
 *
 * Aggregates agent status across all conversations and emits
 * 'pet-status-update' events to the pet window. The pet window lives in
 * a separate WebView, so direct store access isn't available; Tauri
 * events are the bridge.
 *
 * Priority rule (PRD-02): waiting > error > running > done > idle.
 * Waiting is sourced from Notice System events (permission_request /
 * user_input_needed) — wired in Phase D. For v1-B we only see
 * ConversationStatus, which has no waiting value.
 *
 * Debounce: 3 seconds minimum between emits to prevent flicker when
 * multiple conversations transition together.
 */

import { emitTo } from '@tauri-apps/api/event';
import { useChatStore } from '@/stores/chatStore';
import { subscribe } from '@/core/notice/bus';
import type { ConversationStatus } from '@/types';
import type { Notice } from '@/core/notice/types';

export type PetStatus = 'idle' | 'running' | 'waiting' | 'error' | 'done';

const PRIORITY: Record<PetStatus, number> = {
  waiting: 5,
  error: 4,
  running: 3,
  done: 2,
  idle: 1,
};

const MIN_INTERVAL_MS = 3_000;
const PET_WINDOW_LABEL = 'pet';
const EVENT_NAME = 'pet-status-update';

let lastEmittedStatus: PetStatus | null = null;
let lastEmittedAt = 0;
let pendingTimer: number | null = null;
let started = false;
let storeUnsub: (() => void) | null = null;
let petBubbleUnsub: (() => void) | null = null;
let unresolvedBubbleCount = 0;

function mapConversationStatus(s: ConversationStatus): PetStatus {
  switch (s) {
    case 'running':
      return 'running';
    case 'completed':
      return 'done';
    case 'error':
      return 'error';
    case 'idle':
    default:
      return 'idle';
  }
}

function aggregate(statuses: ConversationStatus[]): PetStatus {
  if (statuses.length === 0) return 'idle';
  let best: PetStatus = 'idle';
  let bestPri = PRIORITY.idle;
  for (const s of statuses) {
    const mapped = mapConversationStatus(s);
    const pri = PRIORITY[mapped];
    if (pri > bestPri) {
      best = mapped;
      bestPri = pri;
    }
  }
  return best;
}

function emitNow(status: PetStatus): void {
  emitTo(PET_WINDOW_LABEL, EVENT_NAME, { status }).catch(() => {
    // Pet window not open — silently drop, we'll resync on next store change.
  });
  lastEmittedStatus = status;
  lastEmittedAt = Date.now();
}

function scheduleEmit(status: PetStatus): void {
  if (status === lastEmittedStatus) return;

  const now = Date.now();
  const elapsed = now - lastEmittedAt;

  if (elapsed >= MIN_INTERVAL_MS) {
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    emitNow(status);
    return;
  }

  // Coalesce rapid transitions — last value wins.
  const wait = MIN_INTERVAL_MS - elapsed;
  if (pendingTimer !== null) clearTimeout(pendingTimer);
  pendingTimer = window.setTimeout(() => {
    pendingTimer = null;
    // Re-read aggregated status at emit time (not capture time) so
    // brief intermediate states don't get frozen in.
    const latest = aggregateFromStore();
    emitNow(latest);
  }, wait);
}

function aggregateFromStore(): PetStatus {
  const convs = useChatStore.getState().conversations;
  const statuses = Object.values(convs).map((c) => c.status);
  const base = aggregate(statuses);
  // Notice bus pet_bubble events drive the 'waiting' state (Phase D)
  if (unresolvedBubbleCount > 0 && PRIORITY.waiting > PRIORITY[base]) {
    return 'waiting';
  }
  return base;
}

/**
 * Start subscribing to chatStore changes and emitting pet-status-update.
 * Idempotent — safe to call multiple times. Emits the current status
 * once immediately so a freshly-opened pet window can sync.
 */
export function startPetStatusBridge(): void {
  if (started) return;
  started = true;

  // Initial emit (after pet window may or may not exist — best effort).
  emitNow(aggregateFromStore());

  storeUnsub = useChatStore.subscribe(() => {
    const status = aggregateFromStore();
    scheduleEmit(status);
  });

  petBubbleUnsub = subscribe('pet_bubble', (notice: Notice) => {
    // Only notices requiring user attention drive the waiting state.
    // Bus currently does blanket fan-out; filter by type until Router lands.
    if (notice.type !== 'permission_request' && notice.type !== 'user_input_needed') return;
    unresolvedBubbleCount++;
    scheduleEmit(aggregateFromStore());
    // Auto-resolve after TTL so waiting state clears even if no explicit dismiss
    const ttlMs = typeof notice.ttl === 'number' ? notice.ttl : 30_000;
    window.setTimeout(() => {
      unresolvedBubbleCount = Math.max(0, unresolvedBubbleCount - 1);
      scheduleEmit(aggregateFromStore());
    }, ttlMs);
  });
}

export function stopPetStatusBridge(): void {
  if (!started) return;
  started = false;
  storeUnsub?.();
  storeUnsub = null;
  petBubbleUnsub?.();
  petBubbleUnsub = null;
  unresolvedBubbleCount = 0;
  if (pendingTimer !== null) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
}

/**
 * Force-emit the current status, bypassing debounce. Used by the pet
 * window after mount so it gets the latest state without waiting for a
 * store change.
 */
export function resyncPetStatus(): void {
  if (!started) return;
  emitNow(aggregateFromStore());
}
