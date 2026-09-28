import { describe, it, expect, afterEach } from 'vitest';
import type { SettingsState } from '@/stores/settingsStore';
import type { ProviderInstance } from '@/types/provider';
import { createInProcessCapsPort, setCapsPort, type CapsPort } from './ports/capsPort';
import { contextWindowForModel } from './modelContextWindow';

function settingsWith(model: ProviderInstance['models'][number]): SettingsState {
  const provider: ProviderInstance = {
    id: 'ollama', source: 'builtin', name: 'Ollama', enabled: true, apiFormat: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:11434', apiKey: '', models: [model], status: 'verified', sortOrder: 0,
  };
  return {
    providers: [provider],
    activeModel: { providerId: 'ollama', modelId: model.id },
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

afterEach(() => {
  setCapsPort(createInProcessCapsPort());
});

describe('contextWindowForModel', () => {
  it('uses the window noted when the models were fetched', () => {
    setCapsPort(capsWith(undefined));
    expect(contextWindowForModel(settingsWith({ id: 'qwen3:0.6b', label: 'q', contextWindow: 16384 }), 'qwen3:0.6b')).toBe(16384);
  });

  it('prefers what this run asked the service', () => {
    setCapsPort(capsWith(undefined));
    expect(contextWindowForModel(settingsWith({ id: 'qwen3:0.6b', label: 'q', contextWindow: 16384 }), 'qwen3:0.6b', 8192)).toBe(8192);
  });

  it('takes the smaller of the reported and the learned value', () => {
    setCapsPort(capsWith(2048));
    expect(contextWindowForModel(settingsWith({ id: 'qwen3:0.6b', label: 'q', contextWindow: 16384 }), 'qwen3:0.6b')).toBe(2048);
  });

  it('drops a learned value once the service reports a different window than when it was learned', () => {
    setCapsPort(capsWith(2048, 4096));
    expect(contextWindowForModel(settingsWith({ id: 'qwen3:0.6b', label: 'q', contextWindow: 16384 }), 'qwen3:0.6b')).toBe(16384);
  });

  it('lets the user\'s context length win', () => {
    setCapsPort(capsWith(2048));
    expect(contextWindowForModel(
      settingsWith({ id: 'qwen3:0.6b', label: 'q', contextWindow: 16384, declaredCapabilities: { maxInputTokens: 4096 } }),
      'qwen3:0.6b',
    )).toBe(4096);
  });

  it('caps a name-based estimate for a local server', () => {
    setCapsPort(capsWith(undefined));
    expect(contextWindowForModel(settingsWith({ id: 'qwen3:0.6b', label: 'q' }), 'qwen3:0.6b')).toBe(32768);
  });
});
