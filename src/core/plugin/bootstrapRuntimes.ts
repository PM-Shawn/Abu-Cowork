import { initBuiltinBrowserRuntime, cleanupBuiltinBrowserRuntime } from '../browser/builtinBrowserRuntime';
import { initMCPStoreSync, cleanupMCPStoreSync } from '@/stores/mcpStore';
import { bootstrapPluginUpdates } from '@/stores/pluginStore';

/** The private browser is independent of user plugin recovery and market IO. */
export function startCapabilityRuntimes(): () => void {
  let stopped = false;
  initBuiltinBrowserRuntime();
  // Plugin recovery and MCP startup must not share a FATE — one unreadable
  // plugin journal used to keep every user-configured connector offline for
  // the whole session. But MCP startup must still share an ORDER with it:
  // until plugin records are published, activationPolicy sees no owner for a
  // plugin's server (`isPluginMcpAllowed` falls through to `!knownMcp.has`)
  // and treats it as an independent one, so connecting first establishes a
  // connection that publishing ownership then invalidates by epoch — leaving
  // a plugin-provided interface resolved against a connection that is gone.
  // Settling rather than chaining gives both: recovery failure no longer
  // blocks the user's own connectors, and nothing connects before ownership
  // is known (plugin-owned servers then stay fail-closed on activationReady).
  void bootstrapPluginUpdates()
    .catch(error => {
      console.warn('[App] Plugin recovery failed; plugin capabilities stay disabled:', error);
    })
    .finally(() => {
      if (!stopped) initMCPStoreSync();
    });
  return () => {
    stopped = true;
    void cleanupBuiltinBrowserRuntime();
    cleanupMCPStoreSync();
  };
}
