/**
 * Permission Bridge — queue systems for command confirmation, file permission, and workspace requests.
 * Extracted from agentLoop.ts to reduce coupling.
 */
import type { ConfirmationInfo, FilePermissionCallback } from '../tools/registry';
import { usePermissionStore } from '../../stores/permissionStore';
import type { PermissionDuration } from '../../stores/permissionStore';
import { authorizeWorkspace } from '../tools/pathSafety';
import type { EventRouter } from './eventRouter';

// ── Current Loop Context ──

// Module-level: current loop's context for delegate_to_agent tool
let currentLoopContext: {
  commandConfirmCallback: (info: ConfirmationInfo) => Promise<boolean>;
  filePermissionCallback: FilePermissionCallback;
  signal: AbortSignal;
  eventRouter: EventRouter;
  loopId: string;
  conversationId: string;
  toolCallToStepId: Map<string, string>;
} | null = null;

export function getCurrentLoopContext() {
  return currentLoopContext;
}

export function setCurrentLoopContext(ctx: typeof currentLoopContext) {
  currentLoopContext = ctx;
}

// ── Command Confirmation System ──

// Global state for pending command confirmation
let pendingConfirmation: {
  info: ConfirmationInfo;
  conversationId: string;
  resolve: (confirmed: boolean) => void;
} | null = null;

// Queue for command confirmations — prevents overwriting when multiple dangerous commands fire in sequence
const confirmationQueue: Array<{
  info: ConfirmationInfo;
  conversationId: string;
  resolve: (confirmed: boolean) => void;
}> = [];

// Subscribers for command confirmation state changes
// NOTE: Listeners are auto-cleaned via the unsubscribe function returned by subscribeToCommandConfirmation,
// which is used as the cleanup callback in useSyncExternalStore. No manual cleanup needed.
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
 * Request confirmation for a dangerous command
 * Returns a promise that resolves when user confirms or cancels.
 * If another confirmation is already pending, this request is queued.
 */
export async function requestCommandConfirmation(info: ConfirmationInfo): Promise<boolean> {
  const convId = currentLoopContext?.conversationId ?? '';
  return new Promise((resolve) => {
    if (pendingConfirmation) {
      // Queue instead of overwriting
      confirmationQueue.push({ info, conversationId: convId, resolve });
    } else {
      pendingConfirmation = { info, conversationId: convId, resolve };
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
  resolve: (granted: boolean) => void;
}

let pendingFilePermission: FilePermissionRequest | null = null;
const filePermissionQueue: FilePermissionRequest[] = [];
let isProcessingFilePermission = false;

// NOTE: Listeners are auto-cleaned via the unsubscribe function returned by subscribeToFilePermission,
// which is used as the cleanup callback in useSyncExternalStore. No manual cleanup needed.
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
 * Request file permission — checks permissionStore first, then queues for UI
 */
export async function requestFilePermission(request: {
  path: string;
  capability: 'read' | 'write';
  toolName: string;
}): Promise<boolean> {
  const permStore = usePermissionStore.getState();

  // Already has permission → auto-allow
  if (permStore.hasPermission(request.path, request.capability)) {
    // Also sync to pathSafety in case it wasn't already
    authorizeWorkspace(request.path);
    return true;
  }

  const convId = currentLoopContext?.conversationId ?? '';
  return new Promise((resolve) => {
    const filePermReq: FilePermissionRequest = { ...request, conversationId: convId, resolve };

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
  const convId = conversationId ?? currentLoopContext?.conversationId ?? '';
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
