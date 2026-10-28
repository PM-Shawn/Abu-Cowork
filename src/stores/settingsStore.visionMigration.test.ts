import { describe, expect, it } from 'vitest';
import type { DeclaredCapabilities, ModelInfo, ProviderInstance } from '@/types/provider';
import { resolveModelVision } from '@/core/llm/resolveModelDeclared';
import { useSettingsStore } from './settingsStore';

function providerWith(models: ModelInfo[], declaredCapabilities?: DeclaredCapabilities): ProviderInstance {
  return {
    id: 'custom-models',
    source: 'custom',
    name: 'Custom models',
    enabled: true,
    apiFormat: 'openai-compatible',
    baseUrl: 'https://models.example.test',
    apiKey: '',
    models,
    declaredCapabilities,
    status: 'unchecked',
    sortOrder: 0,
  };
}

async function migrateProvider(provider: ProviderInstance, version = 54): Promise<ProviderInstance> {
  const migrated = await useSettingsStore.persist.getOptions().migrate!({ providers: [provider] }, version);
  return (migrated as { providers: ProviderInstance[] }).providers[0];
}

describe('V55 saved model vision migration', () => {
  it.each([
    ['llama3.2', false],
    ['llama3.2:latest', false],
    ['ollama/llama3.2:3b-instruct-q4_K_M', false],
    ['meta-llama/llama-3.2-3b-instruct', false],
    ['deepseek-flash', true],
    ['deepseek/deepseek-flash', true],
    ['deepseek-v4-flash', true],
    ['deepseek-v4-flash-vision-exp', true],
  ] as const)('corrects %s while retaining its other declared capabilities', async (id, vision) => {
    const other = {
      supportsTools: false,
      supportsReasoning: true,
      maxInputTokens: 128000,
      maxOutputTokens: 12000,
      parallelToolCalls: false,
    };
    const migrated = await migrateProvider(providerWith([
      { id, label: 'Selected model', declaredCapabilities: { ...other, supportsImages: !vision } },
    ]));
    expect(migrated.models[0]).toEqual({
      id,
      label: 'Selected model',
      declaredCapabilities: { ...other, supportsImages: vision },
    });
    expect(resolveModelVision(migrated, id)).toBe(vision);
  });

  it.each([
    ['llama3.2:latest', false],
    ['deepseek-flash', true],
  ] as const)('overrides a legacy provider declaration for %s and preserves the other models', async (id, vision) => {
    const inherited = { supportsImages: !vision, supportsTools: true, useRawUrl: true, maxInputTokens: 65536 };
    const migrated = await migrateProvider(providerWith([
      { id, label: id, declaredCapabilities: { maxOutputTokens: 8000 } },
      { id: 'other-model', label: 'Other model' },
    ], inherited));

    expect(migrated.declaredCapabilities).toEqual(inherited);
    expect(migrated.models[0].declaredCapabilities).toEqual({ maxOutputTokens: 8000, supportsImages: vision });
    expect(migrated.models[1]).toEqual({ id: 'other-model', label: 'Other model' });
    expect(resolveModelVision(migrated, id)).toBe(vision);
    expect(resolveModelVision(migrated, 'other-model')).toBe(!vision);
  });

  it('retains matching declarations and leaves undeclared target models automatic', async () => {
    const provider = providerWith([
      { id: 'llama3.2:latest', label: 'Llama', declaredCapabilities: { supportsImages: false } },
      { id: 'deepseek-flash', label: 'Flash', declaredCapabilities: { supportsTools: true } },
      { id: 'deepseek-v4-flash', label: 'Flash alias', declaredCapabilities: { supportsImages: true } },
    ]);
    const expected = structuredClone(provider);
    expect(await migrateProvider(provider)).toEqual(expected);
  });

  it('preserves a correct model declaration over an opposing provider declaration', async () => {
    const provider = providerWith([
      { id: 'llama3.2:latest', label: 'Llama', declaredCapabilities: { supportsImages: false } },
    ], { supportsImages: true });
    const expected = structuredClone(provider);
    expect(await migrateProvider(provider)).toEqual(expected);
  });

  it('preserves vision Llama variants and unrelated model declarations', async () => {
    const provider = providerWith([
      { id: 'llama3.2-vision:latest', label: 'Vision', declaredCapabilities: { supportsImages: true } },
      { id: 'meta-llama/llama-3.2-11b-vision-instruct', label: '11B', declaredCapabilities: { supportsImages: false } },
      { id: 'meta-llama/llama-3.2-90b-vision-instruct', label: '90B' },
      { id: 'deepseek-v4-pro', label: 'Pro', declaredCapabilities: { supportsImages: false } },
      { id: 'other-model', label: 'Other', declaredCapabilities: { supportsImages: true } },
    ], { supportsImages: false });
    const expected = structuredClone(provider);
    expect(await migrateProvider(provider)).toEqual(expected);
  });

  it('keeps declarations saved after V55', async () => {
    const provider = providerWith([
      { id: 'llama3.2:latest', label: 'Llama', declaredCapabilities: { supportsImages: true } },
      { id: 'deepseek-flash', label: 'Flash', declaredCapabilities: { supportsImages: false } },
    ]);
    const expected = structuredClone(provider);
    expect(await migrateProvider(provider, 55)).toEqual(expected);
  });

  it('accepts an installation without configured providers', async () => {
    const migrated = await useSettingsStore.persist.getOptions().migrate!({}, 54);
    expect(migrated).toEqual({});
  });
});
