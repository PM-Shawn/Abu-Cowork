/**
 * Adapter Registry — platform lookup with plugin fallback
 *
 * Built-in adapters are statically imported. Plugin adapters are queried
 * from the plugin registry as fallback.
 */

import type { IMAdapter, AdapterConfig } from './types';
import { FeishuAdapter } from './feishu';
import { DingtalkAdapter } from './dingtalk';
import { WecomAdapter } from './wecom';
import { SlackAdapter } from './slack';
import { CustomAdapter } from './custom';
import { getIMPlugin, getRegisteredPluginManifests } from '../pluginRegistry';

const builtinAdapters: Record<string, IMAdapter> = {
  feishu: new FeishuAdapter(),
  dingtalk: new DingtalkAdapter(),
  wecom: new WecomAdapter(),
  slack: new SlackAdapter(),
  custom: new CustomAdapter(),
};

/**
 * Get adapter for a platform. Checks built-in first, then plugin registry.
 */
export function getAdapter(platform: string): IMAdapter | undefined {
  const builtin = builtinAdapters[platform];
  if (builtin) return builtin;

  // Fallback: plugin-registered adapter
  const plugin = getIMPlugin(platform);
  return plugin?.adapter;
}

/**
 * Get all available platforms (built-in + plugins) for UI rendering.
 */
export function getAvailablePlatforms(): AdapterConfig[] {
  const builtin = Object.values(builtinAdapters).map((a) => a.config);
  const pluginConfigs = getRegisteredPluginManifests().map((m) => {
    // Plugin already registered its adapter — get config from there
    const plugin = getIMPlugin(m.platform);
    if (plugin) return plugin.adapter.config;
    // Fallback: synthesize from manifest
    return {
      platform: m.platform,
      displayName: m.displayName,
      maxLength: 20000,
      chunkMode: 'newline' as const,
      supportsMarkdown: m.capabilities.markdown,
      supportsCard: m.capabilities.card,
      supportsMessageUpdate: m.capabilities.messageUpdate,
    };
  });
  return [...builtin, ...pluginConfigs];
}

/**
 * Register a built-in adapter at runtime (for testing or late initialization).
 */
export function registerAdapter(adapter: IMAdapter): void {
  builtinAdapters[adapter.config.platform] = adapter;
}

// Re-export types for convenience
export type { IMAdapter, AdapterConfig } from './types';
