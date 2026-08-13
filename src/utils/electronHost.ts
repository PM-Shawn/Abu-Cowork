/**
 * Electron exposes the renderer marker from preload and gives its standalone
 * Node sidecar an explicit command-host environment marker. Tauri has none of
 * these signals, so its runtime and invoke contracts remain unchanged.
 */
interface AbuShellBridge {
  mainSupervisesSidecar?: boolean;
  getPathForFile?: (file: File) => string;
  recordRuntimeEvent?: (event: Record<string, unknown>) => void;
  getRuntimeDiagnostics?: () => Promise<ElectronRuntimeDiagnostics>;
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
