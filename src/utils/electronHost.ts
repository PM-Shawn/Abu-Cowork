/**
 * Electron exposes the renderer marker from preload and gives its standalone
 * Node sidecar an explicit command-host environment marker. Tauri has none of
 * these signals, so its runtime and invoke contracts remain unchanged.
 */
export function hasElectronCommandHost(): boolean {
  const runtime = globalThis as typeof globalThis & {
    __ABU_SHELL__?: { mainSupervisesSidecar?: boolean };
    process?: { env?: Record<string, string | undefined> };
  };
  return (
    runtime.__ABU_SHELL__?.mainSupervisesSidecar === true ||
    runtime.process?.env?.ABU_ELECTRON_COMMAND_HOST === '1' ||
    runtime.process?.env?.ELECTRON_RUN_AS_NODE === '1'
  );
}
