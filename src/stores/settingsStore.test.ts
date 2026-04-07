import { describe, it, expect } from 'vitest';
import { reconcileActiveProvider } from './settingsStore';
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

    it('force-enables original as last resort when no fallback exists', () => {
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

      // No usable fallback (p2 is disabled) → degrade to force-enable p1
      // so getActiveProvider() always resolves and the send-time guard
      // can route the user to AI Services to add a key.
      expect(state.providers[0].enabled).toBe(true);
      expect(state.activeModel).toEqual({ providerId: 'p1', modelId: 'm1' });
      expect(state.providers[1].enabled).toBe(false); // p2 untouched
    });

    it('does not consider self as fallback (the id !== self guard)', () => {
      // This guards against an edge case where the find predicate could
      // match the current activeProvider if it were enabled+keyed. Since
      // we're in the !enabled branch, this would never hit, but the
      // explicit !== guard makes intent clear.
      const disabledNoKey = makeProvider({
        id: 'p1',
        enabled: false,
        apiKey: '',
      });
      const state = makeState([disabledNoKey], { providerId: 'p1', modelId: 'm1' });

      reconcileActiveProvider(state);

      // Only one provider — degraded force-enable
      expect(state.providers[0].enabled).toBe(true);
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
