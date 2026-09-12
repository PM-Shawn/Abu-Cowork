// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { reconcileActiveProvider, useSettingsStore, getDefaultImageBackend, getUsableImageBackend, bootstrapSecrets, __resetBrowserConfigPersistenceForTests } from './settingsStore';
import type { ProviderInstance, ActiveModel, ImageGenBackend } from '@/types/provider';
import {
  getSiteVerdict,
  type BrowserSiteGrantScopes,
} from '@/core/permissions/browserToolPolicy';

// ─── Test fixture helpers ─────────────────────────────────────

function makeProvider(overrides: Partial<ProviderInstance> = {}): ProviderInstance {
  return {
    id: 'p1',
    source: 'builtin',
    name: 'Provider 1',
    enabled: true,
    apiFormat: 'openai-compatible',
    baseUrl: 'https://api.example.com',
    apiKey: 'sk-test',
    models: [{ id: 'm1', label: 'Model 1' }],
    status: 'unchecked',
    sortOrder: 0,
    ...overrides,
  };
}

function makeState(
  providers: ProviderInstance[],
  activeModel: ActiveModel,
): { providers: ProviderInstance[]; activeModel: ActiveModel } {
  return { providers, activeModel };
}

describe('reconcileActiveProvider', () => {
  // ─── Branch 1: active provider exists and is enabled — no-op ───
  describe('when active provider is enabled', () => {
    it('leaves state unchanged', () => {
      const p = makeProvider({ id: 'p1', enabled: true, apiKey: 'key' });
      const state = makeState([p], { providerId: 'p1', modelId: 'm1' });
      const before = JSON.parse(JSON.stringify(state));

      reconcileActiveProvider(state);

      expect(state).toEqual(before);
    });
  });

  // ─── Branch 2: active provider missing entirely ───
  describe('when active provider does not exist in providers[]', () => {
    it('switches to first usable enabled provider (has key)', () => {
      const usable = makeProvider({
        id: 'usable',
        enabled: true,
        apiKey: 'key',
        models: [{ id: 'usable-m1', label: 'M1' }],
      });
      const enabledNoKey = makeProvider({
        id: 'enabled-no-key',
        enabled: true,
        apiKey: '',
        sortOrder: 1,
      });
      const state = makeState(
        [enabledNoKey, usable],
        { providerId: 'ghost', modelId: 'gone' },
      );

      reconcileActiveProvider(state);

      expect(state.activeModel).toEqual({
        providerId: 'usable',
        modelId: 'usable-m1',
      });
    });

    it('falls back to ollama (no key needed) if available', () => {
      const ollama = makeProvider({
        id: 'ollama',
        enabled: true,
        apiKey: '',
        models: [{ id: 'llama3', label: 'Llama 3' }],
      });
      const state = makeState([ollama], { providerId: 'ghost', modelId: 'gone' });

      reconcileActiveProvider(state);

      expect(state.activeModel).toEqual({
        providerId: 'ollama',
        modelId: 'llama3',
      });
    });

    it('falls back to any enabled provider if no usable one exists', () => {
      const enabledNoKey = makeProvider({
        id: 'p1',
        enabled: true,
        apiKey: '',
        models: [{ id: 'm1', label: 'M1' }],
      });
      const state = makeState([enabledNoKey], { providerId: 'ghost', modelId: 'gone' });

      reconcileActiveProvider(state);

      expect(state.activeModel).toEqual({
        providerId: 'p1',
        modelId: 'm1',
      });
    });

    it('leaves activeModel untouched if no enabled provider exists at all', () => {
      const disabled = makeProvider({ id: 'p1', enabled: false, apiKey: 'key' });
      const state = makeState([disabled], { providerId: 'ghost', modelId: 'gone' });

      reconcileActiveProvider(state);

      // No usable fallback — activeModel preserved (caller can detect via getActiveProvider returning undefined)
      expect(state.activeModel).toEqual({ providerId: 'ghost', modelId: 'gone' });
      // Importantly: does NOT silently force-enable a random disabled provider
      expect(state.providers[0].enabled).toBe(false);
    });

    it('handles provider with empty models array gracefully', () => {
      const noModels = makeProvider({
        id: 'p1',
        enabled: true,
        apiKey: 'key',
        models: [],
      });
      const state = makeState([noModels], { providerId: 'ghost', modelId: 'gone' });

      reconcileActiveProvider(state);

      expect(state.activeModel).toEqual({ providerId: 'p1', modelId: '' });
    });
  });

  // ─── Branch 3: active provider exists but is disabled, and is usable ───
  describe('when active provider is disabled but has a key', () => {
    it('silently re-enables it (preserves V14 default behavior)', () => {
      const p = makeProvider({ id: 'p1', enabled: false, apiKey: 'key' });
      const state = makeState([p], { providerId: 'p1', modelId: 'm1' });

      reconcileActiveProvider(state);

      expect(state.providers[0].enabled).toBe(true);
      expect(state.activeModel).toEqual({ providerId: 'p1', modelId: 'm1' });
    });

    it('silently re-enables ollama even with empty key', () => {
      const p = makeProvider({ id: 'ollama', enabled: false, apiKey: '' });
      const state = makeState([p], { providerId: 'ollama', modelId: 'm1' });

      reconcileActiveProvider(state);

      expect(state.providers[0].enabled).toBe(true);
    });

    it('treats whitespace-only apiKey as empty (not usable)', () => {
      const whitespaceKey = makeProvider({
        id: 'p1',
        enabled: false,
        apiKey: '   ',
      });
      const usableFallback = makeProvider({
        id: 'p2',
        enabled: true,
        apiKey: 'real-key',
        models: [{ id: 'm2', label: 'M2' }],
      });
      const state = makeState(
        [whitespaceKey, usableFallback],
        { providerId: 'p1', modelId: 'm1' },
      );

      reconcileActiveProvider(state);

      // Whitespace key is NOT considered usable → switch to p2
      expect(state.activeModel).toEqual({ providerId: 'p2', modelId: 'm2' });
      expect(state.providers[0].enabled).toBe(false); // p1 stays disabled
    });
  });

  // ─── Branch 4: active provider disabled AND unusable — needs fallback ───
  describe('when active provider is disabled and has no key', () => {
    it('switches active to a usable enabled fallback, leaving original disabled', () => {
      const disabledNoKey = makeProvider({
        id: 'p1',
        enabled: false,
        apiKey: '',
      });
      const usable = makeProvider({
        id: 'p2',
        enabled: true,
        apiKey: 'key',
        models: [{ id: 'm2', label: 'M2' }],
      });
      const state = makeState(
        [disabledNoKey, usable],
        { providerId: 'p1', modelId: 'm1' },
      );

      reconcileActiveProvider(state);

      expect(state.activeModel).toEqual({ providerId: 'p2', modelId: 'm2' });
      // Critical: original active provider STAYS disabled — user intent preserved
      expect(state.providers[0].enabled).toBe(false);
    });

    it('prefers fallback that is usable over fallback that is enabled-but-keyless', () => {
      const disabledNoKey = makeProvider({ id: 'p1', enabled: false, apiKey: '' });
      const enabledNoKey = makeProvider({
        id: 'enabled-no-key',
        enabled: true,
        apiKey: '',
        sortOrder: 1,
      });
      const usable = makeProvider({
        id: 'usable',
        enabled: true,
        apiKey: 'key',
        models: [{ id: 'usable-m', label: 'UM' }],
        sortOrder: 2,
      });
      const state = makeState(
        [disabledNoKey, enabledNoKey, usable],
        { providerId: 'p1', modelId: 'm1' },
      );

      reconcileActiveProvider(state);

      // Should pick `usable`, NOT `enabled-no-key`
      expect(state.activeModel.providerId).toBe('usable');
    });

    it('leaves provider disabled when no fallback exists and provider has no key', () => {
      // New behavior: no force-enable if the active provider has no key.
      // This keeps the first-run banner visible so the user is guided to configure.
      const disabledNoKey = makeProvider({
        id: 'p1',
        enabled: false,
        apiKey: '',
      });
      const otherDisabled = makeProvider({
        id: 'p2',
        enabled: false,
        apiKey: 'key',
        sortOrder: 1,
      });
      const state = makeState(
        [disabledNoKey, otherDisabled],
        { providerId: 'p1', modelId: 'm1' },
      );

      reconcileActiveProvider(state);

      // No usable fallback (p2 is disabled) and p1 has no key →
      // leave disabled so the first-run banner keeps showing.
      expect(state.providers[0].enabled).toBe(false);
      expect(state.activeModel).toEqual({ providerId: 'p1', modelId: 'm1' });
      expect(state.providers[1].enabled).toBe(false); // p2 untouched
    });

    it('does not consider self as fallback (the id !== self guard)', () => {
      // Only provider has no key → stays disabled (no force-enable).
      const disabledNoKey = makeProvider({
        id: 'p1',
        enabled: false,
        apiKey: '',
      });
      const state = makeState([disabledNoKey], { providerId: 'p1', modelId: 'm1' });

      reconcileActiveProvider(state);

      expect(state.providers[0].enabled).toBe(false);
    });
  });

  // ─── User-reported scenario: V14 migration aftermath ───
  describe('regression scenarios', () => {
    it('handles "user disabled active, has another usable provider" (the original bug)', () => {
      // User had minimax (active) with key, then toggled it off to switch to didi
      // App restart → onRehydrateStorage runs
      const minimax = makeProvider({
        id: 'minimax',
        enabled: false, // user toggled off
        apiKey: '', // key was cleared at some point
      });
      const didi = makeProvider({
        id: 'didi',
        enabled: true,
        apiKey: 'didi-key',
        models: [{ id: 'glm-5', label: 'GLM 5' }],
      });
      const state = makeState(
        [minimax, didi],
        { providerId: 'minimax', modelId: 'm1' },
      );

      reconcileActiveProvider(state);

      // Active should switch to didi (the usable one), minimax stays disabled
      expect(state.activeModel.providerId).toBe('didi');
      expect(state.providers.find(p => p.id === 'minimax')!.enabled).toBe(false);
    });

    it('handles "qiniu placeholder + new minimax" V14 migration aftermath', () => {
      // V14 migration created qiniu (default active, enabled, no key)
      // User then added minimax with key
      // Active is still qiniu — onRehydrate should keep this state stable
      // because qiniu is still enabled, even though it has no key.
      const qiniu = makeProvider({
        id: 'qiniu',
        enabled: true, // default-enabled by V14
        apiKey: '',
      });
      const minimax = makeProvider({
        id: 'minimax',
        enabled: true,
        apiKey: 'mm-key',
        sortOrder: 1,
      });
      const state = makeState(
        [qiniu, minimax],
        { providerId: 'qiniu', modelId: 'm1' },
      );

      reconcileActiveProvider(state);

      // qiniu is enabled → branch 1 hit → no changes
      expect(state.activeModel).toEqual({ providerId: 'qiniu', modelId: 'm1' });
      expect(state.providers[0].enabled).toBe(true);
      // (The needsSetup banner is now correctly suppressed by the new
      // ChatView predicate because minimax has a key — that's tested
      // separately by ChatView, not here.)
    });
  });
});

