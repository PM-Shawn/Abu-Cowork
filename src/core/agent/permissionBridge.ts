/**
 * Permission Bridge — queue systems for command confirmation, file permission, and workspace requests.
 * Extracted from agentLoop.ts to reduce coupling.
 *
 * Loop context is stored per-loopId in a Map to support concurrent agents.
 */
import type { ConfirmationInfo, FilePermissionCallback } from '../tools/registry';
import type { UserQuestionPayload, UserQuestionResult } from '../../types';
import { usePermissionStore } from '../../stores/permissionStore';
import type { PermissionDuration } from '../../stores/permissionStore';
import { authorizeWorkspace } from '../tools/pathSafety';
import type { EventRouter } from './eventRouter';

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

// Global state for pending command confirmation
let pendingConfirmation: {
  info: ConfirmationInfo;
  conversationId: string;
  agentName?: string;
  resolve: (confirmed: boolean) => void;
} | null = null;

// Queue for command confirmations — prevents overwriting when multiple dangerous commands fire in sequence
const confirmationQueue: Array<{
  info: ConfirmationInfo;
  conversationId: string;
  agentName?: string;
  resolve: (confirmed: boolean) => void;
}> = [];

// Subscribers for command confirmation state changes
const confirmationListeners = new Set<() => void>();

function notifyConfirmationListeners() {
  confirmationListeners.forEach(listener => listener());
}

/**
 * Subscribe to command confirmation state changes
 * For use with useSyncExternalStore
 */
export function subscribeToCommandConfirmation(callback: () => void): () => void {
  confirmationListeners.add(callback);
  return () => confirmationListeners.delete(callback);
}

/**
 * Get the current pending command confirmation request
 */
export function getPendingCommandConfirmation() {
  return pendingConfirmation;
}

/**
 * Resolve the pending command confirmation and process next in queue
 */
export function resolveCommandConfirmation(confirmed: boolean) {
  if (pendingConfirmation) {
    pendingConfirmation.resolve(confirmed);
    pendingConfirmation = null;

    // Process next queued confirmation
    processNextConfirmation();
  }
}

function processNextConfirmation() {
  if (confirmationQueue.length > 0) {
    pendingConfirmation = confirmationQueue.shift()!;
  }
  notifyConfirmationListeners();
}

/**
 * Drain the confirmation queue — reject all pending confirmations.
 * Called on abort to prevent stale confirmation dialogs.
 */
export function drainConfirmationQueue() {
  while (confirmationQueue.length > 0) {
    const req = confirmationQueue.shift()!;
    req.resolve(false);
  }
  if (pendingConfirmation) {
    pendingConfirmation.resolve(false);
    pendingConfirmation = null;
    notifyConfirmationListeners();
  }
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
  return new Promise((resolve) => {
    if (pendingConfirmation) {
      // Queue instead of overwriting
      confirmationQueue.push({ info, conversationId: convId, agentName, resolve });
    } else {
      pendingConfirmation = { info, conversationId: convId, agentName, resolve };
      notifyConfirmationListeners();
    }
  });
}

// ── File Permission Request Infrastructure ──

export interface FilePermissionRequest {
  path: string;
  capability: 'read' | 'write';
  toolName: string;
  conversationId: string;
  agentName?: string;
  resolve: (granted: boolean) => void;
}

let pendingFilePermission: FilePermissionRequest | null = null;
const filePermissionQueue: FilePermissionRequest[] = [];
let isProcessingFilePermission = false;

const filePermissionListeners = new Set<() => void>();

function notifyFilePermissionListeners() {
  filePermissionListeners.forEach(listener => listener());
}

/**
 * Subscribe to file permission state changes (for useSyncExternalStore)
 */
export function subscribeToFilePermission(callback: () => void): () => void {
  filePermissionListeners.add(callback);
  return () => filePermissionListeners.delete(callback);
}

/**
 * Get the current pending file permission request
 */
export function getPendingFilePermission(): FilePermissionRequest | null {
  return pendingFilePermission;
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
  if (pendingFilePermission) {
    if (granted && path && capabilities && duration) {
      // Grant permission via permissionStore (which syncs to pathSafety)
      usePermissionStore.getState().grantPermission(path, capabilities, duration);
    }
    pendingFilePermission.resolve(granted);
    pendingFilePermission = null;
    notifyFilePermissionListeners();

    // Process next queued request
    processNextFilePermission();
  }
}

function processNextFilePermission() {
  while (filePermissionQueue.length > 0) {
    const next = filePermissionQueue.shift()!;

    // Re-check if permission was already granted (another tool may have triggered it)
    const permStore = usePermissionStore.getState();
    if (permStore.hasPermission(next.path, next.capability)) {
      next.resolve(true);
      continue;
    }

    pendingFilePermission = next;
    notifyFilePermissionListeners();
    return;
  }

  isProcessingFilePermission = false;
}

/**
 * Drain the file permission queue — reject all pending requests.
 * Called on abort to prevent stale permission dialogs.
 */
export function drainFilePermissionQueue() {
  // Reject all queued requests
  while (filePermissionQueue.length > 0) {
    const req = filePermissionQueue.shift()!;
    req.resolve(false);
  }
  // Clear current pending request
  if (pendingFilePermission) {
    pendingFilePermission.resolve(false);
    pendingFilePermission = null;
    notifyFilePermissionListeners();
  }
  isProcessingFilePermission = false;
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
  return new Promise((resolve) => {
    const filePermReq: FilePermissionRequest = { ...request, conversationId: convId, agentName, resolve };

    if (!isProcessingFilePermission) {
      isProcessingFilePermission = true;
      pendingFilePermission = filePermReq;
      notifyFilePermissionListeners();
    } else {
      // Queue for later processing
      filePermissionQueue.push(filePermReq);
    }
  });
}

