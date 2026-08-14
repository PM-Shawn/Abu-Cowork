import { describe, expect, it } from 'vitest';
import type { SettingsState } from '@/stores/settingsStore';
import { resolveAgentModel } from './settingsSelectors';

function makeSettings({
  activeProviderId = 'deepseek',
  activeModelId = 'deepseek-v4-flash',
}: {
  activeProviderId?: string;
  activeModelId?: string;
} = {}): SettingsState {
  return {
    activeModel: { providerId: activeProviderId, modelId: activeModelId },
    providers: [
      {
        id: 'deepseek',
        name: 'DeepSeek',
        source: 'builtin',
        apiFormat: 'openai-compatible',
        enabled: true,
        apiKey: 'deepseek-key',
        models: [
          { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
          { id: 'shared-model', name: 'Shared Model' },
        ],
      },
      {
        id: 'zmodel',
        name: 'ZModel',
        source: 'custom',
        apiFormat: 'openai-compatible',
        enabled: true,
        apiKey: 'zmodel-key',
        models: [
          { id: 'glm-5.2', name: 'GLM 5.2' },
          { id: 'shared-model', name: 'Shared Model' },
        ],
      },
    ],
  } as unknown as SettingsState;
}

describe('resolveAgentModel', () => {
  it('uses an agent override offered by the active provider', () => {
    const settings = makeSettings({ activeModelId: 'deepseek-v4-flash' });

    expect(resolveAgentModel('shared-model', settings)).toBe('shared-model');
  });

  it('does not combine the active provider with an override from another provider', () => {
    const settings = makeSettings();

    expect(resolveAgentModel('glm-5.2', settings)).toBe('deepseek-v4-flash');
  });

  it('inherits the active model for inherit and missing overrides', () => {
    const settings = makeSettings();

    expect(resolveAgentModel('inherit', settings)).toBe('deepseek-v4-flash');
    expect(resolveAgentModel('missing-model', settings)).toBe('deepseek-v4-flash');
  });
});
