import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useSettingsStore } from '@/stores/settingsStore';
import type { ProviderInstance } from '@/types/provider';

vi.mock('@/core/llm/healthCheck', () => ({
  checkProviderHealth: vi.fn(async () => ({ success: true, latencyMs: 12 })),
}));

const getProviderCallHealthMock = vi.fn();
vi.mock('@/core/llm/providerCallHealth', () => ({
  getProviderCallHealth: (...args: unknown[]) => getProviderCallHealthMock(...args),
}));

import { runAIServicesChecks } from './aiServices';

function makeProvider(overrides: Partial<ProviderInstance> = {}): ProviderInstance {
  return {
    id: 'custom-1',
    source: 'custom',
    name: 'Custom Provider',
    enabled: true,
    apiFormat: 'openai-compatible',
    baseUrl: 'https://example.com/v1',
    apiKey: 'sk-test',
    models: [{ id: 'glm-5.2', label: 'GLM 5.2' }],
    status: 'unchecked',
    sortOrder: 0,
    ...overrides,
  };
}

describe('runAIServicesChecks — recent real-call failures', () => {
  beforeEach(() => {
    getProviderCallHealthMock.mockReset();
    useSettingsStore.setState({ providers: [makeProvider()], computerUseEnabled: false });
  });

  it('warns when the active Computer Use model is declared text-only', async () => {
    getProviderCallHealthMock.mockReturnValue(undefined);
    const provider = makeProvider({
      models: [{
        id: 'deepseek-text',
        label: 'DeepSeek Text',
        declaredCapabilities: { supportsTools: true, supportsImages: false },
      }],
    });
    useSettingsStore.setState({
      providers: [provider],
      activeModel: { providerId: provider.id, modelId: 'deepseek-text' },
      computerUseEnabled: true,
    });

    const results = await runAIServicesChecks();
    const support = results.find(row => row.id === 'ai-services:computer-use-model');

    expect(support?.status).toBe('warning');
    expect(support?.metric).toContain('deepseek-text');
  });

  it('classifies the built-in DeepSeek text model as structured-only Computer Use', async () => {
    getProviderCallHealthMock.mockReturnValue(undefined);
    const provider = makeProvider({
      id: 'deepseek',
      source: 'builtin',
      name: 'DeepSeek',
      models: [{ id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' }],
    });
    useSettingsStore.setState({
      providers: [provider],
      activeModel: { providerId: provider.id, modelId: 'deepseek-v4-pro' },
      computerUseEnabled: true,
    });

    const results = await runAIServicesChecks();
    const support = results.find(row => row.id === 'ai-services:computer-use-model');

    expect(support?.status).toBe('warning');
    expect(support?.metric).toContain('deepseek-v4-pro');
    expect(support?.errorMessage).toBeTruthy();
  });

  it('fails closed for an undeclared custom endpoint even when the model id looks familiar', async () => {
    getProviderCallHealthMock.mockReturnValue(undefined);
    const provider = makeProvider({
      models: [{ id: 'gpt-4o', label: 'GPT-4o Proxy' }],
    });
    useSettingsStore.setState({
      providers: [provider],
      activeModel: { providerId: provider.id, modelId: 'gpt-4o' },
      computerUseEnabled: true,
    });

    const results = await runAIServicesChecks();
    const support = results.find(row => row.id === 'ai-services:computer-use-model');

    expect(support?.status).toBe('failed');
    expect(support?.metric).toContain('Not verified');
    expect(support?.errorMessage).toContain('does not declare reliable tool calling');
  });

  it('reports an explicit no-tools declaration as unsupported', async () => {
    getProviderCallHealthMock.mockReturnValue(undefined);
    const provider = makeProvider({
      models: [{
        id: 'text-only-no-tools',
        label: 'Text Only',
        declaredCapabilities: { supportsTools: false, supportsImages: false },
      }],
    });
    useSettingsStore.setState({
      providers: [provider],
      activeModel: { providerId: provider.id, modelId: 'text-only-no-tools' },
      computerUseEnabled: true,
    });

    const results = await runAIServicesChecks();
    const support = results.find(row => row.id === 'ai-services:computer-use-model');

    expect(support?.status).toBe('failed');
    expect(support?.metric).toContain('Unsupported');
  });

  it('downgrades to "warning" when the last recorded real-call outcome is a recent failure', async () => {
    getProviderCallHealthMock.mockReturnValue({ ok: false, code: 'not_found', at: Date.now() });

    const results = await runAIServicesChecks();
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('warning');
    expect(results[0].errorMessage).toContain('not_found');
    // Connectivity metric is preserved even when downgraded to warning.
    expect(results[0].metric).toBe('12ms');
  });

  it('stays "passed" when there is no recorded outcome for this provider', async () => {
    getProviderCallHealthMock.mockReturnValue(undefined);

    const results = await runAIServicesChecks();
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('passed');
    expect(results[0].metric).toBe('12ms');
  });

  it('stays "passed" when the last recorded outcome is a success', async () => {
    getProviderCallHealthMock.mockReturnValue({ ok: true, at: Date.now() });

    const results = await runAIServicesChecks();
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('passed');
  });

  it('stays "passed" when the recorded failure is outside the 30-minute window (self-healing/staleness)', async () => {
    getProviderCallHealthMock.mockReturnValue({ ok: false, code: 'not_found', at: Date.now() - 40 * 60 * 1000 });

    const results = await runAIServicesChecks();
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('passed');
  });
});
