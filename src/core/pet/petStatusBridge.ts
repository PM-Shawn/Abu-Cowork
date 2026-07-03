/**
 * Pet status bridge — main-window side (Phase B/C).
 *
 * Aggregates agent status across all conversations and emits
 * 'pet-status-update' events to the pet window. The pet window lives in
 * a separate WebView, so direct store access isn't available; Tauri
 * events are the bridge.
 *
 * Priority rule (PRD-02): waiting > error > running > done > idle.
 * Waiting is sourced from Notice System events (permission_request /
 * user_input_needed).
 *
 * Phase C (Activity Notification Tray): besides the bare status, the
 * payload now carries the *featured conversation* driving that status —
 * its id, title, and a short summary of its latest assistant message —
 * so the pet can render a real notification bubble instead of a bare
 * colored ring.
 *
 * Debounce: 3 seconds minimum between emits to prevent flicker when
 * multiple conversations transition together, or when a streaming reply
 * updates the summary token-by-token.
 */

import { emitTo } from '@tauri-apps/api/event';
import { useChatStore } from '@/stores/chatStore';
import { subscribe } from '@/core/notice/bus';
import {
  subscribeToFilePermission, getPendingFilePermission,
  subscribeToCommandConfirmation, getPendingCommandConfirmation,
  subscribeToWorkspaceRequest, getPendingWorkspaceRequest,
  subscribeUserQuestion, getPendingUserQuestions,
} from '@/core/agent/permissionBridge';
import type { ConversationStatus, Conversation, Message, MessageContent } from '@/types';
import type { Notice } from '@/core/notice/types';

export type PetStatus = 'idle' | 'running' | 'waiting' | 'error' | 'done';

/**
 * Sub-kind of the `waiting` status:
 *  - 'approval': a blocking allow/deny dialog is open in the main window (file
 *    permission, command confirm, workspace pick, ask_user_question). The pet
 *    signals this and routes the user to the main window — it does NOT show a
 *    text reply (typing can't grant a permission).
 *  - 'input': a notice-bus user_input_needed ping → inline text reply is apt.
 */
export type WaitingKind = 'approval' | 'input';

/** Wire format sent to the pet window. */
export interface PetStatusPayload {
  status: PetStatus;
  /** Conversation driving the current status, or null when idle. */
  conversationId: string | null;
  /** Featured conversation title, or null when idle. */
  title: string | null;
  /** Short summary of the latest assistant message, or null. */
  summary: string | null;
  /** Only meaningful when status === 'waiting'; null otherwise. */
  waitingKind: WaitingKind | null;
}

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
// Collapsed the bubble shows one truncated line; expanded it wraps the
// full text. Cap generously so "expand" reveals something, while keeping
// the per-update payload tiny.
const SUMMARY_MAX_LEN = 120;

let lastEmittedSig: string | null = null;
let lastEmittedAt = 0;
let pendingTimer: number | null = null;
let started = false;
let storeUnsub: (() => void) | null = null;
let petBubbleUnsub: (() => void) | null = null;
let permissionUnsubs: (() => void)[] = [];
/**
 * Currently-unresolved waiting notices, oldest→newest. Each entry is removed
 * by its own TTL timer (identity match), so an earlier notice with a longer
 * TTL keeps driving the waiting state after a later, shorter-TTL notice
 * expires — and the featured conversation always tracks a *still-active*
 * notice, never a stale pointer.
 */
let activeWaiting: { convId: string | null }[] = [];

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

/**
 * Pick the highest-priority conversation and return its mapped status
 * plus id. Ties resolve to the first encountered (stable iteration order).
 */
function aggregateFeatured(
  convs: Record<string, Conversation>,
): { status: PetStatus; conversationId: string | null } {
  let best: PetStatus = 'idle';
  let bestPri = PRIORITY.idle;
  let bestId: string | null = null;
  for (const conv of Object.values(convs)) {
    const mapped = mapConversationStatus(conv.status);
    const pri = PRIORITY[mapped];
    if (pri > bestPri) {
      best = mapped;
      bestPri = pri;
      bestId = conv.id;
    }
  }
  return { status: best, conversationId: bestId };
}

function extractText(content: string | MessageContent[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((c): c is Extract<MessageContent, { type: 'text' }> => c.type === 'text')
    .map((c) => c.text)
    .join(' ');
}

/** Latest assistant message text, trimmed to a short preview, or null. */
function summarizeLatestAssistant(messages: Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    const text = extractText(m.content).trim().replace(/\s+/g, ' ');
    if (!text) continue;
    return text.length > SUMMARY_MAX_LEN ? text.slice(0, SUMMARY_MAX_LEN) + '…' : text;
  }
  return null;
}

/**
 * Build the full payload from current store state, factoring in the
 * notice-driven waiting override. Waiting features the conversation the
 * notice pointed at (if any), else the aggregate winner.
 */
/** Most recent still-active waiting notice that points at a live conversation. */
function currentWaitingConvId(convs: Record<string, Conversation>): string | null {
  for (let i = activeWaiting.length - 1; i >= 0; i--) {
    const id = activeWaiting[i].convId;
    if (id && convs[id]) return id;
  }
  return null;
}

