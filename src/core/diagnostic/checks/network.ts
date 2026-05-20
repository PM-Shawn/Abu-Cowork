/**
 * Network check — HEAD request to the first enabled external provider's
 * baseUrl with a 5-second timeout. Tests whether reqwest (Tauri Rust layer)
 * can reach the endpoint the user actually cares about.
 *
 * Why not a hardcoded public endpoint: api.anthropic.com is blocked in
 * mainland China; google/cloudflare beacons are also unreliable there.
 * Using the user's own provider is the most meaningful signal and avoids
 * false-positives for domestic users who don't need a foreign endpoint.
 *
 * Why @tauri-apps/plugin-http instead of browser fetch: the webview's CORS
 * preflight gets blocked by most API endpoints (no Access-Control-Allow-Origin
 * for `tauri://localhost`), so browser fetch returns "Load failed" — a false
 * negative. The Tauri http plugin runs the request from the Rust process
 * (reqwest), bypassing CORS entirely.
 */

import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { useSettingsStore } from '@/stores/settingsStore';
import { getI18n } from '@/i18n';
import { mapNetworkError } from '../errorMap';
import type { CheckResult } from '../types';

const TIMEOUT_MS = 5000;

// DeepSeek and some other providers drop the connection on `/` (no body, no
// HTTP status), which reqwest surfaces as "error sending request for url" —
// a false-negative even though the actual API is reachable. Probe an
// OpenAI-compatible endpoint instead so the server responds with a real HTTP
// status (401/404), which we already treat as "reachable".
export function buildProbeUrl(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    if (u.pathname === '/' || u.pathname === '') {
      u.pathname = '/v1/models';
    }
    return u.href;
  } catch {
    return baseUrl;
  }
}

export async function runNetworkChecks(): Promise<CheckResult[]> {
  const t = getI18n();

  const enabledExternal = useSettingsStore
    .getState()
    .providers.filter(
      (p) => p.enabled && !p.baseUrl.includes('localhost') && !p.baseUrl.includes('127.0.0.1')
    );

  if (enabledExternal.length === 0) {
    return [{
      id: 'network:reachability',
      category: 'network',
      name: t.diagnostic.networkReachability,
      status: 'skipped',
      metric: '未启用外部 AI 服务',
      checkedAt: Date.now(),
      durationMs: 0,
    }];
  }

  const probeUrl = buildProbeUrl(enabledExternal[0].baseUrl);
  const start = Date.now();

  try {
    const resp = await tauriFetch(probeUrl, {
      method: 'HEAD',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const durationMs = Date.now() - start;
    // 4xx is fine — server is reachable, just rejected our HEAD.
    // 5xx means real server problem.
    if (resp.status < 500) {
      return [{
        id: 'network:reachability',
        category: 'network',
        name: t.diagnostic.networkReachability,
        status: 'passed',
        metric: `${durationMs}ms`,
        checkedAt: Date.now(),
        durationMs,
      }];
    }
    const rawError = `HTTP ${resp.status}`;
    const friendly = mapNetworkError(rawError);
    return [{
      id: 'network:reachability',
      category: 'network',
      name: t.diagnostic.networkReachability,
      status: 'failed',
      errorMessage: friendly.message,
      errorDetail: `${probeUrl} → ${rawError}`,
      suggestedAction: friendly.action,
      checkedAt: Date.now(),
      durationMs,
    }];
  } catch (e) {
    const durationMs = Date.now() - start;
    const rawError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    const friendly = mapNetworkError(rawError);
    return [{
      id: 'network:reachability',
      category: 'network',
      name: t.diagnostic.networkReachability,
      status: 'failed',
      errorMessage: friendly.message,
      errorDetail: `${probeUrl} → ${rawError}`,
      suggestedAction: friendly.action,
      checkedAt: Date.now(),
      durationMs,
    }];
  }
}
