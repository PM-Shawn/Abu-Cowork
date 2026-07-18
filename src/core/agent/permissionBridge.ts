/**
 * Permission Bridge — queue systems for command confirmation, file permission, and workspace requests.
 * Extracted from agentLoop.ts to reduce coupling.
 *
 * Loop context is stored per-loopId in a Map to support concurrent agents.
 *
 * The four approval queues below (command confirmation / file permission /
 * workspace request / user question) are thin wrappers over the unified
 * `ports/approvalBridge.ts` core — every exported function name and
 * signature here is unchanged from before that refactor; only the storage
 * moved. See `approvalBridge.ts`'s module doc for the queueing-policy
 * rationale and `E-REPORT.md` for the before/after behavior checklist.
 */
import type { ConfirmationInfo, FilePermissionCallback } from '../tools/registry';
import type { Message, UserQuestionPayload, UserQuestionResult } from '../../types';
import { TOOL_NAMES } from '../tools/toolNames';
import { usePermissionStore } from '../../stores/permissionStore';
import type { PermissionDuration } from '../../stores/permissionStore';
import { authorizeWorkspace } from '../tools/pathSafety';
import type { EventRouter } from './eventRouter';
import * as approvalBridge from './ports/approvalBridge';

// The file-permission queue's dequeue-time re-check ("another tool call may
// have already been granted this permission while this request sat in the
// queue") lives here, not in approvalBridge.ts, so the core stays free of
// any dependency on application stores. Registered once at module load.
approvalBridge.setDequeueShortCircuit('file-permission', (payload) => {
  const permStore = usePermissionStore.getState();
  return permStore.hasPermission(payload.path, payload.capability) ? true : undefined;
});

// ── Loop Context (per-loop Map) ──

export interface LoopContext {
  commandConfirmCallback: (info: ConfirmationInfo) => Promise<boolean>;
  filePermissionCallback: FilePermissionCallback;
  signal: AbortSignal;
  eventRouter: EventRouter;
  loopId: string;
  conversationId: string;
  toolCallToStepId: Map<string, string>;
  /** Agent name for UI display (e.g. permission dialog badge) */
  agentName?: string;
}

/** Per-loop context storage — supports concurrent agent loops */
const loopContexts = new Map<string, LoopContext>();

/**
 * Set context for a specific loop. Used by toolExecutor before executing tool batches.
 */
export function setLoopContext(loopId: string, ctx: LoopContext): void {
  loopContexts.set(loopId, ctx);
}

/**
 * Get context for a specific loop.
 */
export function getLoopContext(loopId: string): LoopContext | undefined {
  return loopContexts.get(loopId);
}

/**
 * Clear context for a specific loop. Called after tool batch execution or on abort.
 */
export function clearLoopContext(loopId: string): void {
  loopContexts.delete(loopId);
}

/**
 * Compat shim — returns the first active loop context.
 * Safe for single-agent use. For multi-agent, callers should use getLoopContext(loopId).
 */
export function getCurrentLoopContext(): LoopContext | null {
  if (loopContexts.size === 0) return null;
  return loopContexts.values().next().value ?? null;
}

/**
 * The live loop context owning a conversation, or null. Unlike
 * getCurrentLoopContext() (first map entry — wrong with concurrent
 * conversations), this resolves by conversationId and is safe for tagging
 * mid-task user input with the loop that will actually consume it.
 */
export function getLoopContextForConversation(conversationId: string): LoopContext | null {
  for (const ctx of loopContexts.values()) {
    if (ctx.conversationId === conversationId) return ctx;
  }
  return null;
}

/**
 * @deprecated Use setLoopContext(loopId, ctx) instead.
 * Kept for backward compatibility during transition.
 */
export function setCurrentLoopContext(ctx: LoopContext | null): void {
  if (ctx === null) {
    // Clear all — legacy behavior when called with null
    loopContexts.clear();
  } else {
    loopContexts.set(ctx.loopId, ctx);
  }
}

