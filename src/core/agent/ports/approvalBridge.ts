/**
 * Approval Bridge — unified core for the four HITL (human-in-the-loop)
 * approval queues that used to be four near-identical module-level
 * singletons in `permissionBridge.ts` (command confirmation / file
 * permission / workspace request / ask_user_question + plan approval).
 *
 * See `docs/2026-07-18-phase0-runtime-interfaces-spec.md` §3 — this is the
 * "approval-bridge" leg of the three planned runtime-boundary interfaces
 * (state-port / delta-channel / approval-bridge) that a future headless
 * Node runtime would need. §3.3 sketches the target shape:
 *
 *   type ApprovalKind = 'command' | 'file-permission' | 'workspace' | 'user-question';
 *   interface ApprovalRequest<K> { id; kind: K; loopId; conversationId; payload; timeoutMs?; }
 *   interface ApprovalBridge {
 *     request<K>(req): Promise<Result | null>;   // Node-side suspend
 *     drainByLoopId(loopId): void;                 // abort → reject that loop's pending
 *     resolve(id, result): void;                   // shell → Node IPC handler calls this
 *   }
 *
 * `permissionBridge.ts` keeps every one of its existing exported function
 * names/signatures unchanged (`requestCommandConfirmation`,
 * `resolveFilePermission`, `subscribeToWorkspaceRequest`, ...); they become
 * thin wrappers over this core. Every external caller (registry.ts,
 * toolExecutor.ts, agentTools.ts, ChatView.tsx, UserQuestionDock.tsx,
 * petStatusBridge.ts, ...) is untouched.
 *
 * ── Queueing policy is genuinely different per kind — preserved exactly ──
 * (see E-REPORT.md for the full before/after behavior checklist)
 *   - command:         single active + FIFO queue, no timeout.
 *   - file-permission:  single active + FIFO queue, no timeout, PLUS a
 *                        dequeue-time re-check (another tool call may have
 *                        already been granted the same permission while this
 *                        one sat in the queue) that short-circuits activation.
 *   - workspace:        single active, NO queue — a second concurrent
 *                        request silently OVERWRITES the first. The first
 *                        request's promise is then abandoned (never resolved
 *                        by user action; only its own 60s timeout can settle
 *                        it, and even that no-ops once overwritten — see
 *                        `settle()`). This is a pre-existing quirk of the
 *                        original singleton, not something this refactor
 *                        fixes; it is reproduced verbatim.
 *   - user-question:    many concurrently active (across conversations, and
 *                        in principle within one — callers serialize that),
 *                        addressed by id (= toolCallId), 10-minute timeout
 *                        per entry.
 *
 * ── useSyncExternalStore discipline ──
 * `getSnapshot()` must return a referentially STABLE value until the kind's
 * state actually changes, or React re-renders forever. Single-active kinds
 * return the same cached `publicSnapshot` object for as long as that entry
 * stays active; the multi kind (user-question) returns the same cached
 * array reference until an entry is added/removed/drained (mirrors the
 * pre-unification `userQuestionQueue = [...]` / `.filter(...)` discipline).
 */

export type ApprovalKind = 'command' | 'file-permission' | 'workspace' | 'user-question';

// ---------------------------------------------------------------------------
// Per-kind payload / result shapes — extracted verbatim from the four
// pre-existing singletons' request/pending object fields.
// ---------------------------------------------------------------------------

import type { ConfirmationInfo } from '../../tools/registry';
import type { UserQuestionPayload, UserQuestionResult } from '@/types';

export interface CommandApprovalPayload {
  info: ConfirmationInfo;
  agentName?: string;
}

export interface FilePermissionApprovalPayload {
  path: string;
  capability: 'read' | 'write';
  toolName: string;
  agentName?: string;
}

export interface WorkspaceApprovalPayload {
  reason: string;
  suggestedPath?: string;
}

export interface UserQuestionApprovalPayload {
  payload: UserQuestionPayload;
}

