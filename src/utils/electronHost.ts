/**
 * Electron exposes the renderer marker from preload and gives its standalone
 * Node sidecar an explicit command-host environment marker. Tauri has none of
 * these signals, so its runtime and invoke contracts remain unchanged.
 */
import type { MediaRef } from '@/core/subagent/delegatedUserTurn';

interface AbuShellBridge {
  mainSupervisesSidecar?: boolean;
  canonicalizePathForPolicy?: (path: string, followFinalSymlink?: boolean) => Promise<string>;
  getPathForFile?: (file: File) => string;
  saveImageAttachment?: (request: ElectronImageSaveRequest) => Promise<ElectronImageSaveResult>;
  authorizeUserAttachment?: (file: File, request: ElectronUserAttachmentAuthorizeRequest) => Promise<ElectronUserAttachmentToken>;
  selectUserAttachments?: (request: ElectronUserAttachmentSelectRequest) => Promise<ElectronUserAttachmentToken[]>;
  readUserAttachment?: (request: ElectronUserAttachmentReadRequest) => Promise<Uint8Array>;
  releaseUserAttachment?: (request: ElectronUserAttachmentReleaseRequest) => Promise<ElectronUserAttachmentReleaseResult>;
  persistDelegatedMedia?: (request: ElectronDelegatedMediaPersistRequest) => Promise<MediaRef>;
  readDelegatedMedia?: (request: ElectronDelegatedMediaReadRequest) => Promise<Uint8Array | null>;
  subscribeSidecarEvents?: (handler: (event: ElectronSidecarEvent) => void) => () => void;
  getSidecarBridgeSnapshot?: (afterSequence?: number) => Promise<ElectronSidecarBridgeSnapshot>;
  recordRuntimeEvent?: (event: Record<string, unknown>) => void;
  getRuntimeDiagnostics?: () => Promise<ElectronRuntimeDiagnostics>;
}

export interface ElectronImageSaveRequest {
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  suggestedName?: string;
  data: Uint8Array;
}

export const MAX_ELECTRON_IMAGE_SAVE_BYTES = 32 * 1024 * 1024;

export interface ElectronImageSaveResult {
  saved: boolean;
  fileName?: string;
}

export interface ElectronUserAttachmentReadRequest {
  token: string;
}

export interface ElectronUserAttachmentReleaseRequest {
  token: string;
}

export interface ElectronUserAttachmentReleaseResult {
  released: boolean;
}

export interface ElectronUserAttachmentAuthorizeRequest {
  mediaType: ElectronUserAttachmentMediaType;
  maxBytes?: number;
}

export type ElectronUserAttachmentMediaType =
  | 'image/jpeg'
  | 'image/png'
  | 'image/gif'
  | 'image/webp';

export interface ElectronUserAttachmentSelectRequest {
  mediaTypes?: ElectronUserAttachmentMediaType[];
}

export interface ElectronUserAttachmentToken {
  token: string;
  name: string;
  mediaType: ElectronUserAttachmentMediaType;
  expiresAt: number;
}

export interface ElectronDelegatedMediaPersistRequest {
  conversationId: string;
  bytes: Uint8Array;
  mediaType: string;
  width?: number;
  height?: number;
}

export interface ElectronDelegatedMediaReadRequest {
  conversationId: string;
  ref: MediaRef;
}

export interface ElectronSidecarEvent {
  type: 'message' | 'error' | 'close' | 'hung';
  payload: string;
  sequence: number;
  generation: number;
}

export interface ElectronSidecarRunFact {
  runId: string;
  state: 'pending' | 'accepted' | 'running' | 'terminal';
  generation: number;
  updatedAt: number;
  clientMessageId?: string;
  acceptedAt?: number;
  terminalAt?: number;
  terminal?: Record<string, unknown>;
}

export interface ElectronSidecarBridgeSnapshot {
  version: 1;
  sidecarId: 'abu-sidecar';
  generation: number;
  bridgeStatus: 'stopped' | 'starting' | 'running' | 'disconnected' | 'hung';
  firstAvailableSequence: number;
  lastSequence: number;
  truncated: boolean;
  events: ElectronSidecarEvent[];
  runs: ElectronSidecarRunFact[];
}

export interface ElectronRuntimeDiagnostics {
  schemaVersion: 1;
  appSessionId: string;
  recentEventLines: string[];
  pendingRpcs: Array<Record<string, unknown>>;
  sidecars: Array<Record<string, unknown>>;
  pendingRendererAcks: Array<Record<string, unknown>>;
  nativeHelpers: Array<Record<string, unknown>>;
}

function getRuntime() {
  return globalThis as typeof globalThis & {
    __ABU_SHELL__?: AbuShellBridge;
    process?: { env?: Record<string, string | undefined> };
  };
}

export function hasElectronCommandHost(): boolean {
  const runtime = getRuntime();
  return (
    runtime.__ABU_SHELL__?.mainSupervisesSidecar === true ||
    runtime.process?.env?.ABU_ELECTRON_COMMAND_HOST === '1' ||
    runtime.process?.env?.ELECTRON_RUN_AS_NODE === '1'
  );
}

/** Resolve the native path of a user-provided Electron File object. */
export function getElectronFilePath(file: File): string {
  return getRuntime().__ABU_SHELL__?.getPathForFile?.(file) ?? '';
}

export function hasElectronImageSaveHost(): boolean {
  return typeof getRuntime().__ABU_SHELL__?.saveImageAttachment === 'function';
}

