import { describe, it, expect, vi } from 'vitest';
import type { ProviderInstance } from '@/types/provider';
import { LLMError, classifyError } from '../llm/adapter';
import { resolveContextWindow } from '../llm/contextWindow';
import { learnContextWindowAfterOverflow } from './contextOverflowRecovery';

function provider(overrides: Partial<ProviderInstance>): ProviderInstance {
  return {
    id: 'lmstudio', source: 'builtin', name: 'LM Studio', enabled: true, apiFormat: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:1234/v1', apiKey: '', models: [], status: 'verified', sortOrder: 0,
    ...overrides,
  };
}

const ollama = provider({ id: 'ollama', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434' });
const cloud = provider({ id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com' });

/** truncate:false 下 Ollama 原样转交 llama-server 的报错：JSON 文本包在 {"error": …} 里。 */
function ollamaOverflowError(): LLMError {
  const llamaBody = JSON.stringify({
    error: {
      code: 400,
      message: 'request (9000 tokens) exceeds the available context size (4096 tokens), try increasing it',
      type: 'exceed_context_size_error',
      n_prompt_tokens: 9000,
      n_ctx: 4096,
    },
  });
  return classifyError(400, JSON.stringify({ error: llamaBody }));
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

  it('keeps the run-start value empty for a cloud provider whose error carried the limit', async () => {
    const probe = vi.fn();
    await expect(learnContextWindowAfterOverflow({
      error: new LLMError('too long', 'context_too_long', { contextLimit: 8192 }),
      provider: cloud, modelId: 'm', runProbe: undefined, probe,
    })).resolves.toEqual({ size: 8192, probe: undefined });
    expect(probe).not.toHaveBeenCalled();
  });

  it('reads the limit from the Ollama overflow error and, when the run started with the model unloaded, asks /api/ps once more for what was loaded', async () => {
    const error = ollamaOverflowError();
    expect(error).toMatchObject({ code: 'context_too_long', contextLimit: 4096 });
    const probe = vi.fn().mockResolvedValue(4096);
    const learned = await learnContextWindowAfterOverflow({
      error, provider: ollama, modelId: 'llama3.2:latest', runProbe: undefined, probe,
    });
    expect(learned).toEqual({ size: 4096, probe: 4096 });
    expect(probe).toHaveBeenCalledWith(ollama, 'llama3.2:latest');

    // 用户之后在 Ollama 里把长度调到 32768：下一次运行 /api/ps 报 32768，学到的 4096 作废
    expect(resolveContextWindow({
      modelId: 'llama3.2:latest', probed: 32768,
      discovered: learned?.size, discoveredProbe: learned?.probe, isLocal: true,
    }).size).toBe(32768);
    // 没有调整时，下一次运行仍按学到的值
    expect(resolveContextWindow({
      modelId: 'llama3.2:latest', probed: 4096,
      discovered: learned?.size, discoveredProbe: learned?.probe, isLocal: true,
    }).size).toBe(4096);
  });

  it('keeps the limit the error carried even when the extra question gets no answer', async () => {
    await expect(learnContextWindowAfterOverflow({
      error: ollamaOverflowError(), provider: ollama, modelId: 'llama3.2:latest', runProbe: undefined,
      probe: vi.fn().mockResolvedValue(undefined),
    })).resolves.toEqual({ size: 4096, probe: undefined });
  });

  it('asks a local service again when the error named no limit, and notes that answer as what the service reported', async () => {
    const lmstudio = provider({});
    const probe = vi.fn().mockResolvedValue(4096);
    await expect(learnContextWindowAfterOverflow({
      error: new LLMError('too long', 'context_too_long'), provider: lmstudio, modelId: 'm', runProbe: undefined, probe,
    })).resolves.toEqual({ size: 4096, probe: 4096 });
    expect(probe).toHaveBeenCalledWith(lmstudio, 'm');
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
      error: new LLMError('too long', 'context_too_long'), provider: cloud, modelId: 'm', runProbe: undefined, probe,
    })).resolves.toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
  });
});