/**
 * Any in-app blocking approval currently awaiting the user — file/dir read
 * permission, command confirmation, workspace pick, or an ask_user_question.
 * These live in permissionBridge (NOT the notice bus), so the pet reads them
 * directly; otherwise the "文件读取权限" dialog can sit open in the main
 * window while the pet still shows a blue "running" bubble and the user never
 * notices. Returns the conversation the dialog belongs to, or null if none.
 */
function pendingApprovalConvId(): string | null | undefined {
  const file = getPendingFilePermission();
  if (file) return file.conversationId;
  const cmd = getPendingCommandConfirmation();
  if (cmd) return cmd.conversationId;
  const ws = getPendingWorkspaceRequest();
  if (ws) return ws.conversationId;
  const questions = getPendingUserQuestions();
  if (questions.length > 0) return questions[0].conversationId;
  return undefined; // no pending approval
}

function buildPayload(): PetStatusPayload {
  const convs = useChatStore.getState().conversations;
  let { status, conversationId } = aggregateFeatured(convs);
  let waitingKind: WaitingKind | null = null;

  // A live blocking approval dialog takes precedence — it's the strongest
  // "needs you right now" signal and is what the user physically can't miss.
  const approvalConvId = pendingApprovalConvId();
  if (approvalConvId !== undefined && PRIORITY.waiting > PRIORITY[status]) {
    status = 'waiting';
    waitingKind = 'approval';
    if (approvalConvId && convs[approvalConvId]) conversationId = approvalConvId;
  } else if (activeWaiting.length > 0 && PRIORITY.waiting > PRIORITY[status]) {
    status = 'waiting';
    waitingKind = 'input';
    // Prefer a still-active notice's conversation; fall back to the aggregate winner.
    const waitingId = currentWaitingConvId(convs);
    if (waitingId) conversationId = waitingId;
  }

  if (status === 'idle') {
    return { status, conversationId: null, title: null, summary: null, waitingKind: null };
  }

  const conv = conversationId ? convs[conversationId] : null;
  return {
    status,
    conversationId,
    title: conv?.title ?? null,
    summary: conv ? summarizeLatestAssistant(conv.messages) : null,
    waitingKind,
  };
}

function signature(p: PetStatusPayload): string {
  return `${p.status}|${p.waitingKind ?? ''}|${p.conversationId ?? ''}|${p.title ?? ''}|${p.summary ?? ''}`;
}

function emitNow(payload: PetStatusPayload): void {
  emitTo(PET_WINDOW_LABEL, EVENT_NAME, payload).catch(() => {
    // Pet window not open — silently drop, we'll resync on next store change.
  });
  lastEmittedSig = signature(payload);
  lastEmittedAt = Date.now();
}

function scheduleEmit(): void {
  const payload = buildPayload();
  if (signature(payload) === lastEmittedSig) return;

  const now = Date.now();
  const elapsed = now - lastEmittedAt;

  if (elapsed >= MIN_INTERVAL_MS) {
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    emitNow(payload);
    return;
  }

  // Coalesce rapid transitions — last value wins.
  const wait = MIN_INTERVAL_MS - elapsed;
  if (pendingTimer !== null) clearTimeout(pendingTimer);
  pendingTimer = window.setTimeout(() => {
    pendingTimer = null;
    // Re-read at emit time (not capture time) so brief intermediate
    // states / stale summaries don't get frozen in. Re-check the signature:
    // if the state reverted to what we last emitted while the timer was
    // pending, skip the redundant IPC.
    const p = buildPayload();
    if (signature(p) !== lastEmittedSig) emitNow(p);
  }, wait);
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
  emitNow(buildPayload());

  storeUnsub = useChatStore.subscribe(() => {
    scheduleEmit();
  });

  // Blocking approval dialogs (file permission / command confirm / workspace /
  // ask_user_question) live in permissionBridge, not the notice bus. Subscribe
  // directly so the pet flips to `waiting` the moment one opens and clears the
  // moment the user resolves it — no TTL guessing (the dialog can stay open
  // arbitrarily long, so a fixed notice TTL would be wrong in both directions).
  permissionUnsubs = [
    subscribeToFilePermission(scheduleEmit),
    subscribeToCommandConfirmation(scheduleEmit),
    subscribeToWorkspaceRequest(scheduleEmit),
    subscribeUserQuestion(scheduleEmit),
  ];

  petBubbleUnsub = subscribe('pet_bubble', (notice: Notice) => {
    // Only notices requiring user attention drive the waiting state.
    // Bus currently does blanket fan-out; filter by type until Router lands.
    if (notice.type !== 'permission_request' && notice.type !== 'user_input_needed') return;
    const convId = notice.payload?.conversationId;
    const entry = { convId: typeof convId === 'string' ? convId : null };
    activeWaiting.push(entry);
    scheduleEmit();
    // Auto-resolve after TTL so the waiting state clears even without an
    // explicit dismiss. Remove *this* entry by identity so an earlier,
    // longer-lived notice keeps the waiting state (and its conversation).
    const ttlMs = typeof notice.ttl === 'number' ? notice.ttl : 30_000;
    window.setTimeout(() => {
      activeWaiting = activeWaiting.filter((n) => n !== entry);
      scheduleEmit();
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
  permissionUnsubs.forEach((u) => u());
  permissionUnsubs = [];
  activeWaiting = [];
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
  emitNow(buildPayload());
}
