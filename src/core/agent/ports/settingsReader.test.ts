import { describe, it, expect } from 'vitest';
import { useSettingsStore } from '@/stores/settingsStore';
import { createInProcessSettingsReader } from './settingsReader';

describe('createInProcessSettingsReader', () => {
  it('getSnapshot() returns the same data as useSettingsStore.getState()', () => {
    const reader = createInProcessSettingsReader();
    const snapshot = reader.getSnapshot() as Record<string, unknown>;
    const full = useSettingsStore.getState() as unknown as Record<string, unknown>;
    for (const key of Object.keys(snapshot)) {
      expect(snapshot[key]).toBe(full[key]); // shallow: nested refs shared with store
    }
  });

  it('strips store actions — snapshot is data-only (IPC-shape parity)', () => {
    const full = useSettingsStore.getState() as unknown as Record<string, unknown>;
    // canary: the raw store DOES carry function-valued actions, so this test is meaningful
    expect(Object.values(full).some((v) => typeof v === 'function')).toBe(true);
    const snapshot = createInProcessSettingsReader().getSnapshot() as Record<string, unknown>;
    expect(Object.values(snapshot).some((v) => typeof v === 'function')).toBe(false);
  });

  it('reflects store updates on the next call (not cached at construction time)', () => {
    const reader = createInProcessSettingsReader();
    const before = reader.getSnapshot().agentMaxTurns;
    useSettingsStore.setState({ agentMaxTurns: before + 1 });
    expect(reader.getSnapshot().agentMaxTurns).toBe(before + 1);
    // restore
    useSettingsStore.setState({ agentMaxTurns: before });
  });
});
