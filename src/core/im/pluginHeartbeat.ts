/**
 * PluginHeartbeat — Heartbeat registration for IM plugins
 *
 * Some IM platforms (e.g. D-Chat) require periodic heartbeat POSTs to register
 * the bot's callback URL with a gateway. This module manages the lifecycle.
 */

import { getTauriFetch } from '../llm/tauriFetch';
import { get_trigger_port } from './pluginHeartbeatUtils';
import type { PluginManifestFile } from './pluginLoader';
import { replaceTemplateVars } from './pluginLoader';

interface HeartbeatState {
  timer: ReturnType<typeof setInterval> | null;
  lastPath: string | null;
}

const heartbeats = new Map<string, HeartbeatState>();

/**
 * Start heartbeat for a plugin if configured.
 */
export function startPluginHeartbeat(
  manifest: PluginManifestFile,
  userConfig: Record<string, unknown>,
): void {
  const hb = manifest.heartbeat;
  if (!hb) return;

  const platform = manifest.platform;
  if (heartbeats.has(platform)) {
    console.log(`[Heartbeat] ${platform}: already running`);
    return;
  }

  const state: HeartbeatState = { timer: null, lastPath: null };
  heartbeats.set(platform, state);

  const intervalMs = hb.intervalMs || 10000;

  // Execute immediately, then on interval
  executeHeartbeat(manifest, userConfig, state).catch((err) => {
    console.warn(`[Heartbeat] ${platform}: initial error:`, err);
  });

  state.timer = setInterval(() => {
    executeHeartbeat(manifest, userConfig, state).catch((err) => {
      console.warn(`[Heartbeat] ${platform}: error:`, err);
    });
  }, intervalMs);

  console.log(`[Heartbeat] ${platform}: started (interval=${intervalMs}ms)`);
}

/**
 * Stop heartbeat for a plugin.
 */
export function stopPluginHeartbeat(platform: string): void {
  const state = heartbeats.get(platform);
  if (state?.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  heartbeats.delete(platform);
  console.log(`[Heartbeat] ${platform}: stopped`);
}

/**
 * Stop all plugin heartbeats.
 */
export function stopAllHeartbeats(): void {
  for (const [platform] of heartbeats) {
    stopPluginHeartbeat(platform);
  }
}

/**
 * Execute a single heartbeat cycle.
 */
async function executeHeartbeat(
  manifest: PluginManifestFile,
  userConfig: Record<string, unknown>,
  state: HeartbeatState,
): Promise<void> {
  const hb = manifest.heartbeat!;
  const platform = manifest.platform;

  // Resolve dynamic variables
  const localIp = await getLocalIp();
  if (!localIp) {
    console.warn(`[Heartbeat] ${platform}: cannot determine local IP`);
    return;
  }

  const port = await get_trigger_port();
  if (!port) {
    console.warn(`[Heartbeat] ${platform}: trigger server port not available`);
    return;
  }

  const botId = String(userConfig.botId ?? '');
  if (!botId) {
    console.warn(`[Heartbeat] ${platform}: botId not configured`);
    return;
  }

  const clientId = String(userConfig.clientId ?? '');
  const clientSecret = String(userConfig.clientSecret ?? '');

  // Build body from template — this determines the actual notification_url
  const vars: Record<string, string> = {
    botId,
    localIp,
    port: String(port),
    appId: clientId,
    appSecret: clientSecret,
    token: '',
  };
  const body = replaceTemplateVars(hb.bodyTemplate, vars);

  // Use the resolved notification_url as dedup key
  const resolvedUrl = String((body as Record<string, unknown>).notification_url ?? `${localIp}:${port}`);

  // Skip if unchanged (avoid unnecessary requests)
  if (state.lastPath === resolvedUrl) {
    return;
  }

  // Build headers
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (hb.authType === 'basic' && clientId && clientSecret) {
    headers['Authorization'] = `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
  }

  try {
    const f = await getTauriFetch();
    console.log(`[Heartbeat] ${platform}: POST ${hb.url} body=${JSON.stringify(body)}`);
    const resp = await f(hb.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      console.warn(`[Heartbeat] ${platform}: HTTP ${resp.status}: ${text}`);
      return;
    }

    const data = await resp.json() as Record<string, unknown>;
    if (data.code === 0) {
      state.lastPath = resolvedUrl;
      console.log(`[Heartbeat] ${platform}: registered → ${resolvedUrl}`);
    } else {
      console.warn(`[Heartbeat] ${platform}: API response:`, JSON.stringify(data));
    }
  } catch (err) {
    console.warn(`[Heartbeat] ${platform}: request failed:`, err);
  }
}

/**
 * Get local LAN IPv4 address via Rust Tauri command.
 * Uses UDP socket trick — no shell execution, no security concerns.
 */
async function getLocalIp(): Promise<string | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const ip = await invoke<string | null>('get_local_ip');
    return ip ?? null;
  } catch (err) {
    console.warn('[Heartbeat] getLocalIp error:', err);
    return null;
  }
}
