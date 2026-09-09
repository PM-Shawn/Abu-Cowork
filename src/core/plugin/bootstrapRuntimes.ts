import { initBuiltinBrowserRuntime, cleanupBuiltinBrowserRuntime } from '../browser/builtinBrowserRuntime';
import { initMCPStoreSync, cleanupMCPStoreSync } from '@/stores/mcpStore';
import { bootstrapPluginUpdates } from '@/stores/pluginStore';

/** The private browser is independent of user plugin recovery and market IO. */
export function startCapabilityRuntimes(): () => void {
  initBuiltinBrowserRuntime();
  // Plugin recovery and MCP startup are INDEPENDENT subsystems. Chaining them
  // let one unreadable plugin journal keep every user-configured connector
  // offline, with the only explanation buried in the plugins tab. Plugin-owned
  // servers stay fail-closed meanwhile: activationReady is false until recovery
  // finishes, and bootstrapPluginUpdates connects them itself once ownership is
  // known. Start recovery first so it marks activationReady=false (synchronously,
  // before its first await) ahead of this connectAllEnabled pass.
  const recovery = bootstrapPluginUpdates();
  initMCPStoreSync();
  void recovery.catch(error => {
    console.warn('[App] Plugin recovery failed; plugin capabilities stay disabled:', error);
  });
  return () => {
    void cleanupBuiltinBrowserRuntime();
    cleanupMCPStoreSync();
  };
}
