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
  it('uses the limit the error carried without asking the service, noting what the run was told at its start', async () => {
    const probe = vi.fn();
    await expect(learnContextWindowAfterOverflow({
      error: new LLMError('too long', 'context_too_long', { contextLimit: 8192 }),
      provider: provider({}), modelId: 'm', runProbe: 32768, probe,
    })).resolves.toEqual({ size: 8192, probe: 32768 });
    expect(probe).not.toHaveBeenCalled();
  });

  it('keeps the run-start value empty when the run was told nothing', async () => {
    await expect(learnContextWindowAfterOverflow({
      error: new LLMError('too long', 'context_too_long', { contextLimit: 8192 }),
      provider: provider({}), modelId: 'm', runProbe: undefined, probe: vi.fn(),
    })).resolves.toEqual({ size: 8192, probe: undefined });
  });

  it('asks a local service again when the error named no limit, and notes that answer as what the service reported', async () => {
    const lmstudio = provider({});
    const probe = vi.fn().mockResolvedValue(4096);
    await expect(learnContextWindowAfterOverflow({
      error: new LLMError('too long', 'context_too_long'), provider: lmstudio, modelId: 'm', runProbe: undefined, probe,
    })).resolves.toEqual({ size: 4096, probe: 4096 });
    expect(probe).toHaveBeenCalledWith(lmstudio, 'm');
  });

  it('asks Ollama again after its overflow error, which names no limit, and takes the length it loaded the model with', async () => {
    const ollama = provider({ id: 'ollama', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434' });
    const probe = vi.fn().mockResolvedValue(4096);
    await expect(learnContextWindowAfterOverflow({
      error: new LLMError('the prompt is longer than the context length currently available to the model', 'context_too_long'),
      provider: ollama, modelId: 'llama3.2:latest', runProbe: undefined, probe,
    })).resolves.toEqual({ size: 4096, probe: 4096 });
    expect(probe).toHaveBeenCalledWith(ollama, 'llama3.2:latest');
  });

  it('learns nothing when asking again gets no answer', async () => {
    await expect(learnContextWindowAfterOverflow({
      error: new LLMError('too long', 'context_too_long'), provider: provider({}), modelId: 'm', runProbe: 32768,
      probe: vi.fn().mockResolvedValue(undefined),
    })).resolves.toBeUndefined();
  });

  it('learns nothing for a cloud provider whose error named no limit', async () => {
    const probe = vi.fn();
    await expect(learnContextWindowAfterOverflow({
      error: new LLMError('too long', 'context_too_long'),
      provider: provider({ id: 'deepseek', baseUrl: 'https://api.deepseek.com' }), modelId: 'm', runProbe: undefined, probe,
    })).resolves.toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
  });
});