export interface ApprovalPayloadMap {
  command: CommandApprovalPayload;
  'file-permission': FilePermissionApprovalPayload;
  workspace: WorkspaceApprovalPayload;
  'user-question': UserQuestionApprovalPayload;
}

export interface ApprovalResultMap {
  command: boolean;
  'file-permission': boolean;
  workspace: string | null;
  'user-question': UserQuestionResult | null;
}

/** Kinds with a single active slot (queue or overwrite policy) — the ones
 *  `resolveActive()` applies to. 'user-question' is deliberately excluded:
 *  it has no single "the" active entry, only addressable-by-id ones. */
export type SingleActiveKind = 'command' | 'file-permission' | 'workspace';

/**
 * Public pending-request shape handed to `useSyncExternalStore` consumers —
 * `id` + `conversationId` + the kind's payload fields flattened in,
 * mirroring the pre-unification per-kind interfaces (`FilePermissionRequest`,
 * `WorkspaceRequest`, `PendingUserQuestion`) field-for-field. No `resolve`
 * function is exposed on it (verified: no external caller read `.resolve`
 * off the old singletons' pending objects — only the exported
 * `resolve*`/`drain*` wrapper functions were ever used).
 */
export type ApprovalPending<K extends ApprovalKind> = {
  id: string;
  conversationId: string;
} & ApprovalPayloadMap[K];

export interface ApprovalRequestInput<K extends ApprovalKind> {
  /** Falls back to an internally-generated id for single-active kinds
   *  (command/file-permission/workspace — their public API never surfaces
   *  an id). REQUIRED in practice for 'user-question': callers pass the
   *  toolCallId so resolve-by-id and `findQuestionOwningMessage` line up. */
  id?: string;
  loopId?: string;
  conversationId: string;
  payload: ApprovalPayloadMap[K];
}

// ---------------------------------------------------------------------------
// Internal state — deliberately NOT generic (see module doc: the public
// functions below are the typed boundary; internal storage is type-erased
// to keep the per-kind dispatch logic simple instead of fighting mapped
// generic types across a runtime kind union).
// ---------------------------------------------------------------------------

