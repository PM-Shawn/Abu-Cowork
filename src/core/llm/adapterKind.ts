import type { ProviderInstance } from '@/types/provider';
import type { AdapterKind } from './adapter';
import type { UsageProtocol } from './usageAccounting';

/**
 * 按服务商类型选适配器。企业网关一律走 OpenAI 兼容；服务商类型为 Ollama 时走
 * 它自己的 /api/chat（OpenAI 兼容接口不接受上下文长度）。
 */
export function adapterKindFor(
  provider: Pick<ProviderInstance, 'id' | 'apiFormat'> | undefined,
  forceOpenAiCompatible: boolean,
): AdapterKind {
  if (forceOpenAiCompatible) return 'openai-compatible';
  if (provider?.id === 'ollama') return 'ollama';
  return provider?.apiFormat === 'openai-compatible' ? 'openai-compatible' : 'claude';
}

/**
 * 适配器上报用量时采用的协议，决定 `TokenUsage.inputTokens` 含不含缓存。
 * Ollama 自己的接口与 OpenAI 兼容协议一样，输入是整段。
 */
export function usageProtocolFor(kind: AdapterKind): UsageProtocol {
  return kind === 'claude' ? 'anthropic' : 'openai-compatible';
}
