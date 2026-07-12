import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useSettingsStore } from '@/stores/settingsStore';
import type { ProviderInstance } from '@/types/provider';
// Real providerCallHealth module (NOT mocked) — this test verifies the actual
// record→read wiring between what the agent loop records and what the diagnostic
// reads, which the unit test in aiServices.test.ts stubs out. Only the network
// probe is mocked (always "reachable"), so the pass/warning outcome is driven
// solely by the real recorded provider-call health.
import { recordProviderCallOutcome, __resetProviderCallHealth } from '@/core/llm/providerCallHealth';

vi.mock('@/core/llm/healthCheck', () => ({
  checkProviderHealth: vi.fn(async () => ({ success: true, latencyMs: 12 })),
}));

import { runAIServicesChecks } from './aiServices';

function makeProvider(overrides: Partial<ProviderInstance> = {}): ProviderInstance {
  return {
    id: 'custom-1',
    source: 'custom',
    name: 'Custom Provider',
    enabled: true,
    apiFormat: 'openai-compatible',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
    apiKey: 'sk-test',
    models: [{ id: 'glm-5.2', label: 'GLM 5.2' }],
    status: 'unchecked',
    sortOrder: 0,
    ...overrides,
  };
}

describe('AI-services diagnostic ↔ providerCallHealth (real module integration)', () => {
  beforeEach(() => {
    __resetProviderCallHealth();
    useSettingsStore.setState({ providers: [makeProvider()] });
  });

  it('a recorded real-call failure (the reported 404 scenario) downgrades the passing probe to "warning"', async () => {
    // Mirrors what agentLoop's catch does on a not_found LLMError.
    recordProviderCallOutcome('custom-1', { ok: false, code: 'not_found', at: Date.now() });

    const results = await runAIServicesChecks();
    expect(results[0].status).toBe('warning');
    expect(results[0].errorMessage).toContain('not_found');
    expect(results[0].metric).toBe('12ms'); // connectivity latency preserved
  });

  it('a later success overwrites the failure and the row goes back to "passed" (self-heal)', async () => {
    recordProviderCallOutcome('custom-1', { ok: false, code: 'not_found', at: Date.now() });
    recordProviderCallOutcome('custom-1', { ok: true, at: Date.now() }); // successful retry

    const results = await runAIServicesChecks();
    expect(results[0].status).toBe('passed');
  });

  it('a stale failure (>30 min) no longer warns', async () => {
    recordProviderCallOutcome('custom-1', { ok: false, code: 'not_found', at: Date.now() - 31 * 60 * 1000 });

    const results = await runAIServicesChecks();
    expect(results[0].status).toBe('passed');
  });

  it('a failure recorded for a different provider does not leak into this one', async () => {
    recordProviderCallOutcome('some-other-provider', { ok: false, code: 'not_found', at: Date.now() });

    const results = await runAIServicesChecks();
    expect(results[0].status).toBe('passed');
  });
});