interface InternalEntry {
  id: string;
  kind: ApprovalKind;
  conversationId: string;
  loopId?: string;
  payload: unknown;
  resolveFn: (result: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
  publicSnapshot: Record<string, unknown>;
}

interface KindState {
  /** Used by 'queue' and 'overwrite' modes — the single currently-active entry. */
  active: InternalEntry | null;
  /** Used by 'queue' mode only — FIFO of entries waiting for `active` to free up. */
  queue: InternalEntry[];
  /** Used by 'multi' mode only — all currently-active entries. */
  activeMulti: InternalEntry[];
  /** Cached `activeMulti.map(e => e.publicSnapshot)`, rebuilt only when
   *  `activeMulti` itself is reassigned — this is what `getSnapshot()`
   *  returns, so the reference stays stable across no-op re-renders. */
  publicList: Record<string, unknown>[];
  listeners: Set<() => void>;
}

function createKindState(): KindState {
  return { active: null, queue: [], activeMulti: [], publicList: [], listeners: new Set() };
}

const kindStates: Record<ApprovalKind, KindState> = {
  command: createKindState(),
  'file-permission': createKindState(),
  workspace: createKindState(),
  'user-question': createKindState(),
};

type ConcurrencyMode = 'queue' | 'overwrite' | 'multi';

interface KindConfig {
  mode: ConcurrencyMode;
  timeoutMs?: number;
  /** Value entries auto-resolve to on timeout or drain. */
  cancelledResult: unknown;
  /** 'queue' mode only. Called for each candidate about to be promoted off
   *  the queue; a non-undefined return short-circuits activation and
   *  resolves the candidate immediately without ever surfacing a dialog
   *  (file-permission's "granted by another tool call while queued"
   *  re-check). Injected by permissionBridge.ts via
   *  `setDequeueShortCircuit` so this core stays store-agnostic. */
  dequeueShortCircuit?: (payload: unknown) => unknown;
  /** Called synchronously right before an entry auto-resolves on timeout —
   *  mirrors each original singleton's own `console.warn(...)` call
   *  (kept as a side-effecting hook, not a formatted string, so the
   *  original multi-arg `console.warn(msg, id)` call shape is preserved
   *  verbatim for workspace vs. user-question). */
  onTimeout?: (id: string) => void;
}

const KIND_CONFIGS: Record<ApprovalKind, KindConfig> = {
  command: {
    mode: 'queue',
    cancelledResult: false,
  },
  'file-permission': {
    mode: 'queue',
    cancelledResult: false,
    // dequeueShortCircuit is set by permissionBridge.ts at module load via
    // setDequeueShortCircuit('file-permission', ...).
  },
  workspace: {
    mode: 'overwrite',
    timeoutMs: 60_000, // WORKSPACE_REQUEST_TIMEOUT_MS in the original singleton
    cancelledResult: null,
    onTimeout: () => console.warn('[AgentLoop] Workspace request timed out, auto-cancelling'),
  },
  'user-question': {
    mode: 'multi',
    timeoutMs: 10 * 60 * 1000, // USER_QUESTION_TIMEOUT_MS in the original singleton
    cancelledResult: null,
    onTimeout: (id) => console.warn('[permissionBridge] UserQuestion timed out, auto-cancelling', id),
  },
};

/**
 * Registers the dequeue-time short-circuit hook for a 'queue'-mode kind.
 * Currently only used by permissionBridge.ts for 'file-permission' (checks
 * `usePermissionStore` — kept out of this module so the core has zero
 * dependency on application stores). Idempotent; last call wins.
 */
export function setDequeueShortCircuit<K extends ApprovalKind>(
  kind: K,
  fn: (payload: ApprovalPayloadMap[K]) => ApprovalResultMap[K] | undefined,
): void {
  KIND_CONFIGS[kind].dequeueShortCircuit = fn as (payload: unknown) => unknown;
}

let idCounter = 0;
/** Internal bookkeeping id for single-active kinds, whose public API never
 *  surfaces or accepts an id. Never exposed for cross-entry matching. */
function nextId(kind: ApprovalKind): string {
  idCounter += 1;
  return `${kind}-${idCounter}`;
}

function notify(kind: ApprovalKind): void {
  kindStates[kind].listeners.forEach((l) => l());
}

/** Replaces `activeMulti` AND its cached `publicList` together, so the two
 *  never drift and `getSnapshot()` never has to recompute on read. */
function setMultiEntries(state: KindState, entries: InternalEntry[]): void {
  state.activeMulti = entries;
  state.publicList = entries.map((e) => e.publicSnapshot);
}

// ---------------------------------------------------------------------------
// request()
// ---------------------------------------------------------------------------

export function request<K extends ApprovalKind>(
  kind: K,
  input: ApprovalRequestInput<K>,
): Promise<ApprovalResultMap[K]> {
  const config = KIND_CONFIGS[kind];
  const state = kindStates[kind];
  const id = input.id ?? nextId(kind);

  return new Promise<ApprovalResultMap[K]>((resolvePromise) => {
    const entry: InternalEntry = {
      id,
      kind,
      conversationId: input.conversationId,
      loopId: input.loopId,
      payload: input.payload,
      resolveFn: resolvePromise as (result: unknown) => void,
      publicSnapshot: { id, conversationId: input.conversationId, ...(input.payload as object) },
    };

    const timeoutMs = config.timeoutMs;
    if (timeoutMs !== undefined) {
      entry.timer = setTimeout(() => {
        if (!isLive(kind, id)) return; // already resolved, or (workspace) overwritten — no-op, replicating the original's identity-check no-op
        config.onTimeout?.(id);
        settle(kind, id, config.cancelledResult);
      }, timeoutMs);
    }

    if (config.mode === 'multi') {
      setMultiEntries(state, [...state.activeMulti, entry]);
      notify(kind);
      return;
    }

    if (config.mode === 'overwrite') {
      // No busy check at all — a second concurrent request always replaces
      // the first. The first's promise is simply abandoned (see module doc).
      state.active = entry;
      notify(kind);
      return;
    }

    // 'queue' mode
    if (state.active === null) {
      state.active = entry;
      notify(kind);
    } else {
      state.queue.push(entry); // silent — matches original (queueing never notifies)
    }
  });
}

function isLive(kind: ApprovalKind, id: string): boolean {
  const state = kindStates[kind];
  if (KIND_CONFIGS[kind].mode === 'multi') {
    return state.activeMulti.some((e) => e.id === id);
  }
  return state.active?.id === id;
}

// ---------------------------------------------------------------------------
// resolve() / resolveActive()
// ---------------------------------------------------------------------------

function settle(kind: ApprovalKind, id: string, result: unknown): void {
  const config = KIND_CONFIGS[kind];
  const state = kindStates[kind];

  if (config.mode === 'multi') {
    const idx = state.activeMulti.findIndex((e) => e.id === id);
    if (idx === -1) return; // unknown/already-resolved id — no-op (matches original)
    const entry = state.activeMulti[idx];
    setMultiEntries(state, state.activeMulti.filter((_, i) => i !== idx));
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolveFn(result);
    notify(kind);
    return;
  }

  // single-active modes ('queue' | 'overwrite')
  if (state.active?.id !== id) return; // not the active one: queued items aren't independently resolvable; an overwritten workspace entry is abandoned — both intentional, see module doc
  const entry = state.active;
  state.active = null;
  if (entry.timer) clearTimeout(entry.timer);
  entry.resolveFn(result);

  if (config.mode === 'overwrite') {
    notify(kind);
    return;
  }

  // 'queue' mode — promoteNext() below owns the notify for this settle()
  // call, whether it ends up promoting a candidate or draining the queue
  // empty (see its trailing comment for why this is unconditional now).
  promoteNext(kind);
}

function promoteNext(kind: ApprovalKind): void {
  const config = KIND_CONFIGS[kind];
  const state = kindStates[kind];
  while (state.queue.length > 0) {
    const candidate = state.queue.shift()!;
    const shortCircuit = config.dequeueShortCircuit?.(candidate.payload);
    if (shortCircuit !== undefined) {
      if (candidate.timer) clearTimeout(candidate.timer);
      candidate.resolveFn(shortCircuit);
      continue; // no notify for a short-circuited dequeue — matches original
    }
    state.active = candidate;
    notify(kind);
    return;
  }
  // Queue drained without activating anything — exactly one notify per
  // settle() call either way (promoted above, or drained here). Previously
  // file-permission notified twice (once in settle() on clear, again here
  // on promotion) while command notified once; review confirmed that
  // difference is not observable to useSyncExternalStore subscribers — both
  // land on the same final publicSnapshot, and React dedupes re-renders
  // that don't change the snapshot reference — so the notifyOnClear knob was
  // removed and both kinds now share this single unconditional notify.
  notify(kind);
}

/** Resolves whichever request is currently active for a single-active kind.
 *  No-ops if none is active. This is what `resolveCommandConfirmation` /
 *  `resolveFilePermission` / `resolveWorkspaceRequest` call — none of their
 *  public signatures take an id, they always mean "the current one". */
export function resolveActive<K extends SingleActiveKind>(kind: K, result: ApprovalResultMap[K]): void {
  const active = kindStates[kind].active;
  if (!active) return;
  settle(kind, active.id, result);
}

/** Resolves a specific entry by id. Used by 'user-question' (id = toolCallId,
 *  supplied by the caller); also valid for the single-active kinds if a
 *  caller happens to know the id, though none of today's wrappers do.
 *
 *  `result`'s type is exactly `ApprovalResultMap[K]` — no blanket `| null`
 *  tacked on. 'user-question' and 'workspace' already fold `null` into their
 *  own result type (`UserQuestionResult | null` / `string | null`); adding
 *  it here too would let a caller pass `null` for the boolean kinds
 *  (command/file-permission), which isn't a value their real domain has. */
export function resolve<K extends ApprovalKind>(kind: K, id: string, result: ApprovalResultMap[K]): void {
  settle(kind, id, result);
}

// ---------------------------------------------------------------------------
// drain()
// ---------------------------------------------------------------------------

/** Drains every pending/active entry for a kind, resolving each to the
 *  kind's `cancelledResult`. Queue entries are drained silently (no notify
 *  per item — matches the original `while (queue.length) { ...resolve... }`
 *  loops); the active entry (if any) resolves with exactly one notify. A
 *  'multi' kind with nothing pending does NOT notify (matches
 *  `drainUserQuestions`'s early return — needed so an idle kind's cached
 *  `publicList` reference never churns). */
export function drainAll(kind: ApprovalKind): void {
  const config = KIND_CONFIGS[kind];
  const state = kindStates[kind];

  if (config.mode === 'multi') {
    if (state.activeMulti.length === 0) return;
    const drained = state.activeMulti;
    setMultiEntries(state, []);
    for (const entry of drained) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.resolveFn(config.cancelledResult);
    }
    notify(kind);
    return;
  }

