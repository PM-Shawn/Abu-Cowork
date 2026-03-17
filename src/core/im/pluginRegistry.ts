/**
 * IM Plugin Registry — Extension point for external IM platform plugins
 *
 * Plugins (e.g. D-Chat) register their adapter, inbound parser, token fetcher,
 * and lifecycle hooks at runtime. Core modules query this registry as fallback
 * when a platform is not built-in.
 */

import type { IMAdapter } from './adapters/types';
import type { NormalizedIMMessage } from './inboundRouter';
import type { IMPlatform } from '../../types/im';

// ── Plugin Interfaces ──

/** Metadata declared by a plugin — drives UI rendering and capability queries */
export interface IMPluginManifest {
  /** Unique platform identifier (e.g. 'dchat') */
  platform: string;
  /** Display name for UI (e.g. 'D-Chat') */
  displayName: string;
  /** Short label for sidebar badge (e.g. 'DC') */
  shortLabel: string;
  /** Platform capabilities */
  capabilities: {
    markdown: boolean;
    card: boolean;
    messageUpdate: boolean;
    /** How the platform receives messages */
    connectionType: 'webhook' | 'websocket' | 'heartbeat';
  };
}

/** Token fetch result */
export interface PluginTokenResult {
  token: string;
  expiresAt: number;
}

/** Complete plugin registration */
export interface IMPluginRegistration {
  manifest: IMPluginManifest;
  /** Outbound adapter (send messages) */
  adapter: IMAdapter;
  /** Parse inbound webhook payload into normalized message */
  parseInbound: (payload: Record<string, unknown>) => NormalizedIMMessage | null;
  /** Fetch access token (optional — some platforms use webhook-only) */
  fetchToken?: (appId: string, appSecret: string) => Promise<PluginTokenResult>;
  /** Called when channel is enabled — e.g. start heartbeat */
  onStart?: (config: Record<string, unknown>) => Promise<void>;
  /** Called when channel is disabled — e.g. stop heartbeat */
  onStop?: () => Promise<void>;
}

// ── Registry ──

const plugins = new Map<string, IMPluginRegistration>();

/**
 * Register an IM platform plugin.
 * Call this from plugin's index.ts entry point.
 */
export function registerIMPlugin(registration: IMPluginRegistration): void {
  const { platform } = registration.manifest;
  plugins.set(platform, registration);
  console.log(`[IMPlugin] Registered plugin: ${registration.manifest.displayName} (${platform})`);
}

/**
 * Unregister an IM platform plugin.
 */
export function unregisterIMPlugin(platform: string): void {
  if (plugins.delete(platform)) {
    console.log(`[IMPlugin] Unregistered plugin: ${platform}`);
  }
}

/**
 * Get a registered plugin by platform identifier.
 */
export function getIMPlugin(platform: string): IMPluginRegistration | undefined {
  return plugins.get(platform);
}

/**
 * Get all registered plugin manifests.
 */
export function getRegisteredPluginManifests(): IMPluginManifest[] {
  return Array.from(plugins.values()).map((p) => p.manifest);
}

/**
 * Check whether a platform is provided by a plugin (vs built-in).
 */
export function isPluginPlatform(platform: string): boolean {
  return plugins.has(platform);
}

/**
 * Check whether a platform requires an active connection (websocket/heartbeat)
 * vs passive webhook. Used by store to determine status behavior.
 */
export function needsActiveConnection(platform: IMPlatform): boolean {
  const plugin = plugins.get(platform);
  if (plugin) {
    const ct = plugin.manifest.capabilities.connectionType;
    return ct === 'websocket' || ct === 'heartbeat';
  }
  // Built-in: only feishu uses websocket
  return platform === 'feishu';
}
