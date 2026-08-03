/**
 * Electron exposes the renderer marker from preload and gives its standalone
 * Node sidecar an explicit command-host environment marker. Tauri has none of
 * these signals, so its runtime and invoke contracts remain unchanged.
 */
interface AbuShellBridge {
  mainSupervisesSidecar?: boolean;
  getPathForFile?: (file: File) => string;
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
