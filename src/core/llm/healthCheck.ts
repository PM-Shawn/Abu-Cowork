import type { ProviderInstance } from '@/types/provider';
import { ClaudeAdapter } from './claude';
import { OpenAICompatibleAdapter } from './openai-compatible';
import { LLMError, type LLMErrorCode } from './adapter';
import { getTauriFetch } from './tauriFetch';
import { redactFailureText } from '@/core/diagnostic/scrub';

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

const FAILURE_TEXT_MAX_CHARS = 500;

/**
 * 失败文字来自服务端响应正文或网络异常，可能带有请求里的 key、Authorization
 * 请求头或带凭证的 URL。这段文字会写入 settingsStore、显示在界面上并进入
 * 诊断包，所以在这里统一脱敏并限制长度。
 */
export function safeFailureText(raw: string, provider: Pick<ProviderInstance, 'apiKey' | 'baseUrl'>): string {
  // 地址带账号密码时，fetch 的异常会原样引用这个地址；密码里可以有 / ? # @ 和空格，
  // 没有固定形状，所以按填写的原文整段替换
  const baseUrl = provider.baseUrl.trim().replace(/\/+$/, '');
  const exactSecrets = baseUrl.includes('@') ? [provider.apiKey, baseUrl] : [provider.apiKey];
  return redactFailureText(raw, exactSecrets).slice(0, FAILURE_TEXT_MAX_CHARS);
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
        error: e instanceof Error ? safeFailureText(e.message, provider) : 'Connection failed',
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
        error: e instanceof Error ? safeFailureText(e.message, provider) : 'Connection failed',
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
        // 自检也是一次真实的模型请求，同样记账。用户看到的请求数里包含它，
        // 这正是"我什么都没做，怎么多了一次"需要能解释清楚的部分。
        accounting: {
          source: 'diagnostic' as const,
          conversationId: null,
          skill: null,
          providerInstanceId: provider.id,
        },
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
        error: safeFailureText(e.message, provider),
        errorCode: e.code,
        statusCode: e.statusCode,
      };
    }
    return {
      success: false,
      latencyMs,
      error: safeFailureText(e instanceof Error ? `${e.name}: ${e.message}` : String(e), provider),
    };
  }
}
