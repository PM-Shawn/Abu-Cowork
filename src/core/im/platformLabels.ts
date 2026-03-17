/**
 * Platform Labels — Unified label resolution for IM platforms
 *
 * Reads from adapter registry (displayName) and plugin manifests (shortLabel).
 * Eliminates hardcoded platform label maps scattered across UI components.
 */

import { getAvailablePlatforms } from './adapters/registry';
import { getIMPlugin, getRegisteredPluginManifests } from './pluginRegistry';

/** Short labels for built-in platforms (sidebar badges, tray dots) */
const BUILTIN_SHORT_LABELS: Record<string, string> = {
  feishu: '飞',
  dingtalk: '钉',
  wecom: '微',
  slack: 'SL',
  custom: 'H',
};

/**
 * Get display name for a platform (e.g. '飞书', 'D-Chat', 'Slack').
 */
export function getPlatformDisplayName(platform: string): string {
  // Check adapter registry first
  const configs = getAvailablePlatforms();
  const config = configs.find((c) => c.platform === platform);
  if (config) return config.displayName;

  // Check plugin manifest
  const plugin = getIMPlugin(platform);
  if (plugin) return plugin.manifest.displayName;

  return platform;
}

/**
 * Get short label for a platform (e.g. '飞', 'DC', 'SL').
 * Used for sidebar badges and compact UI.
 */
export function getPlatformShortLabel(platform: string): string {
  // Built-in short labels
  if (BUILTIN_SHORT_LABELS[platform]) return BUILTIN_SHORT_LABELS[platform];

  // Plugin manifest
  const plugin = getIMPlugin(platform);
  if (plugin) return plugin.manifest.shortLabel;

  // Fallback: first 2 chars uppercased
  return platform.slice(0, 2).toUpperCase();
}

/**
 * Get all IM platforms as {value, label} pairs for Select/Button lists.
 * Excludes 'custom' adapter (not a real IM platform).
 */
export function getIMPlatformOptions(): { value: string; label: string }[] {
  const configs = getAvailablePlatforms().filter((c) => c.platform !== 'custom');
  const pluginManifests = getRegisteredPluginManifests();

  // Dedup: plugin may already be in adapter registry
  const seen = new Set(configs.map((c) => c.platform));
  const pluginExtras = pluginManifests
    .filter((m) => !seen.has(m.platform))
    .map((m) => ({ platform: m.platform, displayName: m.displayName }));

  return [
    ...configs.map((c) => ({ value: c.platform, label: c.displayName })),
    ...pluginExtras.map((p) => ({ value: p.platform, label: p.displayName })),
  ];
}

/**
 * Get all output platforms (IM + custom) as {value, label} pairs for trigger editor.
 */
export function getOutputPlatformOptions(): { value: string; label: string }[] {
  const imOptions = getIMPlatformOptions();
  return [...imOptions, { value: 'custom', label: 'HTTP' }];
}
