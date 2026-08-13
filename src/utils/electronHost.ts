/**
 * Electron exposes the renderer marker from preload and gives its standalone
 * Node sidecar an explicit command-host environment marker. Tauri has none of
 * these signals, so its runtime and invoke contracts remain unchanged.
 */
interface AbuShellBridge {
  mainSupervisesSidecar?: boolean;
  getPathForFile?: (file: File) => string;
  subscribeSidecarEvents?: (handler: (event: ElectronSidecarEvent) => void) => () => void;
  getSidecarBridgeSnapshot?: (afterSequence?: number) => Promise<ElectronSidecarBridgeSnapshot>;
  recordRuntimeEvent?: (event: Record<string, unknown>) => void;
  getRuntimeDiagnostics?: () => Promise<ElectronRuntimeDiagnostics>;
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