// ── Command Confirmation System ──

/**
 * Subscribe to command confirmation state changes
 * For use with useSyncExternalStore
 */
export function subscribeToCommandConfirmation(callback: () => void): () => void {
  return approvalBridge.subscribe('command', callback);
}

/**
 * Get the current pending command confirmation request
 */
export function getPendingCommandConfirmation() {
  return approvalBridge.getSnapshot('command');
}

/**
 * Resolve the pending command confirmation and process next in queue
 */
export function resolveCommandConfirmation(confirmed: boolean) {
  approvalBridge.resolveActive('command', confirmed);
}

/**
 * Drain the confirmation queue — reject all pending confirmations.
 * Called on abort to prevent stale confirmation dialogs.
 */
export function drainConfirmationQueue() {
  approvalBridge.drainAll('command');
}

/**
 * Request confirmation for a dangerous command.
 * Returns a promise that resolves when user confirms or cancels.
 * If another confirmation is already pending, this request is queued.
 *
 * @param loopId - Optional loopId to look up the correct context for multi-agent.
 *                 Falls back to getCurrentLoopContext() compat shim if omitted.
 */
export async function requestCommandConfirmation(info: ConfirmationInfo, loopId?: string): Promise<boolean> {
  const ctx = loopId ? getLoopContext(loopId) : getCurrentLoopContext();
  const convId = ctx?.conversationId ?? '';
  const agentName = ctx?.agentName;
  return approvalBridge.request('command', {
    loopId,
    conversationId: convId,
    payload: { info, agentName },
  });
}

// ── File Permission Request Infrastructure ──

export interface FilePermissionRequest {
  path: string;
  capability: 'read' | 'write';
  toolName: string;
  conversationId: string;
  agentName?: string;
}

/**
 * Subscribe to file permission state changes (for useSyncExternalStore)
 */
export function subscribeToFilePermission(callback: () => void): () => void {
  return approvalBridge.subscribe('file-permission', callback);
}

/**
 * Get the current pending file permission request
 */
export function getPendingFilePermission(): FilePermissionRequest | null {
  return approvalBridge.getSnapshot('file-permission');
}

/**
 * Resolve the pending file permission request
 */
export function resolveFilePermission(
  granted: boolean,
  path?: string,
  capabilities?: ('read' | 'write' | 'execute')[],
  duration?: PermissionDuration
) {
  if (granted && path && capabilities && duration) {
    // Grant permission via permissionStore (which syncs to pathSafety)
    usePermissionStore.getState().grantPermission(path, capabilities, duration);
  }
  approvalBridge.resolveActive('file-permission', granted);
}

/**
 * Drain the file permission queue — reject all pending requests.
 * Called on abort to prevent stale permission dialogs.
 */
export function drainFilePermissionQueue() {
  approvalBridge.drainAll('file-permission');
}

/**
 * Request file permission — checks permissionStore first, then queues for UI.
 *
 * @param loopId - Optional loopId for multi-agent context lookup.
 */
export async function requestFilePermission(request: {
  path: string;
  capability: 'read' | 'write';
  toolName: string;
}, loopId?: string): Promise<boolean> {
  const permStore = usePermissionStore.getState();

  // Already has permission → auto-allow
  if (permStore.hasPermission(request.path, request.capability)) {
    // Also sync to pathSafety in case it wasn't already
    authorizeWorkspace(request.path);
    return true;
  }

  const ctx = loopId ? getLoopContext(loopId) : getCurrentLoopContext();
  const convId = ctx?.conversationId ?? '';
  const agentName = ctx?.agentName;
  return approvalBridge.request('file-permission', {
    loopId,
    conversationId: convId,
    payload: { ...request, agentName },
  });
}

// ── Workspace Request Infrastructure ──

export interface WorkspaceRequest {
  reason: string;
  conversationId: string;
  suggestedPath?: string;
}

/**
 * Subscribe to workspace request state changes (for useSyncExternalStore)
 */
