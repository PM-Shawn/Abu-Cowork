/**
 * S18 end-to-end through the REAL store and the REAL persist middleware.
 *
 * `browserConfigPersistence.test.ts` proves the merge and the read-back
 * confirmation in isolation. This file proves the wiring: that the setters bump
 * a revision, that the storage adapter is actually installed, that a refused
 * write is reported and rolled back rather than displayed as if it had worked,
 * that retry re-applies the value the user WANTED, and that a second window
 * cannot silently drop a permission the first one just wrote.
 *
 * Driven through `useSettingsStore`'s own setters and a controllable storage
 * double, because the failure this exists to stop — "the pane says blocked, the
 * gate says allowed" — is a property of the whole path, not of any one piece.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useSettingsStore,
  __resetBrowserConfigPersistenceForTests,
} from './settingsStore';
import { useBrowserSaveStatusStore } from './browserSaveStatus';
import { INITIAL_BROWSER_CONFIG_REVISIONS } from './browserConfigPersistence';
import { DEFAULT_BROWSER_OPERATION_POLICY } from '@/core/permissions/browserToolPolicy';
import { testSiteVerdicts } from '@/test/browserSiteVerdicts';

const KEY = 'abu-settings';

/**
 * A `localStorage` stand-in whose writes can be made to fail, or to succeed
 * silently without storing anything — the shape a quota-exceeded or
 * site-data-blocked browser actually produces, and the one a "did it throw?"
 * check cannot see.
 */
class FakeStorage {
  private data = new Map<string, string>();
  mode: 'ok' | 'throw' | 'swallow' = 'ok';

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.mode === 'throw') throw new DOMException('quota', 'QuotaExceededError');
    if (this.mode === 'swallow') return;
    this.data.set(key, value);
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  /** Write a blob as if ANOTHER window had done it. */
  seedFromOtherWindow(state: Record<string, unknown>): void {
    this.data.set(KEY, JSON.stringify({ state, version: 47 }));
  }

  storedState(): Record<string, unknown> {
    const raw = this.data.get(KEY);
    return raw === undefined ? {} : (JSON.parse(raw) as { state: Record<string, unknown> }).state;
  }
}

let storage: FakeStorage;

function statusOf(field: 'browserSitePermissions' | 'browserOperationPolicy' | 'allowUnattendedBrowser') {
  return useBrowserSaveStatusStore.getState().status[field];
}

