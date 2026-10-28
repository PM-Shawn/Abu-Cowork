import { afterEach, describe, expect, it, vi } from 'vitest';
import { subagentRunContext } from './subagentRunContext';
import { resolveEffectiveLlmCreds } from './shims/enterpriseCredsRun';
import { createModelRecoveryPort } from './modelRecovery';
import { buildRunModelBinding } from '@/core/agent/modelRecovery';
import { useSettingsStore } from '@/stores/settingsStore';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('./rpcClient', () => ({ sendRequest: request }));

afterEach(() => request.mockReset());

describe('model recovery transport', () => {
  it('updates credentials only inside the selected run and advances the revision', async () => {
    const settings = useSettingsStore.getState();
    const initial = buildRunModelBinding(settings, settings.activeModel, 0);
    const selected = { ...initial, revision: 1, resolvedCreds: { apiKey: 'new-key', baseUrl: 'https://selected.example/v1', forceOpenAiCompatible: true } };
    request.mockImplementation(async (_method, params) => params.runId === 'one' ? selected : null);
    const firstContext = { runId: 'one', locale: 'en-US', uiStrings: {} as never, resolvedCreds: initial.resolvedCreds };
    const otherContext = { runId: 'two', locale: 'en-US', uiStrings: {} as never, resolvedCreds: initial.resolvedCreds };
    const first = createModelRecoveryPort('one', (binding) => { firstContext.resolvedCreds = binding.resolvedCreds; });
    const other = createModelRecoveryPort('two', (binding) => { otherContext.resolvedCreds = binding.resolvedCreds; });
    await Promise.all([
      subagentRunContext.run(firstContext, async () => {
        await first.waitForSelection('quota');
        expect(resolveEffectiveLlmCreds('ignored', undefined)).toEqual(selected.resolvedCreds);
      }),
      subagentRunContext.run(otherContext, async () => {
        expect(await other.waitForSelection('quota')).toBeNull();
        expect(resolveEffectiveLlmCreds('ignored', undefined)).toEqual(initial.resolvedCreds);
      }),
    ]);
    request.mockResolvedValueOnce({ ...selected, revision: 2 });
    await first.waitForSelection('context-window');
    expect(request).toHaveBeenLastCalledWith('model.recovery.wait', { runId: 'one', expectedRevision: 1, reason: 'context-window' });
  });

  it('rejects an out-of-order response before changing credentials', async () => {
    const settings = useSettingsStore.getState();
    const binding = buildRunModelBinding(settings, settings.activeModel, 3);
    request.mockResolvedValueOnce(binding);
    const apply = vi.fn();
    await expect(createModelRecoveryPort('one', apply).waitForSelection('quota')).rejects.toThrow('Invalid model recovery binding');
    expect(apply).not.toHaveBeenCalled();
  });

  it('refuses credential access outside an active run', () => {
    expect(() => resolveEffectiveLlmCreds('ignored', undefined)).toThrow('outside an active run');
  });
});
