import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { SettingsState } from '@/stores/settingsStore';
import type { ProviderInstance } from '@/types/provider';
import { createInProcessCapsPort, setCapsPort, type CapsPort } from './ports/capsPort';
import {
  __resetProbedContextWindowsForTests,
  contextWindowForModel,
  rememberProbedContextWindow,
} from './modelContextWindow';

const { mockProbeContextWindow } = vi.hoisted(() => ({ mockProbeContextWindow: vi.fn() }));
vi.mock('../llm/contextWindowProbe', () => ({ probeContextWindow: mockProbeContextWindow }));

function settingsWith(model: ProviderInstance['models'][number], overrides: Partial<ProviderInstance> = {}): SettingsState {
  const provider: ProviderInstance = {
    id: 'ollama', source: 'builtin', name: 'Ollama', enabled: true, apiFormat: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:11434', apiKey: '', models: [model], status: 'verified', sortOrder: 0,
    ...overrides,
  };
  return {
    providers: [provider],
    activeModel: { providerId: provider.id, modelId: model.id },
    contextWindowSize: 200000,
  } as unknown as SettingsState;
}

function capsWith(contextWindow: number | undefined, contextWindowProbe?: number): CapsPort {
  return {
    ...createInProcessCapsPort(),
    get: () => (contextWindow === undefined
      ? undefined
      : { contextWindow, contextWindowProbe, source: 'error-derived', updatedAt: 0 }),
  };
}

beforeEach(() => {
  __resetProbedContextWindowsForTests();
  mockProbeContextWindow.mockReset();
  mockProbeContextWindow.mockResolvedValue(undefined);
});

afterEach(() => {
  setCapsPort(createInProcessCapsPort());
});

describe('contextWindowForModel', () => {
  it('uses the window noted when the models were fetched', async () => {
    setCapsPort(capsWith(undefined));
    await expect(contextWindowForModel(settingsWith({ id: 'qwen3:0.6b', label: 'q', contextWindow: 16384 }), 'qwen3:0.6b')).resolves.toBe(16384);
    expect(mockProbeContextWindow).not.toHaveBeenCalled();
  });

  it('prefers what the latest run asked the service', async () => {
    setCapsPort(capsWith(undefined));
    rememberProbedContextWindow('ollama', 'qwen3:0.6b', 8192);
    await expect(contextWindowForModel(settingsWith({ id: 'qwen3:0.6b', label: 'q', contextWindow: 16384 }), 'qwen3:0.6b')).resolves.toBe(8192);
    expect(mockProbeContextWindow).not.toHaveBeenCalled();
  });

  it('falls back to the saved window when the latest run could not reach the service, like the run did', async () => {
    setCapsPort(capsWith(undefined));
    rememberProbedContextWindow('ollama', 'qwen3:0.6b', undefined);
    mockProbeContextWindow.mockResolvedValue(8192);
    await expect(contextWindowForModel(settingsWith({ id: 'qwen3:0.6b', label: 'q', contextWindow: 16384 }), 'qwen3:0.6b')).resolves.toBe(16384);
    expect(mockProbeContextWindow).not.toHaveBeenCalled();
  });

  it('asks a local service once when nothing is known yet, then reuses the answer', async () => {
    setCapsPort(capsWith(undefined));
    mockProbeContextWindow.mockResolvedValue(8192);
    const settings = settingsWith({ id: 'gemma2', label: 'gemma2' });
    await expect(contextWindowForModel(settings, 'gemma2')).resolves.toBe(8192);
    await expect(contextWindowForModel(settings, 'gemma2')).resolves.toBe(8192);
    expect(mockProbeContextWindow).toHaveBeenCalledOnce();
    expect(mockProbeContextWindow).toHaveBeenCalledWith(expect.objectContaining({ id: 'ollama' }), 'gemma2');
  });

  it('keeps each provider and model apart', async () => {
    setCapsPort(capsWith(undefined));
    rememberProbedContextWindow('ollama', 'other-model', 4096);
    rememberProbedContextWindow('lmstudio', 'gemma2', 4096);
    mockProbeContextWindow.mockResolvedValue(8192);
    await expect(contextWindowForModel(settingsWith({ id: 'gemma2', label: 'gemma2' }), 'gemma2')).resolves.toBe(8192);
  });

  it('does not ask a cloud provider', async () => {
    setCapsPort(capsWith(undefined));
    const settings = settingsWith(
      { id: 'deepseek-chat', label: 'deepseek-chat' },
      { id: 'deepseek', baseUrl: 'https://api.deepseek.com' },
    );
    await contextWindowForModel(settings, 'deepseek-chat');
    expect(mockProbeContextWindow).not.toHaveBeenCalled();
  });

  it('takes the smaller of the reported and the learned value', async () => {
    setCapsPort(capsWith(2048));
    await expect(contextWindowForModel(settingsWith({ id: 'qwen3:0.6b', label: 'q', contextWindow: 16384 }), 'qwen3:0.6b')).resolves.toBe(2048);
  });

  it('drops a learned value once the service reports a different window than when it was learned', async () => {
    setCapsPort(capsWith(2048, 4096));
    await expect(contextWindowForModel(settingsWith({ id: 'qwen3:0.6b', label: 'q', contextWindow: 16384 }), 'qwen3:0.6b')).resolves.toBe(16384);
  });

  it('lets the user\'s context length win without asking', async () => {
    setCapsPort(capsWith(2048));
    await expect(contextWindowForModel(
      settingsWith({ id: 'qwen3:0.6b', label: 'q', declaredCapabilities: { maxInputTokens: 4096 } }),
      'qwen3:0.6b',
    )).resolves.toBe(4096);
    expect(mockProbeContextWindow).not.toHaveBeenCalled();
  });

  it('caps a name-based estimate for a local server the service could not answer for', async () => {
    setCapsPort(capsWith(undefined));
    await expect(contextWindowForModel(settingsWith({ id: 'qwen3:0.6b', label: 'q' }), 'qwen3:0.6b')).resolves.toBe(32768);
    expect(mockProbeContextWindow).toHaveBeenCalledOnce();
  });
});
