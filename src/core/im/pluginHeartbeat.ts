/**
 * PluginHeartbeat — Heartbeat registration for IM plugins
 *
 * Some IM platforms (e.g. D-Chat) require periodic heartbeat POSTs to register
 * the bot's callback URL with a gateway. This module manages the lifecycle.
 *
 * Resilience: uses setTimeout (not setInterval) with exponential backoff on
 * consecutive failures. After 3 failures the interval ramps up to cap at 5min,
 * and noisy logs are suppressed to console.debug.
 */

import { getTauriFetch } from '../llm/tauriFetch';
import { get_trigger_port } from './pluginHeartbeatUtils';
import type { PluginManifestFile } from './pluginLoader';
import { replaceTemplateVars } from './pluginLoader';

/** Max backoff cap: 5 minutes */
const MAX_BACKOFF_MS = 5 * 60 * 1000;
/** After this many consecutive failures, suppress warn → debug */
const QUIET_AFTER = 3;

interface HeartbeatState {
  timer: ReturnType<typeof setTimeout> | null;
  lastPath: string | null;
  failures: number;
}

const heartbeats = new Map<string, HeartbeatState>();

/**
 * Calculate next delay: base * 2^failures, capped at MAX_BACKOFF_MS.
 */
function nextDelay(baseMs: number, failures: number): number {
  if (failures <= 0) return baseMs;
  return Math.min(baseMs * Math.pow(2, failures), MAX_BACKOFF_MS);
}

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
    return; // already running, silent
  }

  const state: HeartbeatState = { timer: null, lastPath: null, failures: 0 };
  heartbeats.set(platform, state);

  const baseMs = hb.intervalMs || 10000;

  function scheduleNext() {
    if (!heartbeats.has(platform)) return; // stopped
    const delay = nextDelay(baseMs, state.failures);
    state.timer = setTimeout(async () => {
      await tick();
      scheduleNext();
    }, delay);
  }

  async function tick() {
    try {
      await executeHeartbeat(manifest, userConfig, state);
      // success — reset failures
      if (state.failures > 0) {
        console.log(`[Heartbeat] ${platform}: recovered after ${state.failures} failures`);
        state.failures = 0;
      }
    } catch {
      // executeHeartbeat handles its own errors internally and never throws,
      // but guard just in case
    }
  }

  // Execute immediately, then schedule
  tick().then(() => scheduleNext());
  console.log(`[Heartbeat] ${platform}: started (interval=${baseMs}ms)`);
}

/**
 * Stop heartbeat for a plugin.
 */
export function stopPluginHeartbeat(platform: string): void {
  const state = heartbeats.get(platform);
  if (state?.timer) {
    clearTimeout(state.timer);
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
 * On failure: increments state.failures and logs appropriately.
 */
async function executeHeartbeat(
  manifest: PluginManifestFile,
  userConfig: Record<string, unknown>,
  state: HeartbeatState,
): Promise<void> {
  const hb = manifest.heartbeat!;
  const platform = manifest.platform;
  const quiet = state.failures >= QUIET_AFTER;
  // Helper: use debug when already in backoff, warn on first few failures
  const log = quiet ? console.debug : console.warn;

  // Resolve dynamic variables
  const localIp = await getLocalIp();
  if (!localIp) {
    state.failures++;
    log(`[Heartbeat] ${platform}: cannot determine local IP`);
    return;
  }

  const port = await get_trigger_port();
  if (!port) {
    state.failures++;
    log(`[Heartbeat] ${platform}: trigger server port not available`);
    return;
  }

  const botId = String(userConfig.botId ?? '');
  if (!botId) {
    state.failures++;
    log(`[Heartbeat] ${platform}: botId not configured`);
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
    if (!quiet) {
      console.log(`[Heartbeat] ${platform}: POST ${hb.url} body=${JSON.stringify(body)}`);
    }
    const resp = await f(hb.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      state.failures++;
      log(`[Heartbeat] ${platform}: HTTP ${resp.status}: ${text}`);
      if (state.failures === QUIET_AFTER) {
        console.warn(`[Heartbeat] ${platform}: ${QUIET_AFTER} consecutive failures, backing off (next in ${nextDelay(hb.intervalMs || 10000, state.failures) / 1000}s)`);
      }
      return;
    }

    const data = await resp.json() as Record<string, unknown>;
    if (data.code === 0) {
      state.lastPath = resolvedUrl;
      state.failures = 0;
      console.log(`[Heartbeat] ${platform}: registered → ${resolvedUrl}`);
    } else {
      state.failures++;
      log(`[Heartbeat] ${platform}: API response:`, JSON.stringify(data));
    }
  } catch (err) {
    state.failures++;
    if (state.failures === QUIET_AFTER) {
      console.warn(`[Heartbeat] ${platform}: ${QUIET_AFTER} consecutive failures, backing off (next in ${nextDelay(hb.intervalMs || 10000, state.failures) / 1000}s)`);
    } else {
      log(`[Heartbeat] ${platform}: request failed:`, err);
    }
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
