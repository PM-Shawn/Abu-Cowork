import type { ProviderInstance } from '@/types/provider';
import { ClaudeAdapter } from './claude';
import { OpenAICompatibleAdapter } from './openai-compatible';
import { LLMError, type LLMErrorCode } from './adapter';
import { getTauriFetch } from './tauriFetch';

export interface HealthCheckResult {
  success: boolean;
  latencyMs: number;
  /** One-line error string (kept for backward compat with ProviderCard / older callers). */
  error?: string;
  /** Classified LLM error code when the failure originated from `adapter.chat`. */
  errorCode?: LLMErrorCode;
  /** HTTP status code when available. */
  statusCode?: number;
}

/** Perform a basic connection test against a provider */
export async function checkProviderHealth(
  provider: ProviderInstance
): Promise<HealthCheckResult> {
  const start = performance.now();

  // Ollama: health check via /api/tags — uses getTauriFetch to bypass WebView2 CORS on Windows
  if (provider.id === 'ollama' || provider.baseUrl.includes(':11434')) {
    try {
      const fetchFn = await getTauriFetch();
      const resp = await fetchFn(`${provider.baseUrl}/api/tags`);
      return {
        success: resp.ok,
        latencyMs: Math.round(performance.now() - start),
        error: resp.ok ? undefined : `HTTP ${resp.status}`,
      };
    } catch (e) {
      return {
        success: false,
        latencyMs: Math.round(performance.now() - start),
        error: e instanceof Error ? e.message : 'Connection failed',
      };
    }
  }

  // LM Studio: health check via /models — uses getTauriFetch to bypass WebView2 CORS on Windows
  if (provider.id === 'lmstudio' || provider.baseUrl.includes(':1234')) {
    try {
      const fetchFn = await getTauriFetch();
      const resp = await fetchFn(`${provider.baseUrl}/models`);
      return {
        success: resp.ok,
        latencyMs: Math.round(performance.now() - start),
        error: resp.ok ? undefined : `HTTP ${resp.status}`,
      };
    } catch (e) {
      return {
        success: false,
        latencyMs: Math.round(performance.now() - start),
        error: e instanceof Error ? e.message : 'Connection failed',
      };
    }
  }

  // Standard providers: send a minimal chat request (max_tokens=1)
  const testModel = provider.models[0]?.id ?? '';
  if (!testModel) {
    return { success: false, latencyMs: 0, error: 'No model available for testing' };
  }

  try {
    const adapter = provider.apiFormat === 'anthropic'
      ? new ClaudeAdapter()
      : new OpenAICompatibleAdapter();

    await adapter.chat(
      [{ id: '0', role: 'user', content: 'Hi', timestamp: Date.now() }],
      {
        model: testModel,
        apiKey: provider.apiKey,
        baseUrl: provider.baseUrl,
        maxTokens: 1,
        temperature: 0,
      },
      () => {} // ignore stream events
    );

    return { success: true, latencyMs: Math.round(performance.now() - start) };
  } catch (e) {
    const latencyMs = Math.round(performance.now() - start);
    if (e instanceof LLMError) {
      return {
        success: false,
        latencyMs,
        error: e.message,
        errorCode: e.code,
        statusCode: e.statusCode,
      };
    }
    return {
      success: false,
      latencyMs,
      error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    };
  }
}
