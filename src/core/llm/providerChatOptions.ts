import type { ProviderInstance } from '@/types/provider';
import type { ChatOptions } from './adapter';
import { positiveInteger } from './contextWindow';
import { localServerKind } from './localProvider';
import { resolveModelDeclared } from './resolveModelDeclared';

/**
 * 请求选项里随服务商与模型而定的两项，主循环之外的入口（技能辅助调用、记忆提取、
 * 手动整理）用它取值；主循环与子代理用手头已经算好的 declared 与 provider 取同样两项。
 * - localServer：本地服务首次回答前最多等 10 分钟，超时不重试。
 * - requestedContextLength：用户在「上下文长度」里填的值，只有 Ollama 按它运行。
 */
export function providerChatOptions(
  provider: ProviderInstance | undefined,
  modelId: string,
): Pick<ChatOptions, 'localServer' | 'requestedContextLength'> {
  return {
    localServer: localServerKind(provider) !== null,
    requestedContextLength: positiveInteger(resolveModelDeclared(provider, modelId)?.maxInputTokens),
  };
}
