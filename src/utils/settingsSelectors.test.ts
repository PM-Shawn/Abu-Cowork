import { describe, expect, it } from 'vitest';
import type { SettingsState } from '@/stores/settingsStore';
import {
  findPersonalFallbackModel,
  getModelDisplayLabel,
  getModelUnavailableReason,
  hasAnyEnabledProvider,
  resolveAgentModel,
} from './settingsSelectors';

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

describe('getModelUnavailableReason', () => {
  const base = makeSettings();
  const deepseek = base.providers[0];

  it('returns null for an enabled provider that still lists the model', () => {
    expect(getModelUnavailableReason(base, { providerId: 'deepseek', modelId: 'deepseek-v4-flash' })).toBeNull();
  });

  it('reports provider-removed when the provider id is gone', () => {
    expect(getModelUnavailableReason(base, { providerId: 'gone', modelId: 'x' })).toBe('provider-removed');
  });

  it('reports provider-removed for a builtin the user deleted (hidden: not userAdded, disabled, no key)', () => {
    const state = { providers: [{ ...deepseek, enabled: false, apiKey: '', userAdded: false }] };
    expect(getModelUnavailableReason(state, { providerId: 'deepseek', modelId: 'deepseek-v4-flash' })).toBe('provider-removed');
  });

  it('reports provider-disabled when the toggle is off but the card is still visible', () => {
    const state = { providers: [{ ...deepseek, enabled: false }] };
    expect(getModelUnavailableReason(state, { providerId: 'deepseek', modelId: 'deepseek-v4-flash' })).toBe('provider-disabled');
  });

  it('reports model-removed when the enabled provider no longer lists the model', () => {
    expect(getModelUnavailableReason(base, { providerId: 'deepseek', modelId: 'retired-model' })).toBe('model-removed');
  });

  describe('managed provider', () => {
    const managed = {
      ...deepseek,
      id: 'org-models',
      source: 'managed' as const,
      userAdded: false,
      models: [{ id: 'org-model', label: 'org-model' }],
    };

    it('is usable like any other provider once it is registered', () => {
      const state = { providers: [{ ...managed, status: 'verified' as const }] };
      expect(getModelUnavailableReason(state, { providerId: 'org-models', modelId: 'org-model' })).toBeNull();
    });

    it('reports model-removed only against a list the owning system confirmed', () => {
      const state = { providers: [{ ...managed, status: 'verified' as const }] };
      expect(getModelUnavailableReason(state, { providerId: 'org-models', modelId: 'revoked' })).toBe('model-removed');
    });

    it.each(['unchecked', 'checking', 'failed'] as const)(
      'does not call a model removed while there is no confirmed list and the pull is %s',
      (status) => {
        const state = { providers: [{ ...managed, status, models: [] }] };
        expect(getModelUnavailableReason(state, { providerId: 'org-models', modelId: 'org-model' })).toBeNull();
      },
    );

    it.each(['checking', 'failed'] as const)(
      'keeps judging by the list on hand while the next pull is %s',
      (status) => {
        const state = { providers: [{ ...managed, status }] };
        expect(getModelUnavailableReason(state, { providerId: 'org-models', modelId: 'org-model' })).toBeNull();
        expect(getModelUnavailableReason(state, { providerId: 'org-models', modelId: 'revoked' })).toBe('model-removed');
      },
    );

    it('reports provider-removed once the owning system withdraws it', () => {
      expect(getModelUnavailableReason({ providers: [] }, { providerId: 'org-models', modelId: 'org-model' })).toBe('provider-removed');
    });
  });
});

describe('hasAnyEnabledProvider', () => {
  it('is false when every provider is off', () => {
    const s = makeSettings();
    expect(hasAnyEnabledProvider({ providers: s.providers.map((p) => ({ ...p, enabled: false })) })).toBe(false);
  });
  it('is true when one provider is on', () => {
    expect(hasAnyEnabledProvider(makeSettings())).toBe(true);
  });
});

describe('findPersonalFallbackModel', () => {
  function own(id: string, modelIds: string[], overrides: Partial<SettingsState['providers'][number]> = {}): SettingsState['providers'][number] {
    return {
      id,
      name: id,
      source: 'custom',
      apiFormat: 'openai-compatible',
      enabled: true,
      apiKey: `key-${id}`,
      baseUrl: `https://${id}.example.net`,
      models: modelIds.map((m) => ({ id: m, label: m })),
      status: 'verified',
      sortOrder: 1,
      userAdded: true,
      ...overrides,
    };
  }
  const managed = own('org-models', ['org-model'], { source: 'managed', userAdded: false });

  it('prefers the recorded model while it is still usable', () => {
    const state = { providers: [managed, own('a', ['a-1']), own('b', ['b-1', 'b-2'])] };
    expect(findPersonalFallbackModel(state, { providerId: 'b', modelId: 'b-2' })).toEqual({ providerId: 'b', modelId: 'b-2' });
  });

  it.each([
    ['its provider is gone', { providerId: 'gone', modelId: 'x' }],
    ['its provider is off', { providerId: 'off', modelId: 'off-1' }],
    ['the model was removed', { providerId: 'a', modelId: 'a-9' }],
    ['it points at the managed provider', { providerId: 'org-models', modelId: 'org-model' }],
    ['nothing was recorded', null],
  ])('takes the first of the user\'s own models when %s', (_n, preferred) => {
    const state = { providers: [managed, own('off', ['off-1'], { enabled: false }), own('a', ['a-1', 'a-2'])] };
    expect(findPersonalFallbackModel(state, preferred)).toEqual({ providerId: 'a', modelId: 'a-1' });
  });

  it('is null when the user owns no usable model', () => {
    const state = { providers: [managed, own('off', ['off-1'], { enabled: false }), own('empty', [])] };
    expect(findPersonalFallbackModel(state, { providerId: 'off', modelId: 'off-1' })).toBeNull();
  });
});

describe('getModelDisplayLabel', () => {
  it('uses the model label when the provider still lists it', () => {
    const s = makeSettings();
    s.providers[0].models[0] = { ...s.providers[0].models[0], label: 'DS Flash' };
    expect(getModelDisplayLabel(s, { providerId: 'deepseek', modelId: 'deepseek-v4-flash' })).toBe('DS Flash');
  });
  it('falls back to the raw model id when the provider is gone', () => {
    expect(getModelDisplayLabel(makeSettings(), { providerId: 'gone', modelId: 'model-a' })).toBe('model-a');
  });
});
