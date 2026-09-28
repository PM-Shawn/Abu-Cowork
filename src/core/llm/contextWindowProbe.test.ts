import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ProviderInstance } from '@/types/provider';

const mockFetch = vi.fn();
vi.mock('./tauriFetch', () => ({
  getTauriFetch: () => Promise.resolve(mockFetch),
}));

import {
  CONTEXT_PROBE_TIMEOUT_MS,
  fetchLlamaCppContextWindows,
  fetchLmStudioContextWindows,
  fetchOllamaContextWindows,
  fetchOllamaTrainingContext,
  ollamaApiRoot,
  probeContextWindow,
} from './contextWindowProbe';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function provider(overrides: Partial<ProviderInstance>): ProviderInstance {
  return {
    id: 'p', source: 'custom', name: 'P', enabled: true, apiFormat: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:8080/v1', apiKey: '', models: [], status: 'verified', sortOrder: 0,
    ...overrides,
  };
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe('ollamaApiRoot', () => {
  it('strips a trailing /v1 and slashes', () => {
    expect(ollamaApiRoot('http://127.0.0.1:11434')).toBe('http://127.0.0.1:11434');
    expect(ollamaApiRoot('http://127.0.0.1:11434/v1/')).toBe('http://127.0.0.1:11434');
  });
});

describe('fetchOllamaTrainingContext', () => {
  it('reads <architecture>.context_length from /api/show', async () => {
    mockFetch.mockResolvedValueOnce(json({ model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 40960 } }));
    await expect(fetchOllamaTrainingContext('http://127.0.0.1:11434', 'qwen3:0.6b')).resolves.toBe(40960);
    expect(mockFetch).toHaveBeenCalledWith('http://127.0.0.1:11434/api/show', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ model: 'qwen3:0.6b' }),
    }));
  });

  it('falls back to any *.context_length key when the architecture is missing', async () => {
    mockFetch.mockResolvedValueOnce(json({ model_info: { 'llama.context_length': 131072 } }));
    await expect(fetchOllamaTrainingContext('http://127.0.0.1:11434', 'llama3.2')).resolves.toBe(131072);
  });

  it('returns undefined when the service does not answer usefully', async () => {
    mockFetch.mockResolvedValueOnce(json({ error: 'model not found' }, 404));
    await expect(fetchOllamaTrainingContext('http://127.0.0.1:11434', 'x')).resolves.toBeUndefined();
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(fetchOllamaTrainingContext('http://127.0.0.1:11434', 'x')).resolves.toBeUndefined();
  });
});

describe('fetchOllamaContextWindows', () => {
  it('caps every model at 32768', async () => {
    mockFetch
      .mockResolvedValueOnce(json({ model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 40960 } }))
      .mockResolvedValueOnce(json({ model_info: { 'general.architecture': 'llama', 'llama.context_length': 4096 } }));
    const windows = await fetchOllamaContextWindows('http://127.0.0.1:11434', ['qwen3:0.6b', 'tiny']);
    expect(windows).toEqual(new Map([['qwen3:0.6b', 32768], ['tiny', 4096]]));
  });
});

describe('fetchLmStudioContextWindows', () => {
  it('prefers the loaded length, then the maximum', async () => {
    mockFetch.mockResolvedValueOnce(json({
      data: [
        { id: 'qwen/qwen3-8b', loaded_context_length: 8192, max_context_length: 40960 },
        { id: 'google/gemma-3-4b', max_context_length: 131072 },
        { id: 'broken' },
      ],
    }));
    const windows = await fetchLmStudioContextWindows('http://127.0.0.1:1234/v1');
    expect(mockFetch).toHaveBeenCalledWith('http://127.0.0.1:1234/api/v0/models', expect.anything());
    expect(windows).toEqual(new Map([['qwen/qwen3-8b', 8192], ['google/gemma-3-4b', 131072]]));
  });
});

describe('fetchLlamaCppContextWindows', () => {
  it('reads data[].meta.n_ctx from /v1/models', async () => {
    mockFetch.mockResolvedValueOnce(json({ data: [{ id: 'qwen3-8b-q4', meta: { n_ctx: 8192, n_ctx_train: 40960 } }] }));
    const windows = await fetchLlamaCppContextWindows('http://127.0.0.1:8080/v1', 'k');
    expect(mockFetch).toHaveBeenCalledWith('http://127.0.0.1:8080/v1/models', expect.objectContaining({
      headers: { Authorization: 'Bearer k' },
    }));
    expect(windows).toEqual(new Map([['qwen3-8b-q4', 8192]]));
  });
});

describe('probeContextWindow', () => {
  it('asks LM Studio for the loaded length of this model', async () => {
    mockFetch.mockResolvedValueOnce(json({ data: [{ id: 'qwen/qwen3-8b', loaded_context_length: 8192 }] }));
    await expect(probeContextWindow(provider({ id: 'lmstudio', source: 'builtin', baseUrl: 'http://127.0.0.1:1234/v1' }), 'qwen/qwen3-8b'))
      .resolves.toBe(8192);
  });

  it('uses the single model a llama.cpp server lists even when the id differs', async () => {
    mockFetch.mockResolvedValueOnce(json({ data: [{ id: '/models/qwen3-8b-q4.gguf', meta: { n_ctx: 8192 } }] }));
    await expect(probeContextWindow(provider({}), 'qwen3-8b')).resolves.toBe(8192);
  });

  it('decides the Ollama window as min(training length, 32768)', async () => {
    mockFetch.mockResolvedValueOnce(json({ model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 40960 } }));
    await expect(probeContextWindow(provider({ id: 'ollama', source: 'builtin', baseUrl: 'http://127.0.0.1:11434' }), 'qwen3:0.6b'))
      .resolves.toBe(32768);
  });

  it('does not touch the network for a cloud provider', async () => {
    await expect(probeContextWindow(provider({ id: 'deepseek', source: 'builtin', baseUrl: 'https://api.deepseek.com' }), 'deepseek-chat'))
      .resolves.toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  describe('timeout', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('gives up silently after 2 seconds', async () => {
      mockFetch.mockImplementation((_url: string, init?: { signal?: AbortSignal }) => new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }));
      const pending = probeContextWindow(provider({}), 'm');
      await vi.advanceTimersByTimeAsync(CONTEXT_PROBE_TIMEOUT_MS);
      await expect(pending).resolves.toBeUndefined();
    });
  });
});
