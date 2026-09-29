import type { ProviderInstance } from '@/types/provider';
import type { LLMError } from '../llm/adapter';
import { localServerKind } from '../llm/localProvider';

export interface LearnedContextWindow {
  size: number;
  /** 学到 size 那一刻服务报告的值，随 size 一起记下，供之后判定 size 是否过时 */
  probe: number | undefined;
}

/** 7.4：先用报错里读出的上限；读不到时，本地服务商按运行开始时的办法再问一次。 */
export async function learnContextWindowAfterOverflow(input: {
  error: LLMError;
  provider: ProviderInstance | undefined;
  modelId: string;
  /** 本次运行开始时服务报告的值 */
  runProbe: number | undefined;
  probe: (provider: ProviderInstance, modelId: string) => Promise<number | undefined>;
}): Promise<LearnedContextWindow | undefined> {
  if (input.error.contextLimit !== undefined) return { size: input.error.contextLimit, probe: input.runProbe };
  if (!input.provider || localServerKind(input.provider) === null) return undefined;
  // 再问一次得到的就是服务此刻报告的值
  const size = await input.probe(input.provider, input.modelId);
  return size === undefined ? undefined : { size, probe: size };
}