// ─── Whitespace trimming at the store boundary ──────────────────
// Regression coverage for the trailing-space-in-baseUrl bug:
// users pasting URLs like "http://x.com/ " would hit /%20/v1/... 404s.
describe('settingsStore whitespace trim', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      providers: [],
      auxiliaryServices: {},
    });
  });

  describe('addProvider', () => {
    it('trims whitespace from baseUrl and apiKey on create', () => {
      const id = useSettingsStore.getState().addProvider({
        source: 'custom',
        name: 'test',
        enabled: true,
        apiFormat: 'openai-compatible',
        baseUrl: '  http://x.com/ ',
        apiKey: ' sk-test\n',
        models: [{ id: 'm1', label: 'M1' }],
      });
      const p = useSettingsStore.getState().providers.find((x) => x.id === id);
      expect(p?.baseUrl).toBe('http://x.com/');
      expect(p?.apiKey).toBe('sk-test');
    });
  });

  describe('updateProvider', () => {
    it('trims whitespace from baseUrl patch', () => {
      const id = useSettingsStore.getState().addProvider({
        source: 'custom',
        name: 'test',
        enabled: true,
        apiFormat: 'openai-compatible',
        baseUrl: 'http://x.com',
        apiKey: 'sk-test',
        models: [{ id: 'm1', label: 'M1' }],
      });
      useSettingsStore.getState().updateProvider(id, {
        baseUrl: '  http://y.com/ ',
        apiKey: ' sk-new ',
      });
      const p = useSettingsStore.getState().providers.find((x) => x.id === id);
      expect(p?.baseUrl).toBe('http://y.com/');
      expect(p?.apiKey).toBe('sk-new');
    });

    it('leaves other fields alone when patch omits baseUrl/apiKey', () => {
      const id = useSettingsStore.getState().addProvider({
        source: 'custom',
        name: 'test',
        enabled: true,
        apiFormat: 'openai-compatible',
        baseUrl: 'http://x.com',
        apiKey: 'sk-test',
        models: [{ id: 'm1', label: 'M1' }],
      });
      useSettingsStore.getState().updateProvider(id, { enabled: false });
      const p = useSettingsStore.getState().providers.find((x) => x.id === id);
      expect(p?.enabled).toBe(false);
      expect(p?.baseUrl).toBe('http://x.com');
      expect(p?.apiKey).toBe('sk-test');
    });
  });

  describe('setAuxiliaryWebSearch', () => {
    it('trims whitespace from baseUrl and apiKey', () => {
      useSettingsStore.getState().setAuxiliaryWebSearch({
        provider: 'tavily',
        apiKey: '  key-123 ',
        baseUrl: ' http://search.example.com/ ',
      });
      const cfg = useSettingsStore.getState().auxiliaryServices.webSearch;
      expect(cfg?.apiKey).toBe('key-123');
      expect(cfg?.baseUrl).toBe('http://search.example.com/');
    });
  });

});

describe('settingsStore partialize', () => {
  // Regression: petPosition/dndMode/petOpen/defaultAgentAutonomy were added to
  // SettingsState but never added to the persist `partialize` whitelist, so they
  // silently never survived a real localStorage roundtrip despite passing
  // in-memory store tests.
  it('includes pet and autonomy fields in the persisted snapshot', () => {
    const persistApi = (useSettingsStore as unknown as {
      persist: { getOptions: () => { partialize?: (state: unknown) => Record<string, unknown> } };
    }).persist;
    const partialize = persistApi.getOptions().partialize;
    expect(partialize).toBeDefined();
    const snapshot = partialize!(useSettingsStore.getState());
    expect(snapshot).toHaveProperty('petPosition');
    expect(snapshot).toHaveProperty('dndMode');
    expect(snapshot).toHaveProperty('petOpen');
    expect(snapshot).toHaveProperty('defaultAgentAutonomy');
  });

  it('persists pendingImageGenSecretBridge so a failed first-launch secret bridge retries', () => {
    // Regression: the marker used to be non-persisted, so if bootstrapSecrets
    // crashed/failed on the first post-upgrade launch the migrated backend's key
    // was orphaned forever (version already 41 → V41 never re-runs). It must
    // survive a localStorage roundtrip so the bridge retries next launch.
    const persistApi = (useSettingsStore as unknown as {
      persist: { getOptions: () => { partialize?: (state: unknown) => Record<string, unknown> } };
    }).persist;
    const partialize = persistApi.getOptions().partialize!;
    useSettingsStore.setState({ pendingImageGenSecretBridge: 'backend-123' });
    const snapshot = partialize(useSettingsStore.getState());
    expect(snapshot.pendingImageGenSecretBridge).toBe('backend-123');
    useSettingsStore.setState({ pendingImageGenSecretBridge: undefined });
  });
});

const OA = 'https://oa.example.com';
const PORTAL = 'https://portal.example.org';

/**
 * Round-2 R2-C-②, rescoped 2026-09-08. The scope and the verdict are two
 * fields, so the ONE thing that can go wrong is drift — a scope outliving the
 * grant it qualifies, or a direct authorization leaving an old scope in place
 * and narrowing a grant the user later gave in full. Both directions are
 * pinned here, because the setter is the only thing standing between them.
 */
