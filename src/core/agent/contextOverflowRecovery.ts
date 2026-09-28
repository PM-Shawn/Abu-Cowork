import type { ProviderInstance } from '@/types/provider';
import type { LLMError } from '../llm/adapter';
import { localServerKind } from '../llm/localProvider';

/** 7.4：先用报错里读出的上限；读不到时，本地服务商按运行开始时的办法再问一次。 */
export async function learnContextWindowAfterOverflow(input: {
  error: LLMError;
  provider: ProviderInstance | undefined;
  modelId: string;
  probe: (provider: ProviderInstance, modelId: string) => Promise<number | undefined>;
}): Promise<number | undefined> {
  if (input.error.contextLimit !== undefined) return input.error.contextLimit;
  if (!input.provider || localServerKind(input.provider) === null) return undefined;
  return input.probe(input.provider, input.modelId);
}
