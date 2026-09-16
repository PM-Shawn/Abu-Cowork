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
    applySettingsSnapshot(first, 1);
    seedSettingsMirrorIfEmpty(second);
    expect(getSettingsMirrorReader().getSnapshot()).toBe(first);
  });

  it('applySettingsSnapshot wins over a prior seed — a push is newer than a dispatch-time snapshot', () => {
    const seeded = makeSettings({ activeModel: { providerId: 'p1', modelId: 'm1' } });
    const pushed = makeSettings({ activeModel: { providerId: 'p2', modelId: 'm2' } });
    seedSettingsMirrorIfEmpty(seeded);
    applySettingsSnapshot(pushed, 0);
    expect(getSettingsMirrorReader().getSnapshot()).toBe(pushed);
  });

  it('getSettingsMirrorReader() always returns a reader backed by the SAME shared mirror (not a per-call snapshot)', () => {
    const readerA = getSettingsMirrorReader();
    const readerB = getSettingsMirrorReader();
    const s = makeSettings();
    applySettingsSnapshot(s, 0);
    expect(readerA.getSnapshot()).toBe(s);
    expect(readerB.getSnapshot()).toBe(s);
  });

  /**
   * The regression this revision exists for: `notifySidecar` is
   * fire-and-forget, so two debounced pushes can arrive in either order.
   * Without an ordering key the mirror keeps whichever landed LAST, which for
   * a permission that was just tightened means silently handing it back.
   */
  describe('monotonic revision', () => {
    it('drops a push that arrives out of order instead of regressing the mirror', () => {
      const tightened = makeSettings({ allowUnattendedBrowser: false });
      const stale = makeSettings({ allowUnattendedBrowser: true });

      expect(applySettingsSnapshot(tightened, 7)).toBe(true);
      // The pre-change snapshot, delayed in flight and arriving second.
      expect(applySettingsSnapshot(stale, 6)).toBe(false);

      expect(getSettingsMirrorReader().getSnapshot()).toBe(tightened);
    });

    it('drops a REPLAY of the revision already applied', () => {
      const first = makeSettings({ allowUnattendedBrowser: false });
      const replay = makeSettings({ allowUnattendedBrowser: true });

      applySettingsSnapshot(first, 3);
      expect(applySettingsSnapshot(replay, 3)).toBe(false);

      expect(getSettingsMirrorReader().getSnapshot()).toBe(first);
    });

    it('applies a strictly newer push', () => {
      const older = makeSettings({ allowUnattendedBrowser: true });
      const newer = makeSettings({ allowUnattendedBrowser: false });

      applySettingsSnapshot(older, 3);
      expect(applySettingsSnapshot(newer, 4)).toBe(true);

      expect(getSettingsMirrorReader().getSnapshot()).toBe(newer);
    });

    it('accepts revision 0 as the first push — an empty mirror has no order to violate', () => {
      const s = makeSettings();
      expect(applySettingsSnapshot(s, 0)).toBe(true);
      expect(getSettingsMirrorReader().getSnapshot()).toBe(s);
    });

    it('refuses a non-finite revision rather than applying an unorderable snapshot', () => {
      const seeded = makeSettings({ allowUnattendedBrowser: false });
      seedSettingsMirrorIfEmpty(seeded);

      expect(applySettingsSnapshot(makeSettings({ allowUnattendedBrowser: true }), Number.NaN)).toBe(false);
      expect(applySettingsSnapshot(makeSettings({ allowUnattendedBrowser: true }), Number.POSITIVE_INFINITY)).toBe(false);

      expect(getSettingsMirrorReader().getSnapshot()).toBe(seeded);
    });

    it('lets a seed fill an EMPTY mirror without claiming a revision — the next push of any revision still wins', () => {
      const seeded = makeSettings({ activeModel: { providerId: 'p1', modelId: 'm1' } });
      const pushed = makeSettings({ activeModel: { providerId: 'p2', modelId: 'm2' } });
      seedSettingsMirrorIfEmpty(seeded);
      expect(applySettingsSnapshot(pushed, 0)).toBe(true);
      expect(getSettingsMirrorReader().getSnapshot()).toBe(pushed);
    });
  });
});
