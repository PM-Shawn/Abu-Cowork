import { initBuiltinBrowserRuntime, cleanupBuiltinBrowserRuntime } from '../browser/builtinBrowserRuntime';
import { initMCPStoreSync, cleanupMCPStoreSync } from '@/stores/mcpStore';
import { bootstrapPluginUpdates } from '@/stores/pluginStore';

/** The private browser is independent of user plugin recovery and market IO. */
export function startCapabilityRuntimes(): () => void {
  let stopped = false;
  initBuiltinBrowserRuntime();
  void bootstrapPluginUpdates().then(() => {
    if (!stopped) initMCPStoreSync();
  }).catch(error => {
    console.warn('[App] Plugin recovery failed; automatic MCP startup deferred:', error);
  });
  return () => {
    stopped = true;
    void cleanupBuiltinBrowserRuntime();
    cleanupMCPStoreSync();
  };
}
