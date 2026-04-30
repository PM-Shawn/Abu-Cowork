/**
 * Network check — single HEAD request to a generic public endpoint with a
 * 5-second timeout. We only want to know "is the network stack functional?",
 * not benchmark latency or test region-specific reachability.
 *
 * Why api.anthropic.com: it's whitelisted on most corp networks since it's
 * the default LLM endpoint. Avoid Google/Cloudflare beacons (often blocked
 * in mainland China) and avoid anything that could be misread as covert
 * exfil.
 *
 * Why @tauri-apps/plugin-http instead of browser fetch: the webview's CORS
 * preflight gets blocked by api.anthropic.com (no Access-Control-Allow-Origin
 * for `tauri://localhost`), so browser fetch returns "Load failed" — a false
 * negative. The Tauri http plugin runs the request from the Rust process
 * (reqwest), bypassing CORS entirely. Capability `http:default` already
 * permits `https://*`.
 */

import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { getI18n } from '@/i18n';
import { mapNetworkError } from '../errorMap';
import type { CheckResult } from '../types';

const PROBE_URL = 'https://api.anthropic.com';
const TIMEOUT_MS = 5000;

export async function runNetworkChecks(): Promise<CheckResult[]> {
  const t = getI18n();
  const start = Date.now();
  try {
    const resp = await tauriFetch(PROBE_URL, {
      method: 'HEAD',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const durationMs = Date.now() - start;
    // 4xx is fine — it means the server is reachable, just rejected our HEAD.
    // 5xx or no response means real network/server problem.
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
      metric: rawError,
      errorMessage: friendly.message,
      errorDetail: rawError,
      suggestedAction: friendly.action,
      checkedAt: Date.now(),
      durationMs,
    }];
  } catch (e) {
    const durationMs = Date.now() - start;
    const rawError = e instanceof Error ? e.message : String(e);
    const friendly = mapNetworkError(rawError);
    return [{
      id: 'network:reachability',
      category: 'network',
      name: t.diagnostic.networkReachability,
      status: 'failed',
      errorMessage: friendly.message,
      errorDetail: rawError,
      suggestedAction: friendly.action,
      checkedAt: Date.now(),
      durationMs,
    }];
  }
}
