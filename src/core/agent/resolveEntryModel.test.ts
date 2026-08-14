/**
 * resolveEntryModel.ts — the single pure formula shared by agentLoop.ts's
 * entry, entryOrchestration.ts's precomputeOrchestration, and the shell
 * dispatcher's buildAgentRunParams (P1-3B-3B). Pure, no mocks needed — uses
 * the real settingsSelectors/resolveModelDeclared.
 */
import { describe, it, expect } from 'vitest';
import { resolveEntryModel } from './resolveEntryModel';
import type { SettingsState } from '@/stores/settingsStore';
import type { RouteResult } from './orchestrator';

function makeSettings(overrides: Partial<SettingsState> = {}): SettingsState {
  return {
    activeModel: { providerId: 'p1', modelId: 'model-a' },
    providers: [
      {
        id: 'p1',
        name: 'P1',
        apiFormat: 'anthropic',
        enabled: true,
        apiKey: 'sk-1',
        baseUrl: undefined,
        models: [
          { id: 'model-a', name: 'Model A' },
          { id: 'model-b', name: 'Model B', declaredCapabilities: { supportsTools: false } },
        ],
      },
    ],
    ...overrides,
  } as unknown as SettingsState;
}

function makeRoute(overrides: Partial<RouteResult> = {}): RouteResult {
  return {
    type: 'general',
    name: 'general',
    cleanInput: 'hi',
    ...overrides,
  } as RouteResult;
}

describe('resolveEntryModel', () => {
  it('uses settingsForModel.activeModel.modelId for a general route', () => {
    const settingsForModel = makeSettings({ activeModel: { providerId: 'p1', modelId: 'model-b' } });
    const { effectiveModelId, provider } = resolveEntryModel(makeRoute({ type: 'general' }), settingsForModel);
    expect(effectiveModelId).toBe('model-b');
    expect(provider?.id).toBe('p1');
  });

  it("an 'agent' route with a definition.model offered by the active provider overrides the effective model", () => {
    const settingsForModel = makeSettings({ activeModel: { providerId: 'p1', modelId: 'model-b' } });
    const { effectiveModelId } = resolveEntryModel(
      makeRoute({ type: 'agent', definition: { model: 'model-a' } as never }),
      settingsForModel,
    );
    expect(effectiveModelId).toBe('model-a');
  });

  it("an 'agent' route cannot borrow a model from a different provider", () => {
    const settings = makeSettings({
      activeModel: { providerId: 'p1', modelId: 'model-a' },
      providers: [
        ...makeSettings().providers,
        {
          id: 'p2',
          name: 'P2',
          apiFormat: 'openai-compatible',
          enabled: true,
          apiKey: 'sk-2',
          models: [{ id: 'other-provider-model', name: 'Other Provider Model' }],
        },
      ],
    });

    const { effectiveModelId, provider } = resolveEntryModel(
      makeRoute({ type: 'agent', definition: { model: 'other-provider-model' } as never }),
      settings,
    );

    expect(provider?.id).toBe('p1');
    expect(effectiveModelId).toBe('model-a');
  });

  it("an 'agent' route whose definition.model isn't found in any enabled provider falls back to the global model", () => {
    const settings = makeSettings({ activeModel: { providerId: 'p1', modelId: 'model-a' } });
    const { effectiveModelId } = resolveEntryModel(
      makeRoute({ type: 'agent', definition: { model: 'nonexistent-model' } as never }),
      settings,
    );
    expect(effectiveModelId).toBe('model-a');
  });

  it('derives entryModelDeclared from the resolved (provider, modelId) pair — a model-level declaredCapabilities override wins', () => {
    const settingsForModel = makeSettings({ activeModel: { providerId: 'p1', modelId: 'model-b' } });
    const { entryModelDeclared } = resolveEntryModel(makeRoute(), settingsForModel);
    expect(entryModelDeclared?.supportsTools).toBe(false);
  });

  it('entryModelDeclared is undefined when neither provider nor model declares anything', () => {
    const settings = makeSettings();
    const { entryModelDeclared } = resolveEntryModel(makeRoute(), settings);
    expect(entryModelDeclared).toBeUndefined();
  });

  it('provider is undefined when settingsForModel.activeModel.providerId matches no configured provider', () => {
    const settings = makeSettings({ activeModel: { providerId: 'missing-provider', modelId: 'x' } });
    const { provider, entryModelDeclared } = resolveEntryModel(makeRoute(), settings);
    expect(provider).toBeUndefined();
    expect(entryModelDeclared).toBeUndefined();
  });
});
