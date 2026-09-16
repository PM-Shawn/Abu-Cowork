import type { PluginRuntimeSnapshot } from './operationBridge';
import type { MCPServerConfig } from '@/core/mcp/client';

function executionConfig(config: MCPServerConfig): string {
  return JSON.stringify([config.transport ?? null, Object.entries(config.headers ?? {}).sort(([a], [b]) => a.localeCompare(b)), config.command ?? null, config.args ?? [], config.url ?? null,
    Object.entries(config.env ?? {}).sort(([a], [b]) => a.localeCompare(b))]);
}

/** Preserve existing consent only when the executable configuration is identical. */
export function runtimeAfterInstall(previous: PluginRuntimeSnapshot, servers: MCPServerConfig[],
  newSkills: string[], newAgents: string[], updating: boolean, enableMcp = false,
): PluginRuntimeSnapshot {
  const next: PluginRuntimeSnapshot = {
    enabled: updating ? previous.enabled : true,
    servers: Object.fromEntries(Object.keys(previous.servers).map(name => [name, null])),
    disabledSkills: { ...previous.disabledSkills }, disabledAgents: { ...previous.disabledAgents },
  };
  for (const config of servers) {
    const old = previous.servers[config.name];
    next.servers[config.name] = old && executionConfig(old) === executionConfig(config)
      ? { ...old, ...(config.pluginConfiguration ? { pluginConfiguration: config.pluginConfiguration } : {}) } : { ...config, enabled: !updating && enableMcp };
  }
  for (const name of newSkills) if (!Object.hasOwn(next.disabledSkills, name)) next.disabledSkills[name] = updating;
  for (const name of newAgents) if (!Object.hasOwn(next.disabledAgents, name)) next.disabledAgents[name] = updating;
  return next;
}
