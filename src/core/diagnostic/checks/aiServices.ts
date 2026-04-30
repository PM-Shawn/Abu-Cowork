/**
 * AI services check — for each enabled provider, run a minimal connectivity
 * probe via the existing `checkProviderHealth` (max_tokens=1 chat call or
 * Ollama tag list).
 *
 * Skipped: providers without an API key (except Ollama) — they're "未配置"
 * not "失败".
 */

import { useSettingsStore } from '@/stores/settingsStore';
import { checkProviderHealth, type HealthCheckResult } from '@/core/llm/healthCheck';
import { getI18n } from '@/i18n';
import { mapAIServiceError } from '../errorMap';
import type { CheckResult } from '../types';

/**
 * Per-provider timeout. `checkProviderHealth` for non-ollama providers calls
 * `adapter.chat()` which only enforces a 90s idle timeout from the adapter
 * itself (claude.ts:250) — a cold-start or laggy provider can keep the
 * whole banner stuck at "诊断中..." for 30s+. We race the call against an
 * 8s deadline; whoever loses gets surfaced as a "timeout" failure.
 */
const PROVIDER_TIMEOUT_MS = 8000;

function withTimeout(p: Promise<HealthCheckResult>, ms: number): Promise<HealthCheckResult> {
  return Promise.race([
    p,
    new Promise<HealthCheckResult>((resolve) =>
      setTimeout(() => resolve({ success: false, latencyMs: ms, error: `timeout (${ms}ms)` }), ms),
    ),
  ]);
}

export async function runAIServicesChecks(): Promise<CheckResult[]> {
  const t = getI18n();
  const providers = useSettingsStore.getState().providers.filter((p) => p.enabled);

  if (providers.length === 0) {
    return [{
      id: 'ai-services:none',
      category: 'ai-services',
      name: t.diagnostic.aiServicesNoProvider,
      status: 'warning',
      errorMessage: t.diagnostic.aiServicesNoProviderHint,
      suggestedAction: {
        type: 'open-settings',
        target: 'ai-services',
        label: t.diagnostic.actionOpenAIServices,
      },
      checkedAt: Date.now(),
      durationMs: 0,
    }];
  }

  const settled = await Promise.allSettled(
    providers.map(async (p) => {
      const start = Date.now();
      const id = `ai-services:${p.id}`;

      // Skipped path: requires key but none provided
      if (p.id !== 'ollama' && !p.apiKey.trim()) {
        return {
          id,
          category: 'ai-services' as const,
          name: p.name,
          status: 'skipped' as const,
          metric: t.diagnostic.aiServicesNoKey,
          checkedAt: Date.now(),
          durationMs: 0,
        };
      }

      const result = await withTimeout(checkProviderHealth(p), PROVIDER_TIMEOUT_MS);
      if (result.success) {
        return {
          id,
          category: 'ai-services' as const,
          name: p.name,
          status: 'passed' as const,
          metric: `${result.latencyMs}ms`,
          checkedAt: Date.now(),
          durationMs: Date.now() - start,
        };
      }
      // Failure path — translate via errorMap so users see human language
      // instead of raw provider JSON (see screenshots in v0.13 review).
      const friendly = mapAIServiceError({
        errorCode: result.errorCode,
        statusCode: result.statusCode,
        rawMessage: result.error ?? '',
      });
      return {
        id,
        category: 'ai-services' as const,
        name: p.name,
        status: 'failed' as const,
        errorMessage: friendly.message,
        errorDetail: result.error,
        suggestedAction: friendly.action,
        checkedAt: Date.now(),
        durationMs: Date.now() - start,
      };
    })
  );

  return settled.map((s, i) => {
    if (s.status === 'fulfilled') return s.value;
    const p = providers[i];
    return {
      id: `ai-services:${p.id}`,
      category: 'ai-services' as const,
      name: p.name,
      status: 'failed' as const,
      errorMessage: t.diagnostic.checkInternalError,
      errorDetail: s.reason instanceof Error ? s.reason.message : String(s.reason),
      checkedAt: Date.now(),
      durationMs: 0,
    };
  });
}
