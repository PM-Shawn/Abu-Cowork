import { describe, it, expect, vi } from 'vitest';
import type { ProviderInstance } from '@/types/provider';
import { LLMError } from '../llm/adapter';
import { learnContextWindowAfterOverflow } from './contextOverflowRecovery';

function provider(overrides: Partial<ProviderInstance>): ProviderInstance {
  return {
    id: 'lmstudio', source: 'builtin', name: 'LM Studio', enabled: true, apiFormat: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:1234/v1', apiKey: '', models: [], status: 'verified', sortOrder: 0,
    ...overrides,
  };
}

describe('learnContextWindowAfterOverflow', () => {
  it('uses the limit the error carried without asking the service', async () => {
    const probe = vi.fn();
    await expect(learnContextWindowAfterOverflow({
      error: new LLMError('too long', 'context_too_long', { contextLimit: 8192 }),
      provider: provider({}), modelId: 'm', probe,
    })).resolves.toBe(8192);
    expect(probe).not.toHaveBeenCalled();
  });

  it('asks a local service again when the error named no limit', async () => {
    const lmstudio = provider({});
    const probe = vi.fn().mockResolvedValue(4096);
    await expect(learnContextWindowAfterOverflow({
      error: new LLMError('too long', 'context_too_long'), provider: lmstudio, modelId: 'm', probe,
    })).resolves.toBe(4096);
    expect(probe).toHaveBeenCalledWith(lmstudio, 'm');
  });

  it('learns nothing for a cloud provider whose error named no limit', async () => {
    const probe = vi.fn();
    await expect(learnContextWindowAfterOverflow({
      error: new LLMError('too long', 'context_too_long'),
      provider: provider({ id: 'deepseek', baseUrl: 'https://api.deepseek.com' }), modelId: 'm', probe,
    })).resolves.toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
  });
});
