import type { ProviderInstance } from '@/types/provider';
import { ClaudeAdapter } from './claude';
import { OpenAICompatibleAdapter } from './openai-compatible';
import { LLMError, type LLMErrorCode } from './adapter';
import { getTauriFetch } from './tauriFetch';
import { redactStringValue } from '@/core/diagnostic/scrub';

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
/** 进入脱敏的文字上限：服务端响应正文没有长度限制 */
const FAILURE_TEXT_SCAN_CHARS = 4000;
/** 短于这个长度的 key（本机服务常填的 ollama、none 这类占位值）不做原文替换，避免把普通文字替换掉 */
const MIN_KEY_ERASE_LENGTH = 8;
const REDACTED = '[REDACTED]';
// 参数名两侧的长度有上限，匹配耗时与文字长度成线性关系
const SECRET_QUERY_PARAM_PATTERN =
  /([?&](?:[\w.-]{0,40}(?:key|token|secret|signature|password|auth)[\w.-]{0,40}|sig)=)[^&#\s"'<>]+/gi;
/** 带 u 标志时只匹配不成对的 surrogate；encodeURIComponent 遇到它会抛出 URIError */
const LONE_SURROGATE_PATTERN = /[\uD800-\uDFFF]/u;

/** key 在响应正文里可能出现的几种写法：原文、JSON 转义、URL 编码（十六进制大小写两种） */
function keyForms(key: string): string[] {
  const forms = [key, JSON.stringify(key).slice(1, -1)];
  if (!LONE_SURROGATE_PATTERN.test(key)) {
    const encoded = encodeURIComponent(key);
    forms.push(encoded, encoded.replace(/%[0-9A-F]{2}/g, (hex) => hex.toLowerCase()));
  }
  return forms;
}

/**
 * 失败文字来自服务端响应正文或网络异常，可能带有请求里的 key、Authorization
 * 请求头或带 key 的 URL。这段文字会写入 settingsStore、显示在界面上并进入
 * 诊断包，所以在这里统一脱敏并限制长度。
 */
function safeFailureText(raw: string, provider: ProviderInstance): string {
  let text = raw.slice(0, FAILURE_TEXT_SCAN_CHARS);
  const key = provider.apiKey.trim();
  if (key.length >= MIN_KEY_ERASE_LENGTH) {
    for (const form of keyForms(key)) text = text.split(form).join(REDACTED);
  }
  text = text.replace(SECRET_QUERY_PARAM_PATTERN, `$1${REDACTED}`);
  return redactStringValue(text).slice(0, FAILURE_TEXT_MAX_CHARS);
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
