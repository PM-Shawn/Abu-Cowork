import { useRef, useState } from 'react';
import { usePluginStore } from '@/stores/pluginStore';
import type { InstalledPlugin } from '@/core/plugin/installedStore';

/** The master gate is independent of each capability's saved preference. */
export function usePluginActivation(plugin: InstalledPlugin | null, _home: string) {
  const activation = usePluginStore(s => plugin ? s.activationByKey[plugin.key] : undefined);
  const setPluginEnabled = usePluginStore(s => s.setPluginEnabled);
  const [changing, setChanging] = useState(false);
  const operation = useRef(0);
  const enabled = activation?.enabled ?? false;
  const available = Boolean(activation && !activation.conflicted && plugin && (
    plugin.contributed.skills.length + plugin.contributed.agents.length + plugin.contributed.mcpServers.length > 0
  ));
  // Allow switching off while an enable operation is still connecting MCPs.
  const busy = changing && !enabled;
  const toggle = async () => {
    if (!plugin || !available || busy) return;
    const current = ++operation.current;
    setChanging(true);
    try { await setPluginEnabled(plugin.key, !enabled); }
    finally { if (current === operation.current) setChanging(false); }
  };
  return { enabled, available, busy, toggle };
}
