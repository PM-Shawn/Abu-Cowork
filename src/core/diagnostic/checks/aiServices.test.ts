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
    useSettingsStore.setState({ providers: [makeProvider()] });
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