  while (state.queue.length > 0) {
    const entry = state.queue.shift()!;
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolveFn(config.cancelledResult);
  }
  if (state.active) {
    const entry = state.active;
    state.active = null;
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolveFn(config.cancelledResult);
    notify(kind);
  }
}

/**
 * Drains only 'user-question' entries belonging to one conversation. Backs
 * `drainUserQuestionsForConversation` (conversation delete) — its only real
 * caller. A prior version implemented this symmetrically for the three
 * single-active kinds (command/file-permission/workspace) too, but nothing
 * ever called it for those, so that branch was cut in the F3 API sweep;
 * re-add if a future caller needs conversation-scoped draining for a
 * single-active kind.
 */
export function drainByConversationId(kind: 'user-question', conversationId: string): void {
  const config = KIND_CONFIGS[kind];
  const state = kindStates[kind];

  const keep: InternalEntry[] = [];
  const drain: InternalEntry[] = [];
  for (const e of state.activeMulti) (e.conversationId === conversationId ? drain : keep).push(e);
  if (drain.length === 0) return;
  setMultiEntries(state, keep);
  for (const entry of drain) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolveFn(config.cancelledResult);
  }
  notify(kind);
}

// `drainByLoopId` (drain every kind's entries for one loopId — the design
// doc's §3.3 sketch for a future out-of-process runtime's abort handling)
// was cut in the F3 API sweep: it had zero call sites across all four
// kinds. The current `drainConfirmationQueue()` / `drainFilePermissionQueue()`
// / `drainWorkspaceRequest()` / `drainUserQuestions()` wrappers all call
// `drainAll()` (global, no loop scoping) instead, matching every real call
// site (agentLoop.ts's abort handler calls them with zero arguments). Each
// `InternalEntry` still carries `loopId` (see `ApprovalRequestInput`), so
// this can be re-added cheaply once an out-of-process runtime phase
// actually needs per-loop-scoped draining — see E-REPORT.md.

// ---------------------------------------------------------------------------
// subscribe() / getSnapshot()
// ---------------------------------------------------------------------------

export function subscribe(kind: ApprovalKind, cb: () => void): () => void {
  kindStates[kind].listeners.add(cb);
  return () => {
    kindStates[kind].listeners.delete(cb);
  };
}

export function getSnapshot(kind: 'command'): ApprovalPending<'command'> | null;
export function getSnapshot(kind: 'file-permission'): ApprovalPending<'file-permission'> | null;
export function getSnapshot(kind: 'workspace'): ApprovalPending<'workspace'> | null;
export function getSnapshot(kind: 'user-question'): ApprovalPending<'user-question'>[];
export function getSnapshot(kind: ApprovalKind): unknown {
  const state = kindStates[kind];
  if (KIND_CONFIGS[kind].mode === 'multi') {
    return state.publicList;
  }
  return state.active?.publicSnapshot ?? null;
}
