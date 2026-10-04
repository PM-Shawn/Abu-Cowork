import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '../stores/settingsStore';
import { getSettingsReader, type SettingsReader } from '../core/agent/ports/settingsReader';
import type { ProviderInstance } from '../types/provider';
import type { SubagentDefinition } from '../types';

// A provider removed or turned off while a parent run is in flight must never
// be called by that run's later background work, even though the run itself
// keeps its entry snapshot (agentLoop's `entrySettingsReader`). Real settings
// store actions, real subagent routing and loop; only the model transport and
// memory-file scan are substituted.

const state = vi.hoisted(() => ({
  adapterCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock('../core/llm/selectChatAdapter', () => ({
  selectChatAdapter: () => ({
    chat: async (_messages: unknown, options: Record<string, unknown>, onEvent: (event: Record<string, unknown>) => void) => {
      state.adapterCalls.push(options);
      onEvent({ type: 'text', text: 'child complete' });
      onEvent({ type: 'done', stopReason: 'end_turn' });
    },
  }),
}));

vi.mock('../core/sidecar/sidecarManager', () => ({
  getSidecarStatus: () => 'stopped',
  request: vi.fn(),
  notifySidecar: vi.fn(),
  onSidecarRequest: vi.fn(),
  onSidecarNotification: vi.fn(),
  SidecarRequestError: class SidecarRequestError extends Error {},
}));

vi.mock('../core/memdir/scan', () => ({
  scanMemoryFiles: async () => [],
  loadMemoryIndex: async () => '',
}));

const agent: SubagentDefinition = {
  name: 'researcher',
  description: 'test',
  systemPrompt: 'test',
  filePath: '__preset__',
};

function makeProvider(id: string): ProviderInstance {
  return {
    id,
    source: 'custom',
    name: id,
    enabled: true,
    apiFormat: 'openai-compatible',
    baseUrl: `https://${id}.example/v1`,
    apiKey: `${id}-key`,
    models: [{ id: `${id}-model`, label: `${id} model` }],
    status: 'unchecked',
    sortOrder: 0,
    userAdded: true,
  };
}

/** What agentLoop hands its delegates: the settings as they were when the parent run started. */
function startParentRun(): SettingsReader {
  useSettingsStore.setState({
    providers: [makeProvider('acme'), makeProvider('other')],
    activeModel: { providerId: 'acme', modelId: 'acme-model' },
  });
  const entry = getSettingsReader().getSnapshot();
  return { getSnapshot: () => entry };
}

let runSubagent: typeof import('../core/agent/subagentRunner').runSubagent;
let runSubagentLoop: typeof import('../core/agent/subagentLoop').runSubagentLoop;

beforeAll(async () => {
  ({ runSubagent } = await import('../core/agent/subagentRunner'));
  ({ runSubagentLoop } = await import('../core/agent/subagentLoop'));
});

beforeEach(() => {
  state.adapterCalls.length = 0;
});

describe('provider made unusable while the parent run is in flight', () => {
  it('still runs a delegate on the parent model while that model is usable', async () => {
    const entryReader = startParentRun();
    const result = await runSubagent({ agent, task: 'summarize', settingsReader: entryReader });
    expect(result.stopReason).toBe('completed');
    expect(state.adapterCalls).toEqual([
      expect.objectContaining({ model: 'acme-model', apiKey: 'acme-key', baseUrl: 'https://acme.example/v1' }),
    ]);
  });

  it.each([
    ['removed', () => useSettingsStore.getState().removeProvider('acme'), 'belongs to a service that was removed'],
    ['turned off', () => useSettingsStore.getState().toggleProvider('acme'), 'belongs to a service that is turned off'],
    ['stripped of the model', () => useSettingsStore.getState().updateProvider('acme', { models: [{ id: 'new', label: 'new' }] }), 'was removed from its service'],
  ])('never calls a delegate once the provider is %s', async (_label, breakProvider, reasonText) => {
    const entryReader = startParentRun();
    breakProvider();

    const result = await runSubagent({ agent, task: 'summarize', settingsReader: entryReader });

    expect(result.stopReason).toBe('error');
    expect(result.text).toContain('acme model');
    expect(result.text).toContain(reasonText);
    expect(state.adapterCalls).toEqual([]);
  });

  it('the loop itself refuses too (the in-sidecar nested path skips the runner)', async () => {
    const entryReader = startParentRun();
    useSettingsStore.getState().toggleProvider('acme');

    const viaDefaultLiveReader = await runSubagentLoop({ agent, task: 'summarize', settingsReader: entryReader });
    const liveProviders = getSettingsReader().getSnapshot();
    const viaExplicitLiveReader = await runSubagentLoop({
      agent,
      task: 'summarize',
      settingsReader: entryReader,
      liveSettingsReader: { getSnapshot: () => liveProviders },
    });

    expect(viaDefaultLiveReader.stopReason).toBe('error');
    expect(viaExplicitLiveReader.stopReason).toBe('error');
    expect(state.adapterCalls).toEqual([]);
  });

  it('does not move the delegate to the provider that became the global default', async () => {
    const entryReader = startParentRun();
    useSettingsStore.getState().removeProvider('acme');
    expect(useSettingsStore.getState().activeModel).toEqual({ providerId: 'other', modelId: 'other-model' });

    const result = await runSubagent({ agent, task: 'summarize', settingsReader: entryReader });

    expect(result.stopReason).toBe('error');
    expect(state.adapterCalls).toEqual([]);
  });
});
