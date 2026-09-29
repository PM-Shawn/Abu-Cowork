import type { ProviderInstance } from '@/types/provider';
import type { LLMError } from '../llm/adapter';
import { localServerKind } from '../llm/localProvider';

export interface LearnedContextWindow {
  size: number;
  /** 学到 size 那一刻服务报告的值，随 size 一起记下，供之后判定 size 是否过时 */
  probe: number | undefined;
}

/**
 * 7.4：先用报错里读出的上限（Ollama 转交的 llama-server 报错「request (N tokens) exceeds the
 * available context size (M tokens)」带上限 M，llama.cpp、OpenAI 的句式也带）；读不到时，
 * 本地服务商按运行开始时的办法再问一次。
 * 运行开始时没问到（Ollama 当时还没加载模型）而这次请求已经让它加载了：本地服务商补问一次，
 * 把此刻报告的值随学到的上限记下，用户之后在服务里调大长度时，读取端才能认出学到的值已过时。
 */
export async function learnContextWindowAfterOverflow(input: {
  error: LLMError;
  provider: ProviderInstance | undefined;
  modelId: string;
  /** 本次运行开始时服务报告的值 */
  runProbe: number | undefined;
  probe: (provider: ProviderInstance, modelId: string) => Promise<number | undefined>;
}): Promise<LearnedContextWindow | undefined> {
  const localProvider = input.provider && localServerKind(input.provider) !== null ? input.provider : undefined;
  if (input.error.contextLimit !== undefined) {
    const probe = input.runProbe === undefined && localProvider
      ? await input.probe(localProvider, input.modelId)
      : input.runProbe;
    return { size: input.error.contextLimit, probe };
  }
  if (!localProvider) return undefined;
  // 再问一次得到的就是服务此刻报告的值
  const size = await input.probe(localProvider, input.modelId);
  return size === undefined ? undefined : { size, probe: size };
}