describe('settingsStore browser site grants — the via-embed scope', () => {
  beforeEach(() => {
    useSettingsStore.setState({ browserSitePermissions: {}, browserSiteGrantViaEmbed: {} });
  });

  it('records the PAGE a merged embedded-region grant was taken on', () => {
    useSettingsStore.getState()
      .setBrowserSitePermission('https://vendor.example.net', 'allowed', { viaEmbedPage: OA });

    expect(useSettingsStore.getState().browserSiteGrantViaEmbed)
      .toEqual({ 'https://vendor.example.net': { [OA]: true } });
  });

  /**
   * The same region granted on a second page. Each click was its own human
   * act, so the second one ADDS rather than replaces: overwriting would revoke
   * a grant nobody took back, and the user would find the first page asking
   * again for no reason they can see.
   */
  it('adds a second page rather than replacing the first', () => {
    const store = useSettingsStore.getState();
    store.setBrowserSitePermission('https://vendor.example.net', 'allowed', { viaEmbedPage: OA });
    store.setBrowserSitePermission(
      'https://vendor.example.net', 'allowed', { viaEmbedPage: PORTAL },
    );

    expect(useSettingsStore.getState().browserSiteGrantViaEmbed)
      .toEqual({ 'https://vendor.example.net': { [OA]: true, [PORTAL]: true } });
  });

  /**
   * A migrated grant already covers every page's embedded regions ("page
   * unknown"). Naming one would NARROW it — a write meant to add reach taking
   * reach away — so the legacy scope is left exactly as it is.
   */
  it('does not narrow a pre-v51 scope by naming a page on it', () => {
    useSettingsStore.setState({
      browserSitePermissions: { 'https://vendor.example.net': 'allowed' } as never,
      browserSiteGrantViaEmbed: { 'https://vendor.example.net': {} },
    });

    useSettingsStore.getState()
      .setBrowserSitePermission('https://vendor.example.net', 'allowed', { viaEmbedPage: OA });

    expect(useSettingsStore.getState().browserSiteGrantViaEmbed)
      .toEqual({ 'https://vendor.example.net': {} });
  });

  it('leaves an ordinary grant unscoped', () => {
    useSettingsStore.getState().setBrowserSitePermission('https://example.com', 'allowed');

    expect(useSettingsStore.getState().browserSiteGrantViaEmbed).toEqual({});
  });

  it('clears the mark when the user authorizes the same origin directly', () => {
    const store = useSettingsStore.getState();
    store.setBrowserSitePermission('https://vendor.example.net', 'allowed', { viaEmbedPage: OA });
    // Settings › 网站授权, or a prompt raised while that site WAS the page.
    store.setBrowserSitePermission('https://vendor.example.net', 'allowed');

    expect(useSettingsStore.getState().browserSiteGrantViaEmbed).toEqual({});
    expect(useSettingsStore.getState().browserSitePermissions['https://vendor.example.net'])
      .toBe('allowed');
  });

  it('clears the mark when the origin is blocked instead', () => {
    const store = useSettingsStore.getState();
    store.setBrowserSitePermission('https://vendor.example.net', 'allowed', { viaEmbedPage: OA });
    store.setBrowserSitePermission('https://vendor.example.net', 'denied');

    expect(useSettingsStore.getState().browserSiteGrantViaEmbed).toEqual({});
  });

  it('clears the mark when the verdict is removed', () => {
    const store = useSettingsStore.getState();
    store.setBrowserSitePermission('https://vendor.example.net', 'allowed', { viaEmbedPage: OA });
    store.removeBrowserSitePermission('https://vendor.example.net');

    expect(useSettingsStore.getState().browserSiteGrantViaEmbed).toEqual({});
  });

  it('survives a localStorage roundtrip — a mark that is not persisted is no mark', () => {
    const partialize = (useSettingsStore as unknown as {
      persist: { getOptions: () => { partialize?: (state: unknown) => Record<string, unknown> } };
    }).persist.getOptions().partialize!;
    useSettingsStore.getState()
      .setBrowserSitePermission('https://vendor.example.net', 'allowed', { viaEmbedPage: OA });

    expect(partialize(useSettingsStore.getState()).browserSiteGrantViaEmbed)
      .toEqual({ 'https://vendor.example.net': { [OA]: true } });
  });

  /**
   * Round-3 R3-F / mutation M9. `restoreBrowserConfigField` is the OTHER half
   * of the companion rule — the one that runs when another window turns out to
   * hold a newer copy — and it was the half nothing pinned. Rewriting it to
   * keep this window's marks (`?? state.browserSiteGrantViaEmbed`) left all
   * 123 cases green, and that rewrite is the widening direction: it would
   * strand a mark on a store that has no way to clear it, and the mirror of it
   * (adopting a mark the other window already cleared) would take away a grant
   * the user just gave back.
   *
   * The rule is "the adopted value is taken WHOLE, companions included" — one
   * store wins, never a splice of two — so both directions are pinned here.
   */
  describe('restoreBrowserConfigField takes the adopted value whole', () => {
    beforeEach(() => {
      // The save pipeline is LIVE in this file, and it is doing its job: a
      // restore carrying a revision older than the blob already in storage is
      // legitimately adopted straight back by the cross-window merge. These
      // cases are about the action itself, so they start from an empty disk.
      localStorage.clear();
      __resetBrowserConfigPersistenceForTests();
    });

    /**
     * One marked grant, at a LOW revision. The revision matters: the restores
     * below carry revision 7, and a restore older than the copy already in
     * storage is (correctly) adopted straight back by the cross-window merge —
     * which would make these cases pass or fail on the write queue rather than
     * on the rule they are about.
     */
    function seedMarkedGrant(): void {
      useSettingsStore.setState({
        browserSitePermissions: { 'https://a.example.com': 'allowed' } as never,
        browserSiteGrantViaEmbed: { 'https://a.example.com': { [OA]: true } },
        browserConfigRevisions: {
          browserSitePermissions: 1, browserOperationPolicy: 0, allowUnattendedBrowser: 0,
        },
      });
    }

    it('adopts the other window\'s marks along with its verdicts', () => {
      seedMarkedGrant();

      useSettingsStore.getState().restoreBrowserConfigField(
        'browserSitePermissions',
        { 'https://b.example.com': 'allowed' },
        7,
        { browserSiteGrantViaEmbed: { 'https://b.example.com': { [OA]: true } } },
      );

      expect(useSettingsStore.getState().browserSiteGrantViaEmbed)
        .toEqual({ 'https://b.example.com': { [OA]: true } });
    });

    it('drops this window\'s marks when the adopted store carries none', () => {
      // The widening direction, and the one M9 could reverse in silence: a
      // mark kept here would qualify grants that are no longer in the store,
      // and a marked grant that outlives its store reads as a standing one an
      // automatic run may act on.
      seedMarkedGrant();

      useSettingsStore.getState().restoreBrowserConfigField(
        'browserSitePermissions',
        { 'https://a.example.com': 'allowed' },
        7,
        {},
      );

      expect(useSettingsStore.getState().browserSiteGrantViaEmbed).toEqual({});
    });

    it('drops them when no companions are passed at all', () => {
      seedMarkedGrant();

      useSettingsStore.getState().restoreBrowserConfigField(
        'browserSitePermissions', { 'https://a.example.com': 'allowed' }, 7,
      );

      expect(useSettingsStore.getState().browserSiteGrantViaEmbed).toEqual({});
      // The verdict itself still landed — this is not "restore did nothing".
      expect(useSettingsStore.getState().browserSitePermissions['https://a.example.com'])
        .toBe('allowed');
      expect(useSettingsStore.getState().browserConfigRevisions.browserSitePermissions).toBe(7);
    });

    it('leaves the marks alone when a DIFFERENT field is restored', () => {
      seedMarkedGrant();

      useSettingsStore.getState().restoreBrowserConfigField('allowUnattendedBrowser', true, 3);

      expect(useSettingsStore.getState().browserSiteGrantViaEmbed)
        .toEqual({ 'https://a.example.com': { [OA]: true } });
    });
  });

  function migrateFrom(state: unknown, version: number): Record<string, unknown> {
    const migrate = (useSettingsStore as unknown as {
      persist: { getOptions: () => { migrate: (data: unknown, version: number) => Record<string, unknown> } };
    }).persist.getOptions().migrate;
    return migrate(state, version);
  }

  it('v49 migration gives pre-existing installs an empty map, not a scoped one', () => {
    // Every grant that already exists was minted before a scope could be
    // written, so none of them is known to have come in that way — and an
    // unscoped grant is a full one.
    const migrated = migrateFrom(
      { browserSitePermissions: { 'https://example.com': 'allowed' } },
      48,
    );
    expect(migrated.browserSiteGrantViaEmbed).toEqual({});
  });

  /**
   * v51 — the marks stored between v49 and v50 are bare `true`s that carried
   * their qualification in the GATE ("no standing grant unattended") rather
   * than in the value. The gate no longer does that, so the value has to say
   * what it means, and the only honest reading of an old mark is "only as an
   * embedded region, page unknown".
   *
   * The two failure modes this pins are the two ends of the migration: reading
   * it as a full grant hands an automatic task a site the user never gave it,
   * and dropping it revokes something the user did give. `{}` is neither.
   */
  it('v51 migration turns a page-less mark into the page-unknown scope', () => {
    const migrated = migrateFrom(
      {
        browserSitePermissions: { 'https://vendor.example.net': 'allowed' },
        browserSiteGrantViaEmbed: { 'https://vendor.example.net': true },
      },
      50,
    );

    expect(migrated.browserSiteGrantViaEmbed)
      .toEqual({ 'https://vendor.example.net': {} });
  });

  it('v51 migration leaves an already-scoped map alone', () => {
    const migrated = migrateFrom(
      {
        browserSitePermissions: { 'https://vendor.example.net': 'allowed' },
        browserSiteGrantViaEmbed: { 'https://vendor.example.net': { [OA]: true } },
      },
      50,
    );

    expect(migrated.browserSiteGrantViaEmbed)
      .toEqual({ 'https://vendor.example.net': { [OA]: true } });
  });

  /**
   * The read-back the migration exists for: a migrated store must answer the
   * gate's questions the way the口径 says. Read through `getSiteVerdict`, the
   * one function both shapes go through, so this cannot pass by agreeing with
   * a second implementation.
   */
  it('a migrated grant reads as a region grant anywhere, and never as a page grant', () => {
    const migrated = migrateFrom(
      {
        browserSitePermissions: { 'https://vendor.example.net': 'allowed' },
        browserSiteGrantViaEmbed: { 'https://vendor.example.net': true },
      },
      50,
    );
    const perms = migrated.browserSitePermissions as Record<string, 'allowed' | 'denied'>;
    const scopes = migrated.browserSiteGrantViaEmbed as BrowserSiteGrantScopes;
    const verdictIn = (embeddedIn: string | null) =>
      getSiteVerdict('https://vendor.example.net', perms, { viaEmbed: scopes, embeddedIn });

    expect({
      insideSomePage: verdictIn(OA),
      insideAnotherPage: verdictIn(PORTAL),
      asThePage: verdictIn(null),
    }).toEqual({
      insideSomePage: 'allowed',
      insideAnotherPage: 'allowed',
      asThePage: 'default',
    });
  });
});

