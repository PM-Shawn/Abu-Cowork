import type { ProviderInstance } from '@/types/provider';
import type { AdapterKind } from './adapter';

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