export function subscribeToWorkspaceRequest(callback: () => void): () => void {
  return approvalBridge.subscribe('workspace', callback);
}

/**
 * Get the current pending workspace request
 */
export function getPendingWorkspaceRequest(): WorkspaceRequest | null {
  return approvalBridge.getSnapshot('workspace');
}

/**
 * Resolve the pending workspace request (called from UI)
 */
export function resolveWorkspaceRequest(path: string | null): void {
  approvalBridge.resolveActive('workspace', path);
}

/**
 * Drain workspace request — reject pending request on abort
 */
export function drainWorkspaceRequest(): void {
  approvalBridge.drainAll('workspace');
}

/**
 * Request the user to select a workspace folder.
 * Called from the request_workspace tool.
 * Auto-resolves to null after timeout to prevent indefinite hangs.
 *
 * NOTE: a second concurrent call silently overwrites the first — the first
 * request's promise is then abandoned (see approvalBridge.ts's module doc,
 * 'overwrite' mode). This is a pre-existing quirk of the original singleton,
 * reproduced verbatim, not something this refactor fixes.
 */
export async function requestWorkspace(reason: string, conversationId?: string, suggestedPath?: string): Promise<string | null> {
  const convId = conversationId ?? getCurrentLoopContext()?.conversationId ?? '';
  return approvalBridge.request('workspace', {
    conversationId: convId,
    payload: { reason, suggestedPath },
  });
}

// ── User Question Infrastructure ──

export interface PendingUserQuestion {
  id: string;              // = toolCallId
  conversationId: string;
  payload: UserQuestionPayload;
}

/** Tools whose calls can own a pending user question: ask_user_question asks
 * directly; report_plan asks for plan approval via the same bridge. */
const QUESTION_OWNER_TOOL_NAMES: readonly string[] = [
  TOOL_NAMES.ASK_USER_QUESTION,
  TOOL_NAMES.REPORT_PLAN,
];

/**
 * Locate the message owning a pending user question (id = toolCallId).
 * Matching by id alone is not enough — tool call ids are provider-generated
 * and a stale queue entry must not attach to an unrelated tool call.
 */
export function findQuestionOwningMessage(
  messages: readonly Message[],
  pendingId: string,
): Message | undefined {
  return messages.find((m) =>
    m.toolCalls?.some((tc) => tc.id === pendingId && QUESTION_OWNER_TOOL_NAMES.includes(tc.name)),
  );
}

/**
 * Subscribe to user question state changes (for useSyncExternalStore)
 */
export function subscribeUserQuestion(callback: () => void): () => void {
  return approvalBridge.subscribe('user-question', callback);
}

/**
 * Get the current pending user questions snapshot (for useSyncExternalStore).
 * Returns a stable array reference until the queue mutates.
 */
export function getPendingUserQuestions(): PendingUserQuestion[] {
  return approvalBridge.getSnapshot('user-question');
}

/**
 * Resolve a specific user question (from UserQuestionCard on submit, or timeout).
 */
export function resolveUserQuestion(id: string, r: UserQuestionResult | null): void {
  approvalBridge.resolve('user-question', id, r);
}

/**
 * Drain all pending user questions — resolve(null) so blocked tools exit.
 */
export function drainUserQuestions(): void {
  approvalBridge.drainAll('user-question');
}

/**
 * Drain user questions for a specific conversation (on conversation delete).
 */
export function drainUserQuestionsForConversation(conversationId: string): void {
  approvalBridge.drainByConversationId('user-question', conversationId);
}

/**
 * Request the user to answer a structured question set. Suspends until the
 * user submits or it times out (10 min). Resolves to result, or null.
 */
export function requestUserQuestion(
  id: string,
  conversationId: string,
  payload: UserQuestionPayload,
): Promise<UserQuestionResult | null> {
  return approvalBridge.request('user-question', {
    id,
    conversationId,
    payload: { payload },
  });
}
