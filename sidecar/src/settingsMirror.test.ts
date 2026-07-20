import { describe, it, expect, beforeEach } from 'vitest';
import {
  applySettingsSnapshot,
  seedSettingsMirrorIfEmpty,
  getSettingsMirrorReader,
  __resetSettingsMirror,
} from './settingsMirror';
import type { SettingsState } from '@/stores/settingsStore';

function makeSettings(overrides?: Partial<SettingsState>): SettingsState {
  return { activeModel: { providerId: 'p1', modelId: 'm1' }, ...overrides } as SettingsState;
}

describe('settingsMirror', () => {
  beforeEach(() => {
    __resetSettingsMirror();
  });

  it('throws if read before any seed/push', () => {
    expect(() => getSettingsMirrorReader().getSnapshot()).toThrow(/before any settingsSnapshot was seeded/);
  });

  it('seedSettingsMirrorIfEmpty seeds the mirror when nothing has landed', () => {
    const s = makeSettings();
    seedSettingsMirrorIfEmpty(s);
    expect(getSettingsMirrorReader().getSnapshot()).toBe(s);
  });

  it('seedSettingsMirrorIfEmpty is a no-op once something has already landed (never regresses a fresher push)', () => {
    const first = makeSettings({ activeModel: { providerId: 'p1', modelId: 'm1' } });
    const second = makeSettings({ activeModel: { providerId: 'p2', modelId: 'm2' } });
    applySettingsSnapshot(first);
    seedSettingsMirrorIfEmpty(second);
    expect(getSettingsMirrorReader().getSnapshot()).toBe(first);
  });

  it('applySettingsSnapshot always wins — latest push overwrites a prior seed or push', () => {
    const seeded = makeSettings({ activeModel: { providerId: 'p1', modelId: 'm1' } });
    const pushed = makeSettings({ activeModel: { providerId: 'p2', modelId: 'm2' } });
    seedSettingsMirrorIfEmpty(seeded);
    applySettingsSnapshot(pushed);
    expect(getSettingsMirrorReader().getSnapshot()).toBe(pushed);
  });

  it('getSettingsMirrorReader() always returns a reader backed by the SAME shared mirror (not a per-call snapshot)', () => {
    const readerA = getSettingsMirrorReader();
    const readerB = getSettingsMirrorReader();
    const s = makeSettings();
    applySettingsSnapshot(s);
    expect(readerA.getSnapshot()).toBe(s);
    expect(readerB.getSnapshot()).toBe(s);
  });
});
