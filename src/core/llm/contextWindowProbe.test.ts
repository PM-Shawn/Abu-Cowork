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
  fetchOllamaLoadedContextWindows,
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

/** /api/ps 里的一条已加载模型，字段按 Ollama api/types.go 的 ProcessModelResponse 写。 */
function loaded(name: string, contextLength: number): Record<string, unknown> {
  return {
    name, model: name, size: 7_500_000_000, digest: 'a80c4f17acd5', details: { family: 'llama' },
    expires_at: '2026-09-29T16:10:00Z', size_vram: 4_821_616_640, context_length: contextLength,
  };
}

describe('fetchOllamaLoadedContextWindows', () => {
  it('reads the context_length of the loaded models from GET /api/ps', async () => {
    mockFetch.mockResolvedValueOnce(json({ models: [loaded('qwen3:0.6b', 4096)] }));
    const windows = await fetchOllamaLoadedContextWindows('http://127.0.0.1:11434/v1', ['qwen3:0.6b', 'llama3.2:latest']);
    expect(windows).toEqual(new Map([['qwen3:0.6b', 4096]]));
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:11434/api/ps');
    expect(init.method).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  it('matches a model written without a tag to its :latest entry', async () => {
    mockFetch.mockResolvedValueOnce(json({ models: [loaded('llama3.2:latest', 32768), loaded('qwen3:0.6b', 4096)] }));
    const windows = await fetchOllamaLoadedContextWindows('http://127.0.0.1:11434', ['llama3.2', 'qwen3:0.6b', 'qwen3']);
    expect(windows).toEqual(new Map([['llama3.2', 32768], ['qwen3:0.6b', 4096]]));
  });

  it('answers nothing for models that are not loaded', async () => {
    mockFetch.mockResolvedValueOnce(json({ models: [] }));
    await expect(fetchOllamaLoadedContextWindows('http://127.0.0.1:11434', ['llama3.2'])).resolves.toEqual(new Map());
  });

  it('ignores an entry whose context_length is not a positive integer', async () => {
    mockFetch.mockResolvedValueOnce(json({ models: [{ ...loaded('llama3.2:latest', 0) }, { name: 'broken' }] }));
    await expect(fetchOllamaLoadedContextWindows('http://127.0.0.1:11434', ['llama3.2', 'broken'])).resolves.toEqual(new Map());
  });

  it('answers nothing when the service does not answer usefully', async () => {
    mockFetch.mockResolvedValueOnce(json({ error: 'not found' }, 404));
    await expect(fetchOllamaLoadedContextWindows('http://127.0.0.1:11434', ['x'])).resolves.toEqual(new Map());
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(fetchOllamaLoadedContextWindows('http://127.0.0.1:11434', ['x'])).resolves.toEqual(new Map());
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

  it('takes the length Ollama actually loaded the model with, without capping it', async () => {
    mockFetch.mockResolvedValueOnce(json({ models: [loaded('qwen3:0.6b', 131072)] }));
    await expect(probeContextWindow(provider({ id: 'ollama', source: 'builtin', baseUrl: 'http://127.0.0.1:11434' }), 'qwen3:0.6b'))
      .resolves.toBe(131072);
  });

  it('answers nothing for an Ollama model that is not loaded yet', async () => {
    mockFetch.mockResolvedValueOnce(json({ models: [loaded('other:latest', 8192)] }));
    await expect(probeContextWindow(provider({ id: 'ollama', source: 'builtin', baseUrl: 'http://127.0.0.1:11434' }), 'qwen3:0.6b'))
      .resolves.toBeUndefined();
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