describe('settingsStore labs flags', () => {
  beforeEach(() => {
    useSettingsStore.setState({ labs: {} });
  });

  it('setLabsFlag records an opt-in without clobbering other flags', () => {
    useSettingsStore.getState().setLabsFlag('todos-inbox', true);
    useSettingsStore.getState().setLabsFlag('other-exp', false);
    expect(useSettingsStore.getState().labs).toEqual({
      'todos-inbox': true,
      'other-exp': false,
    });
  });

  it('setLabsFlag can flip a flag back off', () => {
    useSettingsStore.getState().setLabsFlag('todos-inbox', true);
    useSettingsStore.getState().setLabsFlag('todos-inbox', false);
    expect(useSettingsStore.getState().labs['todos-inbox']).toBe(false);
  });

  describe('v35 migration', () => {
    const getMigrate = () =>
      (useSettingsStore as unknown as {
        persist: { getOptions: () => { migrate: (data: unknown, version: number) => Record<string, unknown> } };
      }).persist.getOptions().migrate;

    it('adds an empty labs map for pre-v35 state that lacks it', () => {
      const migrated = getMigrate()({ theme: 'dark' }, 34);
      expect(migrated.labs).toEqual({});
    });

    it('preserves an existing labs map', () => {
      const migrated = getMigrate()({ labs: { 'todos-inbox': true } }, 34);
      expect(migrated.labs).toEqual({ 'todos-inbox': true });
    });

    it('replaces a malformed labs value with an empty map', () => {
      const migrated = getMigrate()({ labs: ['bad'] }, 34);
      expect(migrated.labs).toEqual({});
    });
  });

  describe('v38 migration', () => {
    const getMigrate = () =>
      (useSettingsStore as unknown as {
        persist: { getOptions: () => { migrate: (data: unknown, version: number) => Record<string, unknown> } };
      }).persist.getOptions().migrate;

    it('sets labs.pet=true when petOpen was true on upgrade from v37', () => {
      const migrated = getMigrate()({ petOpen: true, labs: {} }, 37);
      expect((migrated.labs as Record<string, boolean>)['pet']).toBe(true);
    });

    it('does NOT set labs.pet when petOpen was false on upgrade from v37', () => {
      const migrated = getMigrate()({ petOpen: false, labs: {} }, 37);
      expect((migrated.labs as Record<string, boolean>)['pet']).toBeUndefined();
    });

    it('creates labs map if absent and petOpen was true', () => {
      const migrated = getMigrate()({ petOpen: true }, 37);
      expect((migrated.labs as Record<string, boolean>)['pet']).toBe(true);
    });

    it('preserves existing labs flags while adding pet unlock', () => {
      const migrated = getMigrate()({ petOpen: true, labs: { 'todos-inbox': true } }, 37);
      const labs = migrated.labs as Record<string, boolean>;
      expect(labs['pet']).toBe(true);
      expect(labs['todos-inbox']).toBe(true);
    });
  });

  describe('v42 migration (one-time theme reset to light)', () => {
    const getMigrate = () =>
      (useSettingsStore as unknown as {
        persist: { getOptions: () => { migrate: (data: unknown, version: number) => Record<string, unknown> } };
      }).persist.getOptions().migrate;

    it('resets a persisted dark theme to light on upgrade from v41', () => {
      // Pre-fix users had 'dark' persisted from the old default, even if they
      // never opened theme settings — the whole point of this migration.
      const migrated = getMigrate()({ theme: 'dark' }, 41);
      expect(migrated.theme).toBe('light');
    });

    it('also resets an explicit system choice to light (accepted trade-off)', () => {
      const migrated = getMigrate()({ theme: 'system' }, 41);
      expect(migrated.theme).toBe('light');
    });

    it('materializes theme to light even when the field was absent', () => {
      const migrated = getMigrate()({}, 41);
      expect(migrated.theme).toBe('light');
    });

    it('does NOT re-run for users already at v42 (dark re-choice sticks)', () => {
      const migrated = getMigrate()({ theme: 'dark' }, 42);
      expect(migrated.theme).toBe('dark');
    });
  });

  describe('v46/v47 migration (operation-class browser policy + unattended master switch)', () => {
    const getMigrate = () =>
      (useSettingsStore as unknown as {
        persist: { getOptions: () => { migrate: (data: unknown, version: number) => Record<string, unknown> } };
      }).persist.getOptions().migrate;

    it('adds the default operation-class policy for pre-v46 state that lacks it', () => {
      const migrated = getMigrate()({ theme: 'light' }, 45);
      expect(migrated.browserOperationPolicy).toEqual({
        readOnly: 'allow', interactive: 'allow', scripting: 'ask', upload: 'ask',
      });
    });

    /**
     * V52. An install that already carries a heartbeat plugin was binding
     * 0.0.0.0 without ever being asked; the upgrade must CLOSE that listener,
     * not grandfather it — so the default is false for every existing store.
     */
    it('defaults the LAN webhook opt-in to false, including for a store that predates the field', () => {
      expect(getMigrate()({ theme: 'light' }, 45).imChannel).toEqual({ allowLanWebhook: false });
      expect(getMigrate()({ imChannel: {} }, 49).imChannel).toEqual({ allowLanWebhook: false });
      expect(getMigrate()({ imChannel: { allowLanWebhook: 'yes' } }, 49).imChannel).toEqual({ allowLanWebhook: false });
      expect(getMigrate()({ imChannel: null }, 49).imChannel).toEqual({ allowLanWebhook: false });
    });

    it('keeps an explicit LAN webhook opt-in and any sibling field beside it', () => {
      const migrated = getMigrate()({ imChannel: { allowLanWebhook: true, other: 1 } }, 49);
      expect(migrated.imChannel).toEqual({ allowLanWebhook: true, other: 1 });
    });

    /**
     * The gap this port has to close: the field was authored against v50, but
     * dev shipped v51 first, so it lands at v52. A store written by the
     * released v51 build has never seen `imChannel` and must still have the
     * listener closed on upgrade — a migration left at `version < 51` would
     * skip it and leave 0.0.0.0 bound.
     */
    it('closes the LAN listener for a store persisted by the released v51 build', () => {
      expect(getMigrate()({ theme: 'light' }, 51).imChannel).toEqual({ allowLanWebhook: false });
    });

    it('defaults the unattended master switch to false — fail-safe, no silent grant', () => {
      const migrated = getMigrate()({ theme: 'light' }, 45);
      expect(migrated.allowUnattendedBrowser).toBe(false);
    });

    /**
     * V47, the 2026-09-04 column collapse. Every installed copy carries the
     * two-column shape, and the surviving values are the ATTENDED column's:
     * that is where the user said what Abu may do. Taking the other column
     * instead would be a silent, invisible change to a permission — which is
     * why this is pinned in BOTH directions below.
     */
    it('collapses a v46 two-column policy onto its attended column', () => {
      const migrated = getMigrate()(
        {
          browserOperationPolicy: {
            attended: { readOnly: 'allow', interactive: 'ask', scripting: 'ask' },
            unattended: { readOnly: 'allow', interactive: 'deny', scripting: 'deny' },
          },
          allowUnattendedBrowser: true,
        },
        46,
      );
      expect(migrated.browserOperationPolicy).toEqual({
        readOnly: 'allow', interactive: 'ask', scripting: 'ask', upload: 'ask',
      });
      expect(migrated.allowUnattendedBrowser).toBe(true);
    });

    it('does not let an unattended-only value survive the collapse', () => {
      const migrated = getMigrate()(
        {
          browserOperationPolicy: {
            attended: { readOnly: 'ask', interactive: 'deny', scripting: 'deny' },
            unattended: { readOnly: 'allow', interactive: 'allow', scripting: 'allow' },
          },
        },
        46,
      );
      expect(migrated.browserOperationPolicy).toEqual({
        readOnly: 'ask', interactive: 'deny', scripting: 'deny', upload: 'ask',
      });
    });

    it('preserves an already-collapsed policy rather than overwriting it', () => {
      const customPolicy = { readOnly: 'allow', interactive: 'ask', scripting: 'ask' };
      const migrated = getMigrate()(
        { browserOperationPolicy: customPolicy, allowUnattendedBrowser: true },
        45,
      );
      // V50 adds the upload row and nothing else: the three the user set are
      // untouched, and the new one arrives at its reviewed default.
      expect(migrated.browserOperationPolicy).toEqual({ ...customPolicy, upload: 'ask' });
      expect(migrated.allowUnattendedBrowser).toBe(true);
    });

    it('does NOT re-run the v47 collapse for users already at v47 — but does add the v50 upload row', () => {
      const customPolicy = { readOnly: 'allow', interactive: 'deny', scripting: 'deny' };
      const migrated = getMigrate()(
        { browserOperationPolicy: customPolicy, allowUnattendedBrowser: true },
        47,
      );
      expect(migrated.browserOperationPolicy).toEqual({ ...customPolicy, upload: 'ask' });
      expect(migrated.allowUnattendedBrowser).toBe(true);
    });

    /**
     * T5 — the upgrade path a real install takes. Nobody gains a capability:
     * the row's most permissive reachable value is 「每次询问」, and an
     * automatic run is refused whatever it says.
     */
    it('adds the upload row as ask for a v49 store that predates it, leaving the others alone', () => {
      const migrated = getMigrate()(
        {
          browserOperationPolicy: { readOnly: 'allow', interactive: 'allow', scripting: 'allow' },
          allowUnattendedBrowser: true,
        },
        49,
      );
      expect(migrated.browserOperationPolicy).toEqual({
        readOnly: 'allow', interactive: 'allow', scripting: 'allow', upload: 'ask',
      });
    });

    // I3 (runtime shape validation): a PRESENT-but-malformed policy — e.g.
    // from hand-edited localStorage, or a future bug that wrote a partial
    // object — must be clamped to the strictest state per row, not passed
    // through as-is (which is exactly what the "preserves an already-
    // collapsed policy" test above verifies for a WELL-FORMED policy).
    it('normalizes a present-but-malformed policy to the strictest row instead of passing it through', () => {
      const migrated = getMigrate()({
        browserOperationPolicy: {
          attended: { readOnly: 'allow' /* interactive, scripting missing */ },
          unattended: { readOnly: 'allow', interactive: 'not-a-real-state', scripting: 'deny' },
        },
      }, 45);
      expect(migrated.browserOperationPolicy).toEqual({
        readOnly: 'allow', interactive: 'ask', scripting: 'ask', upload: 'ask',
      });
    });

    it('coerces a non-boolean allowUnattendedBrowser to false — fail-safe, never silently truthy', () => {
      const migrated = getMigrate()({ allowUnattendedBrowser: 'true' }, 45);
      expect(migrated.allowUnattendedBrowser).toBe(false);
    });
  });

  describe('v39 migration', () => {
    const getMigrate = () =>
      (useSettingsStore as unknown as {
        persist: { getOptions: () => { migrate: (data: unknown, version: number) => Record<string, unknown> } };
      }).persist.getOptions().migrate;

    it('explicitly adds declaredCapabilities key (as undefined) to providers lacking it', () => {
      const provider = { id: 'openai', name: 'OpenAI', enabled: true };
      const migrated = getMigrate()({ providers: [provider] }, 38);
      const providers = migrated.providers as Array<Record<string, unknown>>;
      expect(providers).toHaveLength(1);
      expect(providers[0].id).toBe('openai');
      // Migration must explicitly set the key to undefined so downstream code
      // can use `'declaredCapabilities' in p` to distinguish "migrated" from "new"
      expect('declaredCapabilities' in providers[0]).toBe(true);
      expect(providers[0].declaredCapabilities).toBeUndefined();
    });

    it('does not overwrite an existing declaredCapabilities field', () => {
      const caps = { streaming: true };
      const provider = { id: 'openai', name: 'OpenAI', declaredCapabilities: caps };
      const migrated = getMigrate()({ providers: [provider] }, 38);
      const providers = migrated.providers as Array<Record<string, unknown>>;
      expect(providers[0].declaredCapabilities).toEqual(caps);
    });

    it('handles missing providers array gracefully', () => {
      const migrated = getMigrate()({ theme: 'dark' }, 38);
      expect(migrated.providers).toBeUndefined();
    });
  });

  describe('v40 migration (sink declaredCapabilities to per-model)', () => {
    const getMigrate = () =>
      (useSettingsStore as unknown as {
        persist: { getOptions: () => { migrate: (data: unknown, version: number) => Record<string, unknown> } };
      }).persist.getOptions().migrate;

    it('copies provider-level model-varying fields down onto each model', () => {
      const migrate = getMigrate();
      const result = migrate(
        {
          providers: [
            {
              id: 'p1', models: [{ id: 'a', label: 'a' }, { id: 'b', label: 'b' }],
              declaredCapabilities: { supportsImages: true, maxInputTokens: 65536, useRawUrl: true },
            },
          ],
        },
        39,
      ) as { providers: Array<{ declaredCapabilities?: Record<string, unknown>; models: Array<{ declaredCapabilities?: Record<string, unknown> }> }> };
      for (const m of result.providers[0].models) {
        expect(m.declaredCapabilities?.supportsImages).toBe(true);
        expect(m.declaredCapabilities?.maxInputTokens).toBe(65536);
        expect(m.declaredCapabilities?.useRawUrl).toBeUndefined(); // endpoint field NOT copied
      }
      expect(result.providers[0].declaredCapabilities?.useRawUrl).toBe(true); // provider-level intact
    });
    it('does not clobber a model that already has its own override', () => {
      const migrate = getMigrate();
      const result = migrate(
        { providers: [{ id: 'p1', models: [{ id: 'a', label: 'a', declaredCapabilities: { supportsImages: false } }], declaredCapabilities: { supportsImages: true } }] },
        39,
      ) as { providers: Array<{ models: Array<{ declaredCapabilities?: Record<string, unknown> }> }> };
      expect(result.providers[0].models[0].declaredCapabilities?.supportsImages).toBe(false);
    });
    it('handles providers/models without declared or without arrays gracefully', () => {
      const migrate = getMigrate();
      expect(() => migrate({ providers: [{ id: 'b', models: [] }] }, 39)).not.toThrow();
      expect(() => migrate({}, 39)).not.toThrow();
    });
  });

  describe('v41 migration (image generation becomes an independent config, "C-a")', () => {
    const getMigrate = () =>
      (useSettingsStore as unknown as {
        persist: { getOptions: () => { migrate: (data: unknown, version: number) => Record<string, unknown> } };
      }).persist.getOptions().migrate;

    it('leaves providers/models untouched', () => {
      const migrate = getMigrate();
      const input = {
        providers: [
          { id: 'p1', models: [{ id: 'a', label: 'a' }], enabled: true },
        ],
      };
      const migrated = migrate(input, 40);
      expect(migrated.providers).toEqual(input.providers);
    });

    it('initializes an empty imageGeneration container when there is no legacy form', () => {
      const migrate = getMigrate();
      const migrated = migrate({ providers: [] }, 40) as { imageGeneration: { backends: unknown[]; defaultId?: string } };
      expect(migrated.imageGeneration).toEqual({ backends: [], defaultId: undefined });
    });

    it('migrates a configured legacy auxiliaryServices.imageGen into a backend and sets it default', () => {
      const migrate = getMigrate();
      const input = {
        providers: [],
        auxiliaryServices: { imageGen: { apiKey: 'k', baseUrl: 'http://x', model: 'dall-e-3' } },
      };
      const migrated = migrate(input, 40) as {
        imageGeneration: { backends: Array<Record<string, unknown>>; defaultId?: string };
        auxiliaryServices: { imageGen?: unknown };
        pendingImageGenSecretBridge?: string;
      };
      expect(migrated.imageGeneration.backends).toHaveLength(1);
      const backend = migrated.imageGeneration.backends[0];
      expect(backend.vendor).toBe('custom');
      expect(backend.baseUrl).toBe('http://x');
      expect(backend.model).toBe('dall-e-3');
      expect(backend.apiKey).toBe('k');
      expect(migrated.imageGeneration.defaultId).toBe(backend.id);
      // Old field cleared — data moved, not duplicated.
      expect(migrated.auxiliaryServices.imageGen).toBeUndefined();
      // Marker for bootstrapSecrets to bridge the encrypted aux:imageGen
      // secret onto the new backend's own secret-store key.
      expect(migrated.pendingImageGenSecretBridge).toBe(backend.id);
    });

    it('infers the vendor from a recognizable legacy baseUrl instead of hardcoding "custom" (F5 regression)', () => {
      // Regression: the migration used to hardcode vendor:'custom' for every
      // migrated backend, so a Volcengine Seedream legacy config lost its
      // vendor-specific size floor (normalizeSeedreamSize) until the user
      // manually re-saved the backend, causing a 400 on the very first
      // post-upgrade generate_image call.
      const migrate = getMigrate();
      const input = {
        providers: [],
        auxiliaryServices: { imageGen: { apiKey: 'k', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seedream-4-5' } },
      };
      const migrated = migrate(input, 40) as {
        imageGeneration: { backends: Array<Record<string, unknown>> };
      };
      expect(migrated.imageGeneration.backends[0].vendor).toBe('volcengine');
    });

    it('falls back to "custom" when the legacy baseUrl does not match a known vendor host', () => {
      const migrate = getMigrate();
      const input = {
        providers: [],
        auxiliaryServices: { imageGen: { apiKey: 'k', baseUrl: 'https://gateway.internal.example.com/v1', model: 'some-model' } },
      };
      const migrated = migrate(input, 40) as {
        imageGeneration: { backends: Array<Record<string, unknown>> };
      };
      expect(migrated.imageGeneration.backends[0].vendor).toBe('custom');
    });

    it('does not create a backend when the legacy form was never actually configured (no baseUrl/model)', () => {
      const migrate = getMigrate();
      const input = {
        providers: [],
        auxiliaryServices: { imageGen: { apiKey: '', baseUrl: '', model: '' } },
      };
      const migrated = migrate(input, 40) as { imageGeneration: { backends: unknown[] } };
      expect(migrated.imageGeneration.backends).toHaveLength(0);
    });

    it('handles missing providers/auxiliaryServices gracefully', () => {
      const migrate = getMigrate();
      expect(() => migrate({}, 40)).not.toThrow();
    });

    it('migrates legacy FLAT imageGen fields from a v13 blob across the full chain (V41 must run AFTER V14)', () => {
      // Regression for the descending-order ordering bug: a user persisted at
      // version 13 only has the pre-V14 flat fields (imageGenApiKey/...). V14
      // builds auxiliaryServices.imageGen from them; V41 (now placed last) must
      // see that and produce a backend. When V41 ran first, it read an undefined
      // auxiliaryServices and silently dropped the config → empty backends.
      const migrate = getMigrate();
      const input = {
        imageGenApiKey: 'sk-flat',
        imageGenBaseUrl: 'https://api.openai.com',
        imageGenModel: 'dall-e-3',
      };
      const migrated = migrate(input, 13) as {
        imageGeneration: { backends: Array<Record<string, unknown>>; defaultId?: string };
      };
      expect(migrated.imageGeneration.backends).toHaveLength(1);
      const backend = migrated.imageGeneration.backends[0];
      expect(backend.baseUrl).toBe('https://api.openai.com');
      expect(backend.model).toBe('dall-e-3');
      expect(migrated.imageGeneration.defaultId).toBe(backend.id);
    });
  });
});

describe('imageGeneration backend actions', () => {
  beforeEach(() => {
    useSettingsStore.setState({ imageGeneration: { backends: [], defaultId: undefined } });
  });

  const draft = (overrides: Partial<Omit<ImageGenBackend, 'id'>> = {}) => ({
    name: 'Volcengine Seedream',
    vendor: 'volcengine' as const,
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    apiKey: 'sk-test',
    model: 'doubao-seedream-4-5',
    ...overrides,
  });

  describe('addImageGenBackend', () => {
    it('adds a backend and auto-selects it as default when it is the first one', () => {
      const id = useSettingsStore.getState().addImageGenBackend(draft());
      const { backends, defaultId } = useSettingsStore.getState().imageGeneration;
      expect(backends).toHaveLength(1);
      expect(backends[0].id).toBe(id);
      expect(defaultId).toBe(id);
    });

    it('does not change the default when a second backend is added', () => {
      const firstId = useSettingsStore.getState().addImageGenBackend(draft());
      useSettingsStore.getState().addImageGenBackend(draft({ name: 'DALL-E', vendor: 'openai', baseUrl: 'https://api.openai.com', model: 'dall-e-3' }));
      expect(useSettingsStore.getState().imageGeneration.defaultId).toBe(firstId);
      expect(useSettingsStore.getState().imageGeneration.backends).toHaveLength(2);
    });

    it('trims whitespace from baseUrl and apiKey', () => {
      useSettingsStore.getState().addImageGenBackend(draft({ baseUrl: '  https://x.example.com  ', apiKey: '  key  ' }));
      const backend = useSettingsStore.getState().imageGeneration.backends[0];
      expect(backend.baseUrl).toBe('https://x.example.com');
      expect(backend.apiKey).toBe('key');
    });
  });

  describe('updateImageGenBackend', () => {
    it('patches an existing backend by id', () => {
      const id = useSettingsStore.getState().addImageGenBackend(draft());
      useSettingsStore.getState().updateImageGenBackend(id, { name: 'Renamed', model: 'doubao-seedream-4-0' });
      const backend = useSettingsStore.getState().imageGeneration.backends[0];
      expect(backend.name).toBe('Renamed');
      expect(backend.model).toBe('doubao-seedream-4-0');
      expect(backend.baseUrl).toBe(draft().baseUrl); // untouched fields preserved
    });
  });

  describe('removeImageGenBackend', () => {
    it('removes the backend and falls back the default to a remaining backend', () => {
      const firstId = useSettingsStore.getState().addImageGenBackend(draft());
      const secondId = useSettingsStore.getState().addImageGenBackend(draft({ name: 'Second' }));
      useSettingsStore.getState().removeImageGenBackend(firstId);
      const { backends, defaultId } = useSettingsStore.getState().imageGeneration;
      expect(backends.map((b) => b.id)).toEqual([secondId]);
      expect(defaultId).toBe(secondId);
    });

    it('clears defaultId when the last backend is removed', () => {
      const id = useSettingsStore.getState().addImageGenBackend(draft());
      useSettingsStore.getState().removeImageGenBackend(id);
      const { backends, defaultId } = useSettingsStore.getState().imageGeneration;
      expect(backends).toHaveLength(0);
      expect(defaultId).toBeUndefined();
    });

    it('leaves the default alone when removing a non-default backend', () => {
      const firstId = useSettingsStore.getState().addImageGenBackend(draft());
      const secondId = useSettingsStore.getState().addImageGenBackend(draft({ name: 'Second' }));
      useSettingsStore.getState().removeImageGenBackend(secondId);
      expect(useSettingsStore.getState().imageGeneration.defaultId).toBe(firstId);
    });
  });

  describe('setDefaultImageBackend', () => {
    it('switches the default to a different configured backend', () => {
      useSettingsStore.getState().addImageGenBackend(draft());
      const secondId = useSettingsStore.getState().addImageGenBackend(draft({ name: 'Second' }));
      useSettingsStore.getState().setDefaultImageBackend(secondId);
      expect(useSettingsStore.getState().imageGeneration.defaultId).toBe(secondId);
    });
  });
});

describe('getDefaultImageBackend', () => {
  function backend(id: string, overrides: Partial<ImageGenBackend> = {}): ImageGenBackend {
    return { id, name: id, vendor: 'custom', baseUrl: 'https://x.example.com', apiKey: '', model: 'm', ...overrides };
  }

  it('returns null when no backends are configured', () => {
    useSettingsStore.setState({ imageGeneration: { backends: [], defaultId: undefined } });
    expect(getDefaultImageBackend(useSettingsStore.getState())).toBeNull();
  });

  it('returns the backend matching defaultId', () => {
    useSettingsStore.setState({
      imageGeneration: { backends: [backend('a'), backend('b')], defaultId: 'b' },
    });
    expect(getDefaultImageBackend(useSettingsStore.getState())?.id).toBe('b');
  });

  it('falls back to backends[0] when defaultId is unset', () => {
    useSettingsStore.setState({
      imageGeneration: { backends: [backend('a'), backend('b')], defaultId: undefined },
    });
    expect(getDefaultImageBackend(useSettingsStore.getState())?.id).toBe('a');
  });

  it('falls back to backends[0] when defaultId points at a removed backend', () => {
    useSettingsStore.setState({
      imageGeneration: { backends: [backend('a'), backend('b')], defaultId: 'nonexistent' },
    });
    expect(getDefaultImageBackend(useSettingsStore.getState())?.id).toBe('a');
  });
});

describe('getUsableImageBackend (F1 regression — zero-config OpenAI fallback)', () => {
  beforeEach(() => {
    useSettingsStore.setState({ imageGeneration: { backends: [], defaultId: undefined } });
  });

  it('returns the explicit backend when one is configured, ignoring the active provider', () => {
    const explicitBackend: ImageGenBackend = {
      id: 'explicit', name: 'Custom', vendor: 'custom', baseUrl: 'https://gateway.example.com', apiKey: 'sk-explicit', model: 'my-model',
    };
    useSettingsStore.setState({
      imageGeneration: { backends: [explicitBackend], defaultId: 'explicit' },
      providers: [makeProvider({ id: 'p1', enabled: true, apiFormat: 'openai-compatible', apiKey: 'sk-provider' })],
      activeModel: { providerId: 'p1', modelId: 'm1' },
    });
    const backend = getUsableImageBackend(useSettingsStore.getState());
    expect(backend?.id).toBe('explicit');
    expect(backend?.apiKey).toBe('sk-explicit');
  });

  it('synthesizes a DALL-E 3 backend from the active OpenAI-compatible provider when no backend is configured', () => {
    // Regression: the refactor to independent imageGeneration.backends hard-required
    // an explicit backend and dropped this zero-config fallback — a user who never
    // touched Settings → Image Generation but has an OpenAI-compatible provider
    // active used to be able to generate images for free (v0.29.0 behavior).
    useSettingsStore.setState({
      providers: [makeProvider({ id: 'openai', enabled: true, apiFormat: 'openai-compatible', apiKey: 'sk-live-key' })],
      activeModel: { providerId: 'openai', modelId: 'gpt-4o' },
    });
    const backend = getUsableImageBackend(useSettingsStore.getState());
    expect(backend).not.toBeNull();
    expect(backend?.apiKey).toBe('sk-live-key');
    expect(backend?.model).toBe('dall-e-3');
    expect(backend?.baseUrl).toBe('https://api.openai.com');
    expect(backend?.vendor).toBe('openai');
  });

  it('returns null when the active provider is not openai-compatible (e.g. native anthropic)', () => {
    useSettingsStore.setState({
      providers: [makeProvider({ id: 'anthropic', enabled: true, apiFormat: 'anthropic', apiKey: 'sk-ant' })],
      activeModel: { providerId: 'anthropic', modelId: 'claude-x' },
    });
    expect(getUsableImageBackend(useSettingsStore.getState())).toBeNull();
  });

  it('returns null when the active openai-compatible provider has no API key', () => {
    useSettingsStore.setState({
      providers: [makeProvider({ id: 'openai', enabled: true, apiFormat: 'openai-compatible', apiKey: '' })],
      activeModel: { providerId: 'openai', modelId: 'gpt-4o' },
    });
    expect(getUsableImageBackend(useSettingsStore.getState())).toBeNull();
  });
});

describe('bootstrapSecrets — pendingImageGenSecretBridge marker (F2 regression)', () => {
  const invokeMock = vi.mocked(invoke);

  beforeEach(() => {
    invokeMock.mockReset();
    useSettingsStore.setState({
      providers: [],
      auxiliaryServices: {},
      imageGeneration: {
        backends: [{ id: 'bk1', name: 'Migrated', vendor: 'custom', baseUrl: 'https://api.openai.com', apiKey: '', model: 'dall-e-3' }],
        defaultId: 'bk1',
      },
      pendingImageGenSecretBridge: 'bk1',
    });
  });

  it('preserves the marker when the legacy aux:imageGen secret resolves to null (transient decrypt failure), even though unrelated backfills round-trip cleanly', async () => {
    // Regression: `imageGenSecret` being null (not thrown) used to still let
    // `backfillOk` stay true, which unconditionally cleared the marker even
    // though the bridge itself never ran — orphaning the migrated backend's
    // key forever (V41 never re-runs since the store version is already 41).
    invokeMock.mockImplementation(async (cmd: unknown) => {
      if (cmd === 'secret_get') return null;
      if (cmd === 'secret_set') return undefined;
      if (cmd === 'secret_failed_keys') return [];
      return undefined;
    });

    await bootstrapSecrets();

    expect(useSettingsStore.getState().pendingImageGenSecretBridge).toBe('bk1');
    expect(useSettingsStore.getState().imageGeneration.backends[0].apiKey).toBe('');
  });

  it('clears the marker once the bridge actually runs and its write round-trips', async () => {
    invokeMock.mockImplementation(async (cmd: unknown, args?: unknown) => {
      if (cmd === 'secret_get') {
        const key = (args as { key?: string } | undefined)?.key;
        if (key === 'aux:imageGen') return 'sk-legacy-bridged';
        return null;
      }
      if (cmd === 'secret_set') return undefined;
      if (cmd === 'secret_failed_keys') return [];
      return undefined;
    });

    await bootstrapSecrets();

    expect(useSettingsStore.getState().pendingImageGenSecretBridge).toBeUndefined();
    expect(useSettingsStore.getState().imageGeneration.backends[0].apiKey).toBe('sk-legacy-bridged');
  });

  it('clears the marker when the backend already has its own secret, even if the legacy secret never resolves', async () => {
    invokeMock.mockImplementation(async (cmd: unknown, args?: unknown) => {
      if (cmd === 'secret_get') {
        const key = (args as { key?: string } | undefined)?.key;
        if (key === 'imagegen:bk1') return 'sk-own-secret';
        return null;
      }
      if (cmd === 'secret_set') return undefined;
      if (cmd === 'secret_failed_keys') return [];
      return undefined;
    });

    await bootstrapSecrets();

    expect(useSettingsStore.getState().pendingImageGenSecretBridge).toBeUndefined();
    expect(useSettingsStore.getState().imageGeneration.backends[0].apiKey).toBe('sk-own-secret');
  });
});

describe('bootstrapSecrets — orphaned imagegen:<id> secret sweep', () => {
  const invokeMock = vi.mocked(invoke);

  beforeEach(() => {
    invokeMock.mockReset();
    useSettingsStore.setState({
      providers: [],
      auxiliaryServices: {},
      imageGeneration: {
        backends: [{ id: 'bk1', name: 'Live', vendor: 'volcengine', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', apiKey: '', model: 'doubao-seedream-4-5' }],
        defaultId: 'bk1',
      },
      pendingImageGenSecretBridge: undefined,
    });
  });

  function mockSecretHost(listResult: string[] | null | (() => never), deleted: string[]) {
    invokeMock.mockImplementation(async (cmd: unknown, args?: unknown) => {
      if (cmd === 'secret_get') return null;
      if (cmd === 'secret_set') return undefined;
      if (cmd === 'secret_failed_keys') return [];
      if (cmd === 'secret_list') {
        if (typeof listResult === 'function') return listResult();
        return listResult;
      }
      if (cmd === 'secret_delete') {
        deleted.push((args as { key: string }).key);
        return undefined;
      }
      return undefined;
    });
  }

  it('deletes imagegen:<id> keys with no matching backend, keeping live backends, provider keys, and aux:imageGen', async () => {
    // The 7-orphan scenario: historical V41 re-runs each minted a fresh
    // random backend id and bridged the legacy secret onto it, leaving the
    // previous ids' secrets behind with nothing referencing them.
    const deleted: string[] = [];
    mockSecretHost(
      ['imagegen:bk1', 'imagegen:dead1', 'imagegen:dead2', 'provider:p1', 'aux:imageGen', 'aux:webSearch'],
      deleted,
    );

    await bootstrapSecrets();

    expect(deleted.sort()).toEqual(['imagegen:dead1', 'imagegen:dead2']);
  });

  it('does nothing when secret_list returns null (Windows/Linux keyring has no enumeration API)', async () => {
    const deleted: string[] = [];
    mockSecretHost(null, deleted);

    await bootstrapSecrets();

    expect(deleted).toEqual([]);
  });

  it('still deletes the remaining orphans when one delete rejects (allSettled, not all)', async () => {
    const deleted: string[] = [];
    invokeMock.mockImplementation(async (cmd: unknown, args?: unknown) => {
      if (cmd === 'secret_get') return null;
      if (cmd === 'secret_set') return undefined;
      if (cmd === 'secret_failed_keys') return [];
      if (cmd === 'secret_list') return ['imagegen:dead1', 'imagegen:dead2'];
      if (cmd === 'secret_delete') {
        const key = (args as { key: string }).key;
        if (key === 'imagegen:dead1') throw new Error('keyring busy');
        deleted.push(key);
        return undefined;
      }
      return undefined;
    });

    await expect(bootstrapSecrets()).resolves.toBeUndefined();
    expect(deleted).toEqual(['imagegen:dead2']);
  });

  it('is non-fatal when the sweep itself throws', async () => {
    const deleted: string[] = [];
    mockSecretHost(() => { throw new Error('secret backend unavailable'); }, deleted);

    await expect(bootstrapSecrets()).resolves.toBeUndefined();
    expect(deleted).toEqual([]);
  });
});

describe('secret write-through failure fallback', () => {
  const invokeMock = vi.mocked(invoke);

  it('re-persists the current key in plaintext when a post-bootstrap encrypted write fails', async () => {
    useSettingsStore.setState({
      providers: [makeProvider({ id: 'p1', apiKey: 'sk-old' })],
      auxiliaryServices: {},
      imageGeneration: { backends: [], defaultId: undefined },
    });
    invokeMock.mockImplementation(async (cmd: unknown) => {
      if (cmd === 'secret_get') return cmd === 'secret_get' ? 'sk-old' : null;
      if (cmd === 'secret_failed_keys') return [];
      if (cmd === 'secret_set') throw new Error('encrypted store unavailable');
      return undefined;
    });

    await bootstrapSecrets();
    const persistApi = (useSettingsStore as unknown as {
      persist: { getOptions: () => { partialize: (state: unknown) => Record<string, unknown> } };
    }).persist;
    const partialize = persistApi.getOptions().partialize;
    expect((partialize(useSettingsStore.getState()).providers as ProviderInstance[])[0].apiKey).toBe('');

    useSettingsStore.getState().updateProvider('p1', { apiKey: 'sk-new' });

    await vi.waitFor(() => {
      expect((partialize(useSettingsStore.getState()).providers as ProviderInstance[])[0].apiKey).toBe('sk-new');
    });
  });
});

describe('failedSecretKeys clearing (decrypt-failed banner)', () => {
  const invokeMock = vi.mocked(invoke);

  beforeEach(() => {
    invokeMock.mockReset();
    useSettingsStore.setState({
      providers: [makeProvider({ id: 'p1' })],
      activeModel: { providerId: 'p1', modelId: 'm1' },
      failedSecretKeys: ['provider:p1'],
    });
  });

  it('clears the marker once updateProvider successfully re-writes the key', async () => {
    invokeMock.mockResolvedValue(null);

    useSettingsStore.getState().updateProvider('p1', { apiKey: 'sk-new' });

    await vi.waitFor(() => {
      expect(useSettingsStore.getState().failedSecretKeys).not.toContain('provider:p1');
    });
  });

  it('keeps the marker when the secret write fails', async () => {
    invokeMock.mockRejectedValue(new Error('encrypted store unavailable'));

    useSettingsStore.getState().updateProvider('p1', { apiKey: 'sk-new' });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useSettingsStore.getState().failedSecretKeys).toContain('provider:p1');
  });

  it('clears the marker when the provider is removed', async () => {
    invokeMock.mockResolvedValue(null);

    useSettingsStore.getState().removeProvider('p1');

    await vi.waitFor(() => {
      expect(useSettingsStore.getState().failedSecretKeys).not.toContain('provider:p1');
    });
  });
});

describe('secretWriteFailedKeys (save-failure feedback)', () => {
  const invokeMock = vi.mocked(invoke);

  beforeEach(() => {
    invokeMock.mockReset();
    useSettingsStore.setState({
      providers: [makeProvider({ id: 'p1' })],
      activeModel: { providerId: 'p1', modelId: 'm1' },
      failedSecretKeys: [],
      secretWriteFailedKeys: [],
    });
  });

  it('marks the key when the secret write fails', async () => {
    invokeMock.mockRejectedValue(new Error('encrypted store unavailable'));

    useSettingsStore.getState().updateProvider('p1', { apiKey: 'sk-new' });

    await vi.waitFor(() => {
      expect(useSettingsStore.getState().secretWriteFailedKeys).toContain('provider:p1');
    });
  });

  it('clears the marker once a later write succeeds', async () => {
    useSettingsStore.setState({ secretWriteFailedKeys: ['provider:p1'] });
    invokeMock.mockResolvedValue(null);

    useSettingsStore.getState().updateProvider('p1', { apiKey: 'sk-new' });

    await vi.waitFor(() => {
      expect(useSettingsStore.getState().secretWriteFailedKeys).not.toContain('provider:p1');
    });
  });

  it('still flips the plaintext fallback on failure (fafSecret behavior preserved)', async () => {
    invokeMock.mockRejectedValue(new Error('encrypted store unavailable'));

    useSettingsStore.getState().updateProvider('p1', { apiKey: 'sk-new' });

    await vi.waitFor(() => {
      expect(useSettingsStore.getState().secretWriteFailedKeys).toContain('provider:p1');
    });
    const persistApi = (useSettingsStore as unknown as {
      persist: { getOptions: () => { partialize: (state: unknown) => Record<string, unknown> } };
    }).persist;
    const partialize = persistApi.getOptions().partialize;
    const persisted = partialize(useSettingsStore.getState()).providers as ProviderInstance[];
    expect(persisted[0].apiKey).toBe('sk-new');
  });
});

// ── Browser site permissions: grant/revoke must reach the persisted payload ──
// Pins that a revoke is not an in-memory-only change: the persist partialize
// must reflect both the grant and the removal, so a normally-quit app comes
// back with exactly what the user last saw in Settings.
describe('browserSitePermissions persistence', () => {
  beforeEach(() => {
    useSettingsStore.setState({ browserSitePermissions: {} });
  });

  function persistedSitePermissions(): Record<string, string> {
    const persistApi = (useSettingsStore as unknown as {
      persist: { getOptions: () => { partialize: (state: unknown) => Record<string, unknown> } };
    }).persist;
    const partialize = persistApi.getOptions().partialize;
    return partialize(useSettingsStore.getState()).browserSitePermissions as Record<string, string>;
  }

  it('a granted site appears in the persisted payload', () => {
    useSettingsStore.getState().setBrowserSitePermission('https://example.com', 'allowed');
    expect(persistedSitePermissions()).toEqual({ 'https://example.com': 'allowed' });
  });

  it('a revoked site disappears from the persisted payload', () => {
    useSettingsStore.getState().setBrowserSitePermission('https://example.com', 'allowed');
    useSettingsStore.getState().removeBrowserSitePermission('https://example.com');
    expect(persistedSitePermissions()).toEqual({});
  });
});

describe('default activeModel stays in the curated list', () => {
  // The curated-list refresh for v0.41.0 retired claude-sonnet-4-6 while the
  // store's fresh-install default still named it. Nothing validates membership
  // at runtime (reconcileActiveProvider only checks the provider), and the
  // AddProviderModal self-heal is skipped when another provider was enabled
  // first — so a stale default rides a fresh install's first request. This
  // pins default ∈ curated list so the next refresh cannot recreate the gap.
  it('names a model that exists in the default provider config', async () => {
    const { PROVIDER_CONFIGS } = await import('@/utils/providerConfigs');
    // getInitialState: earlier tests in this file legitimately mutate the
    // live store; the fresh-install default is what this contract is about.
    const { activeModel } = useSettingsStore.getInitialState();
    const provider = PROVIDER_CONFIGS[activeModel.providerId as keyof typeof PROVIDER_CONFIGS];
    expect(provider).toBeDefined();
    expect(provider.models.map((m) => m.id)).toContain(activeModel.modelId);
  });
});
