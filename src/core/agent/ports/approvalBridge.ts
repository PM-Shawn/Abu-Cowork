/**
 * Human approval requests remain pending until answered or cancelled.
 * Each conversation displays its earliest request of each dialog kind.
 * Every request has a host identity independent of provider tool-call IDs.
 */
import type { ConfirmationInfo } from '../../tools/registry';
import type { UserQuestionPayload, UserQuestionResult } from '@/types';

export type ApprovalKind = 'command' | 'file-permission' | 'workspace' | 'user-question';

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

export type SingleActiveKind = 'command' | 'file-permission' | 'workspace';

export type ApprovalPending<K extends ApprovalKind> = {
  id: string;
  requestId: string;
  conversationId: string;
} & ApprovalPayloadMap[K];

export interface ApprovalRequestInput<K extends ApprovalKind> {
  id?: string;
  loopId?: string;
  signal?: AbortSignal;
  conversationId: string;
  payload: ApprovalPayloadMap[K];
}

interface InternalEntry {
  id: string;
  requestId: string;
  conversationId: string;
  loopId?: string;
  payload: unknown;
  resolveFn: (result: unknown) => void;
  publicSnapshot: Record<string, unknown>;
}

interface KindState {
  entries: InternalEntry[];
  publicList: Record<string, unknown>[];
  listeners: Set<() => void>;
}

function createKindState(): KindState {
  return { entries: [], publicList: [], listeners: new Set() };
}

const kindStates: Record<ApprovalKind, KindState> = {
  command: createKindState(),
  'file-permission': createKindState(),
  workspace: createKindState(),
  'user-question': createKindState(),
};

const cancelledResults: Record<ApprovalKind, unknown> = {
  command: false,
  'file-permission': false,
  workspace: null,
  'user-question': null,
};

const dequeueHooks: Partial<Record<ApprovalKind, (payload: unknown) => unknown>> = {};

function isQueuedKind(kind: ApprovalKind): boolean {
  return kind === 'command' || kind === 'file-permission';
}

export function setDequeueShortCircuit<K extends ApprovalKind>(
  kind: K,
  fn: (payload: ApprovalPayloadMap[K]) => ApprovalResultMap[K] | undefined,
): void {
  dequeueHooks[kind] = fn as (payload: unknown) => unknown;
}

let idCounter = 0;

function notify(kind: ApprovalKind): void {
  kindStates[kind].listeners.forEach((listener) => listener());
}

function replaceEntries(kind: ApprovalKind, entries: InternalEntry[]): void {
  const state = kindStates[kind];
  state.entries = entries;
  state.publicList = entries.map((entry) => entry.publicSnapshot);
}

export function request<K extends ApprovalKind>(
  kind: K,
  input: ApprovalRequestInput<K>,
): Promise<ApprovalResultMap[K]> {
  if (input.signal?.aborted) return Promise.resolve(cancelledResults[kind] as ApprovalResultMap[K]);
  const requestId = `approval-${++idCounter}`;
  const id = input.id ?? requestId;
  const state = kindStates[kind];
  return new Promise<ApprovalResultMap[K]>((resolvePromise) => {
    const abort = () => settle(kind, requestId, cancelledResults[kind], true);
    const entry: InternalEntry = {
      id,
      requestId,
      conversationId: input.conversationId,
      loopId: input.loopId,
      payload: input.payload,
      resolveFn: (result) => {
        input.signal?.removeEventListener('abort', abort);
        resolvePromise(result as ApprovalResultMap[K]);
      },
      publicSnapshot: { id, requestId, conversationId: input.conversationId, ...(input.payload as object) },
    };
    const wasEmpty = !state.entries.some((candidate) => candidate.conversationId === input.conversationId);
    replaceEntries(kind, [...state.entries, entry]);
    input.signal?.addEventListener('abort', abort, { once: true });
    if (!isQueuedKind(kind) || wasEmpty) notify(kind);
  });
}