describe('browser config saving', () => {
  beforeEach(() => {
    storage = new FakeStorage();
    vi.stubGlobal('localStorage', storage);
    __resetBrowserConfigPersistenceForTests();
    useBrowserSaveStatusStore.getState().__resetBrowserSaveStatus();
    useSettingsStore.setState({
      browserSitePermissions: testSiteVerdicts({}),
      browserOperationPolicy: DEFAULT_BROWSER_OPERATION_POLICY,
      allowUnattendedBrowser: false,
      browserConfigRevisions: INITIAL_BROWSER_CONFIG_REVISIONS,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __resetBrowserConfigPersistenceForTests();
    useBrowserSaveStatusStore.getState().__resetBrowserSaveStatus();
  });

  describe('a write that lands', () => {
    it('is confirmed, and confirmed by reading it back rather than by re-rendering', () => {
      useSettingsStore.getState().setBrowserSitePermission('https://a.example.com', 'allowed');

      expect(statusOf('browserSitePermissions')).toBe('saved');
      expect(storage.storedState().browserSitePermissions)
        .toEqual({ 'https://a.example.com': 'allowed' });
    });

    it('advances only the revision of the field that was edited', () => {
      useSettingsStore.getState().setAllowUnattendedBrowser(true);

      expect(useSettingsStore.getState().browserConfigRevisions).toEqual({
        browserOperationPolicy: 0,
        browserSitePermissions: 0,
        allowUnattendedBrowser: 1,
      });
    });

    // Reporting a save for a field the user did not touch would put a
    // confirmation next to a control they never used — `persist` writes the
    // whole blob on every change, so this has to be filtered somewhere.
    it('says nothing about the fields this edit did not touch', () => {
      useSettingsStore.getState().setAllowUnattendedBrowser(true);

      expect(statusOf('allowUnattendedBrowser')).toBe('saved');
      expect(statusOf('browserSitePermissions')).toBeUndefined();
      expect(statusOf('browserOperationPolicy')).toBeUndefined();
    });

    it('reads back what it stored after a reload', () => {
      useSettingsStore.getState().setBrowserOperationState('scripting', 'deny');
      useSettingsStore.getState().setBrowserSitePermission('https://a.example.com', 'denied');

      // What a fresh launch would rehydrate from.
      const reloaded = storage.storedState();
      expect(reloaded.browserOperationPolicy).toMatchObject({ scripting: 'deny' });
      expect(reloaded.browserSitePermissions).toEqual({ 'https://a.example.com': 'denied' });
    });
  });

  describe.each([
    ['storage throws', 'throw' as const],
    ['storage accepts the write and stores nothing', 'swallow' as const],
  ])('a write that does not land (%s)', (_label, mode) => {
    it('says so instead of showing the value as if it were in force', () => {
      // One good write first, so there is a confirmed value to fall back to.
      useSettingsStore.getState().setBrowserSitePermission('https://a.example.com', 'allowed');
      storage.mode = mode;

      useSettingsStore.getState().setBrowserSitePermission('https://b.example.com', 'denied');

      expect(statusOf('browserSitePermissions')).toBe('failed');
    });

    it('rolls the field back to its last CONFIRMED value', () => {
      useSettingsStore.getState().setBrowserSitePermission('https://a.example.com', 'allowed');
      storage.mode = mode;

      useSettingsStore.getState().setBrowserSitePermission('https://b.example.com', 'denied');

      // Not "the value before this edit" — that one may never have been stored
      // either. The last one storage actually confirmed.
      expect(useSettingsStore.getState().browserSitePermissions)
        .toEqual({ 'https://a.example.com': 'allowed' });
    });

    /**
     * The rollback is per field, on purpose: a failure while saving the
     * operation policy must not undo a site verdict that saved a moment ago.
     */
    it('leaves the other browser fields exactly as they were', () => {
      useSettingsStore.getState().setBrowserSitePermission('https://a.example.com', 'allowed');
      useSettingsStore.getState().setAllowUnattendedBrowser(true);
      storage.mode = mode;

      useSettingsStore.getState().setBrowserOperationState('interactive', 'deny');

      expect(useSettingsStore.getState().allowUnattendedBrowser).toBe(true);
      expect(useSettingsStore.getState().browserSitePermissions)
        .toEqual({ 'https://a.example.com': 'allowed' });
      expect(statusOf('allowUnattendedBrowser')).toBe('saved');
    });

    it('does not spin forever trying to repair a storage that keeps refusing', () => {
      useSettingsStore.getState().setAllowUnattendedBrowser(true);
      storage.mode = mode;

      // Would recurse without the repair guard: roll back -> write -> fail ->
      // roll back...
      expect(() => useSettingsStore.getState().setAllowUnattendedBrowser(false)).not.toThrow();
      expect(statusOf('allowUnattendedBrowser')).toBe('failed');
    });

    it('retries with the value the user WANTED, not the one it rolled back to', () => {
      useSettingsStore.getState().setBrowserSitePermission('https://a.example.com', 'allowed');
      storage.mode = mode;
      useSettingsStore.getState().setBrowserSitePermission('https://b.example.com', 'denied');
      expect(useSettingsStore.getState().browserSitePermissions)
        .toEqual({ 'https://a.example.com': 'allowed' });

      storage.mode = 'ok';
      useSettingsStore.getState().retryBrowserConfigSave('browserSitePermissions');

      expect(statusOf('browserSitePermissions')).toBe('saved');
      expect(useSettingsStore.getState().browserSitePermissions).toEqual({
        'https://a.example.com': 'allowed',
        'https://b.example.com': 'denied',
      });
      expect(storage.storedState().browserSitePermissions).toEqual({
        'https://a.example.com': 'allowed',
        'https://b.example.com': 'denied',
      });
    });
  });

  describe('two windows editing at once', () => {
    /**
     * The bug. This window has been open since before the other one blocked a
     * site, so its in-memory verdict map does not have the block. Changing an
     * operation row here used to write that stale map back over it, and the
     * gate then allowed a site the user had stopped — with nothing on screen
     * to say so.
     */
    it('does not drop the site verdict the other window just wrote', () => {
      useSettingsStore.getState().setAllowUnattendedBrowser(true);
      storage.seedFromOtherWindow({
        ...storage.storedState(),
        browserSitePermissions: { 'https://bank.example.com': 'denied' },
        browserConfigRevisions: {
          ...INITIAL_BROWSER_CONFIG_REVISIONS,
          allowUnattendedBrowser: 1,
          browserSitePermissions: 9,
        },
      });

      useSettingsStore.getState().setBrowserOperationState('interactive', 'deny');

      expect(storage.storedState().browserSitePermissions)
        .toEqual({ 'https://bank.example.com': 'denied' });
      // And this window's own edit still landed.
      expect(storage.storedState().browserOperationPolicy)
        .toMatchObject({ interactive: 'deny' });
    });

    // A pane still displaying a permission that storage no longer holds is the
    // same lie as an unreported failed save, one step removed.
    it('shows the value the other window won with, rather than the stale one', () => {
      storage.seedFromOtherWindow({
        browserSitePermissions: { 'https://bank.example.com': 'denied' },
        browserConfigRevisions: {
          ...INITIAL_BROWSER_CONFIG_REVISIONS,
          browserSitePermissions: 9,
        },
      });

      useSettingsStore.getState().setBrowserOperationState('interactive', 'deny');

      expect(useSettingsStore.getState().browserSitePermissions)
        .toEqual({ 'https://bank.example.com': 'denied' });
    });

    /**
     * The other direction: a stale window's OWN edit must still win for the
     * field it touched. Bumping only its in-memory counter would leave it
     * permanently behind and every edit it made would be discarded as old news
     * — the same silent loss, arrived at from the other side.
     */
    it('lets a stale window still win the field it actually edited', () => {
      storage.seedFromOtherWindow({
        browserSitePermissions: {},
        allowUnattendedBrowser: false,
        browserConfigRevisions: {
          ...INITIAL_BROWSER_CONFIG_REVISIONS,
          allowUnattendedBrowser: 42,
        },
      });

      useSettingsStore.getState().setAllowUnattendedBrowser(true);

      expect(storage.storedState().allowUnattendedBrowser).toBe(true);
      expect(useSettingsStore.getState().allowUnattendedBrowser).toBe(true);
    });

    // "同一字段连续修改以最后一次明确选择为准" — two quick edits of one field
    // from this window, in order.
    it('keeps the last explicit choice when one field is changed twice quickly', () => {
      useSettingsStore.getState().setBrowserOperationState('scripting', 'allow');
      useSettingsStore.getState().setBrowserOperationState('scripting', 'deny');

      expect(storage.storedState().browserOperationPolicy).toMatchObject({ scripting: 'deny' });
      expect(useSettingsStore.getState().browserOperationPolicy).toMatchObject({ scripting: 'deny' });
    });
  });
});