// ── Workspace Request Infrastructure ──

export interface WorkspaceRequest {
  reason: string;
  conversationId: string;
  suggestedPath?: string;
  resolve: (path: string | null) => void;
}

let pendingWorkspaceRequest: WorkspaceRequest | null = null;
const workspaceRequestListeners = new Set<() => void>();

function notifyWorkspaceRequestListeners() {
  workspaceRequestListeners.forEach(listener => listener());
}

/**
 * Subscribe to workspace request state changes (for useSyncExternalStore)
 */
export function subscribeToWorkspaceRequest(callback: () => void): () => void {
  workspaceRequestListeners.add(callback);
  return () => workspaceRequestListeners.delete(callback);
}

/**
 * Get the current pending workspace request
 */
export function getPendingWorkspaceRequest(): WorkspaceRequest | null {
  return pendingWorkspaceRequest;
}

/**
 * Resolve the pending workspace request (called from UI)
 */
export function resolveWorkspaceRequest(path: string | null): void {
  if (pendingWorkspaceRequest) {
    pendingWorkspaceRequest.resolve(path);
    pendingWorkspaceRequest = null;
    notifyWorkspaceRequestListeners();
  }
}

/**
 * Drain workspace request — reject pending request on abort
 */
export function drainWorkspaceRequest(): void {
  if (pendingWorkspaceRequest) {
    pendingWorkspaceRequest.resolve(null);
    pendingWorkspaceRequest = null;
    notifyWorkspaceRequestListeners();
  }
}

/** Timeout for workspace selection — auto-resolve(null) if user doesn't respond */
const WORKSPACE_REQUEST_TIMEOUT_MS = 60_000; // 60 seconds

/**
 * Request the user to select a workspace folder.
 * Called from the request_workspace tool.
 * Auto-resolves to null after timeout to prevent indefinite hangs.
 */
export async function requestWorkspace(reason: string, conversationId?: string, suggestedPath?: string): Promise<string | null> {
  const convId = conversationId ?? getCurrentLoopContext()?.conversationId ?? '';
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingWorkspaceRequest?.resolve === wrappedResolve) {
        console.warn('[AgentLoop] Workspace request timed out, auto-cancelling');
        pendingWorkspaceRequest = null;
        notifyWorkspaceRequestListeners();
        resolve(null);
      }
    }, WORKSPACE_REQUEST_TIMEOUT_MS);

    const wrappedResolve = (path: string | null) => {
      clearTimeout(timer);
      resolve(path);
    };

    pendingWorkspaceRequest = { reason, conversationId: convId, suggestedPath, resolve: wrappedResolve };
    notifyWorkspaceRequestListeners();
  });
}

// ── User Question Infrastructure ──

export interface PendingUserQuestion {
  id: string;              // = toolCallId
  conversationId: string;
  payload: UserQuestionPayload;
  resolve: (r: UserQuestionResult | null) => void;
}

/** Queue — supports multiple conversations; isConcurrencySafe:false keeps it serial per conv */
let userQuestionQueue: PendingUserQuestion[] = [];

const userQuestionListeners = new Set<() => void>();

/** 10 minutes — user may need time to read and decide before auto-cancel */
const USER_QUESTION_TIMEOUT_MS = 10 * 60 * 1000;

function notifyUserQuestionListeners() {
  userQuestionListeners.forEach((l) => l());
}

/**
 * Subscribe to user question state changes (for useSyncExternalStore)
 */
export function subscribeUserQuestion(callback: () => void): () => void {
  userQuestionListeners.add(callback);
  return () => userQuestionListeners.delete(callback);
}

/**
 * Get the current pending user questions snapshot (for useSyncExternalStore).
 * Returns a stable array reference until the queue mutates.
 */
export function getPendingUserQuestions(): PendingUserQuestion[] {
  return userQuestionQueue;
}

/**
 * Resolve a specific user question (from UserQuestionCard on submit, or timeout).
 */
export function resolveUserQuestion(id: string, r: UserQuestionResult | null): void {
  const idx = userQuestionQueue.findIndex((q) => q.id === id);
  if (idx === -1) return;
  const item = userQuestionQueue[idx];
  userQuestionQueue = userQuestionQueue.filter((_, i) => i !== idx);
  item.resolve(r);
  notifyUserQuestionListeners();
}

/**
 * Drain all pending user questions — resolve(null) so blocked tools exit.
 */
export function drainUserQuestions(): void {
  if (userQuestionQueue.length === 0) return;
  const drained = userQuestionQueue;
  userQuestionQueue = [];
  for (const item of drained) {
    item.resolve(null);
  }
  notifyUserQuestionListeners();
}

/**
 * Drain user questions for a specific conversation (on conversation delete).
 */
export function drainUserQuestionsForConversation(conversationId: string): void {
  const keep: PendingUserQuestion[] = [];
  const drain: PendingUserQuestion[] = [];
  for (const q of userQuestionQueue) {
    if (q.conversationId === conversationId) {
      drain.push(q);
    } else {
      keep.push(q);
    }
  }
  if (drain.length === 0) return;
  userQuestionQueue = keep;
  for (const item of drain) {
    item.resolve(null);
  }
  notifyUserQuestionListeners();
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
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.warn('[permissionBridge] UserQuestion timed out, auto-cancelling', id);
      resolveUserQuestion(id, null);
    }, USER_QUESTION_TIMEOUT_MS);

    const wrappedResolve = (r: UserQuestionResult | null) => {
      clearTimeout(timer);
      resolve(r);
    };

    userQuestionQueue = [...userQuestionQueue, { id, conversationId, payload, resolve: wrappedResolve }];
    notifyUserQuestionListeners();
  });
}
