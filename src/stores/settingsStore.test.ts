import { describe, it, expect, beforeEach } from 'vitest';
import { reconcileActiveProvider, useSettingsStore } from './settingsStore';
import type { ProviderInstance, ActiveModel } from '@/types/provider';

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

  describe('setAuxiliaryImageGen', () => {
    it('trims whitespace from baseUrl and apiKey', () => {
      useSettingsStore.getState().setAuxiliaryImageGen({
        apiKey: ' imgkey ',
        baseUrl: '  http://img.example.com/ ',
        model: 'dall-e-3',
      });
      const cfg = useSettingsStore.getState().auxiliaryServices.imageGen;
      expect(cfg?.apiKey).toBe('imgkey');
      expect(cfg?.baseUrl).toBe('http://img.example.com/');
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
});