function promoteNext(kind: ApprovalKind): void {
  const state = kindStates[kind];
  for (const conversationId of new Set(state.entries.map((entry) => entry.conversationId))) {
    let candidate = state.entries.find((entry) => entry.conversationId === conversationId);
    while (candidate) {
      const result = dequeueHooks[kind]?.(candidate.payload);
      if (result === undefined) break;
      replaceEntries(kind, state.entries.filter((entry) => entry !== candidate));
      candidate.resolveFn(result);
      candidate = state.entries.find((entry) => entry.conversationId === conversationId);
    }
  }
}

function settle(kind: ApprovalKind, id: string, result: unknown, cancel = false): void {
  const state = kindStates[kind];
  const owned = state.entries.find((entry) => entry.requestId === id);
  const matches = owned ? [owned] : state.entries.filter((entry) => entry.id === id);
  if (matches.length !== 1) return;
  const entry = matches[0];
  const index = state.entries.indexOf(entry);
  const isActive = !state.entries.slice(0, index).some((candidate) => candidate.conversationId === entry.conversationId);
  if (isQueuedKind(kind) && !isActive && !cancel) return;
  replaceEntries(kind, state.entries.filter((_, candidate) => candidate !== index));
  entry.resolveFn(result);
  if (isQueuedKind(kind)) {
    if (!isActive) return;
    promoteNext(kind);
  }
  notify(kind);
}

export function resolveActive<K extends SingleActiveKind>(kind: K, result: ApprovalResultMap[K]): void {
  const entry = kindStates[kind].entries[0];
  if (entry) settle(kind, entry.requestId, result);
}

export function resolve<K extends ApprovalKind>(kind: K, id: string, result: ApprovalResultMap[K]): void {
  settle(kind, id, result);
}

function drainMatching(kind: ApprovalKind, matches: (entry: InternalEntry) => boolean): void {
  const state = kindStates[kind];
  const removed = state.entries.filter(matches);
  if (removed.length === 0) return;
  const activeRemoved = removed.some((entry) => state.entries.find((candidate) => candidate.conversationId === entry.conversationId) === entry);
  replaceEntries(kind, state.entries.filter((entry) => !matches(entry)));
  for (const entry of removed) entry.resolveFn(cancelledResults[kind]);
  if (isQueuedKind(kind)) {
    if (!activeRemoved) return;
    promoteNext(kind);
  }
  notify(kind);
}

export function drainAll(kind: ApprovalKind): void {
  drainMatching(kind, () => true);
}

export function drainByConversationId(kind: ApprovalKind, conversationId: string): void {
  drainMatching(kind, (entry) => entry.conversationId === conversationId);
}

export function drainByLoopId(kind: ApprovalKind, loopId: string): void {
  drainMatching(kind, (entry) => entry.loopId === loopId);
}

export function cancelById(kind: ApprovalKind, id: string): void {
  settle(kind, id, cancelledResults[kind], true);
}

export function subscribe(kind: ApprovalKind, listener: () => void): () => void {
  kindStates[kind].listeners.add(listener);
  return () => { kindStates[kind].listeners.delete(listener); };
}

export function getSnapshot(kind: 'command', conversationId?: string): ApprovalPending<'command'> | null;
export function getSnapshot(kind: 'file-permission', conversationId?: string): ApprovalPending<'file-permission'> | null;
export function getSnapshot(kind: 'workspace', conversationId?: string): ApprovalPending<'workspace'> | null;
export function getSnapshot(kind: 'user-question'): ApprovalPending<'user-question'>[];
export function getSnapshot(kind: ApprovalKind, conversationId?: string): unknown {
  const state = kindStates[kind];
  if (kind === 'user-question') return state.publicList;
  const entry = conversationId === undefined
    ? state.entries[0]
    : state.entries.find((candidate) => candidate.conversationId === conversationId);
  return entry?.publicSnapshot ?? null;
}
