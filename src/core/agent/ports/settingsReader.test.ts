import { describe, it, expect, afterEach } from 'vitest';
import { useSettingsStore } from '@/stores/settingsStore';
import {
  createInProcessSettingsReader,
  getSettingsReader,
  setSettingsReader,
  type SettingsReader,
} from './settingsReader';

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

  describe('memoization (F2)', () => {
    it('returns the same snapshot reference across calls when the store state has not changed', () => {
      const reader = createInProcessSettingsReader();
      const first = reader.getSnapshot();
      const second = reader.getSnapshot();
      expect(second).toBe(first); // no full Object.keys copy on the second call
    });

    it('returns a fresh snapshot reference after the store state changes', () => {
      const reader = createInProcessSettingsReader();
      const before = reader.getSnapshot().agentMaxTurns;
      const first = reader.getSnapshot();

      useSettingsStore.setState({ agentMaxTurns: before + 1 });
      const second = reader.getSnapshot();

      expect(second).not.toBe(first);
      expect(second.agentMaxTurns).toBe(before + 1);

      // restore
      useSettingsStore.setState({ agentMaxTurns: before });
    });

    it('does not leak a memo across independently-constructed readers', () => {
      const readerA = createInProcessSettingsReader();
      const readerB = createInProcessSettingsReader();
      expect(readerA.getSnapshot()).not.toBe(readerB.getSnapshot()); // distinct closures, distinct snapshot objects
    });
  });
});

describe('getSettingsReader / setSettingsReader', () => {
  const defaultReader = getSettingsReader();

  afterEach(() => {
    // restore the default in-process reader so other test files aren't affected
    setSettingsReader(defaultReader);
  });

  it('getSettingsReader() returns a working in-process reader by default', () => {
    const reader = getSettingsReader();
    expect(typeof reader.getSnapshot).toBe('function');
    expect(reader.getSnapshot().agentMaxTurns).toBe(useSettingsStore.getState().agentMaxTurns);
  });

  it('setSettingsReader() swaps the module-level reader returned by getSettingsReader()', () => {
    const stub: SettingsReader = {
      getSnapshot: () => ({ agentMaxTurns: 999 }) as ReturnType<SettingsReader['getSnapshot']>,
    };
    setSettingsReader(stub);
    expect(getSettingsReader()).toBe(stub);
    expect(getSettingsReader().getSnapshot().agentMaxTurns).toBe(999);
  });
});