export function hasElectronUserAttachmentReadHost(): boolean {
  return typeof getRuntime().__ABU_SHELL__?.readUserAttachment === 'function';
}

export function hasElectronUserAttachmentAuthorizeHost(): boolean {
  const shell = getRuntime().__ABU_SHELL__;
  return typeof shell?.authorizeUserAttachment === 'function'
    && typeof shell.readUserAttachment === 'function';
}

export function hasElectronUserAttachmentSelectHost(): boolean {
  const shell = getRuntime().__ABU_SHELL__;
  return typeof shell?.selectUserAttachments === 'function'
    && typeof shell.readUserAttachment === 'function';
}

export function hasElectronUserAttachmentReleaseHost(): boolean {
  return typeof getRuntime().__ABU_SHELL__?.releaseUserAttachment === 'function';
}

export function hasElectronDelegatedMediaStore(): boolean {
  const shell = getRuntime().__ABU_SHELL__;
  return typeof shell?.persistDelegatedMedia === 'function'
    && typeof shell.readDelegatedMedia === 'function';
}

/** Save one image through Electron's user-mediated native save dialog. */
export async function saveElectronImageAttachment(
  request: ElectronImageSaveRequest,
): Promise<ElectronImageSaveResult | null> {
  const save = getRuntime().__ABU_SHELL__?.saveImageAttachment;
  return save ? await save(request) : null;
}

export async function readElectronUserAttachment(
  request: ElectronUserAttachmentReadRequest,
): Promise<Uint8Array> {
  const read = getRuntime().__ABU_SHELL__?.readUserAttachment;
  if (!read) throw new Error('Electron attachment read host is unavailable');
  return await read(request);
}

export async function releaseElectronUserAttachment(
  request: ElectronUserAttachmentReleaseRequest,
): Promise<ElectronUserAttachmentReleaseResult> {
  const release = getRuntime().__ABU_SHELL__?.releaseUserAttachment;
  if (!release) throw new Error('Electron attachment release host is unavailable');
  return await release(request);
}

export async function authorizeElectronUserAttachment(
  file: File,
  request: ElectronUserAttachmentAuthorizeRequest,
): Promise<ElectronUserAttachmentToken> {
  const authorize = getRuntime().__ABU_SHELL__?.authorizeUserAttachment;
  if (!authorize) throw new Error('Electron attachment authorization host is unavailable');
  return await authorize(file, request);
}

export async function selectElectronUserAttachments(
  request: ElectronUserAttachmentSelectRequest = {},
): Promise<ElectronUserAttachmentToken[]> {
  const select = getRuntime().__ABU_SHELL__?.selectUserAttachments;
  if (!select) throw new Error('Electron attachment picker host is unavailable');
  return await select(request);
}

export async function persistElectronDelegatedMedia(
  request: ElectronDelegatedMediaPersistRequest,
): Promise<MediaRef> {
  const persist = getRuntime().__ABU_SHELL__?.persistDelegatedMedia;
  if (!persist) throw new Error('Electron delegated media store is unavailable');
  return await persist(request);
}

export async function readElectronDelegatedMedia(
  request: ElectronDelegatedMediaReadRequest,
  signal?: AbortSignal,
): Promise<Uint8Array | null> {
  const read = getRuntime().__ABU_SHELL__?.readDelegatedMedia;
  if (!read) return null;
  if (!signal) return await read(request);
  if (signal.aborted) throw new Error('Delegated media read aborted');
  return await new Promise<Uint8Array | null>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(new Error('Delegated media read aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    read(request).then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Return Electron main's canonical path for an authorization decision. `null`
 * means the narrow Electron bridge is absent (legacy Tauri/Web), in which case
 * callers retain their existing fail-closed path inspection. Bridge errors are
 * intentionally not swallowed: a dangling/inaccessible symlink is unsafe.
 */
export async function canonicalizeElectronPathForPolicy(
  path: string,
  followFinalSymlink = true,
): Promise<string | null> {
  const canonicalize = getRuntime().__ABU_SHELL__?.canonicalizePathForPolicy;
  return canonicalize ? await canonicalize(path, followFinalSymlink) : null;
}

export function subscribeElectronSidecarEvents(
  handler: (event: ElectronSidecarEvent) => void,
): (() => void) | null {
  return getRuntime().__ABU_SHELL__?.subscribeSidecarEvents?.(handler) ?? null;
}

export async function getElectronSidecarBridgeSnapshot(
  afterSequence = 0,
): Promise<ElectronSidecarBridgeSnapshot | null> {
  try {
    return await getRuntime().__ABU_SHELL__?.getSidecarBridgeSnapshot?.(afterSequence) ?? null;
  } catch {
    return null;
  }
}

/** Read a main-process mirrored run fact without requesting event replay. */
export async function getElectronSidecarRunFact(
  runId: string,
): Promise<ElectronSidecarRunFact | null> {
  const snapshot = await getElectronSidecarBridgeSnapshot(Number.MAX_SAFE_INTEGER);
  return snapshot?.runs.find((run) => run.runId === runId) ?? null;
}

export function recordElectronRuntimeEvent(event: Record<string, unknown>): void {
  try {
    getRuntime().__ABU_SHELL__?.recordRuntimeEvent?.(event);
  } catch {
    // Observability is best-effort and must never change product behavior.
  }
}

export async function getElectronRuntimeDiagnostics(): Promise<ElectronRuntimeDiagnostics | null> {
  try {
    return await getRuntime().__ABU_SHELL__?.getRuntimeDiagnostics?.() ?? null;
  } catch {
    return null;
  }
}
