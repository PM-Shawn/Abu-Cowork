/**
 * Discovered capabilities store — persisted overrides for model limits
 * that the static registry got wrong or doesn't cover.
 *
 * Why this exists:
 *  - KNOWN_MODELS + pattern matching can be stale or imprecise (e.g.
 *    pattern says all gpt-4 has 128k context but gpt-4-0613 only has 8k)
 *  - When the API returns "max_tokens too large: N" or
 *    "maximum context length is N", we know the *real* limit
 *  - Persist it so the next request uses the corrected value instead
 *    of repeating the same mistake
 *
 * Read order at capability resolution:
 *  1. Discovered overrides (this store)  ← highest priority
 *  2. Static KNOWN_MODELS exact match
 *  3. Pattern matching
 *  4. FALLBACK_DEFAULT
 *
 * Source tracking:
 *  - 'error-derived' — extracted from a 400 response
 *  - 'probed' — explicit probe (future: ProbeModel button)
 *
 * Lifetime: persisted to localStorage. Keys never expire — model
 * limits don't change quickly enough to warrant TTL eviction. If a
 * provider does upgrade a model, the new max_tokens / context will
 * still work (we cap *below* the discovered value, never above).
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface DiscoveredCaps {
  maxOutputTokens?: number;
  contextWindow?: number;
  /** Observed emitting reasoning_content though the static registry says non-reasoning. */
  isReasoningModel?: boolean;
  source: 'error-derived' | 'probed' | 'reasoning-observed';
  updatedAt: number;
}

interface DiscoveredCapsState {
  /** Keyed by `${providerId}:${modelId}` */
  capabilities: Record<string, DiscoveredCaps>;
}

interface DiscoveredCapsActions {
  /** Record an observed max_tokens limit from an API error. */
  recordMaxOutputTokens: (providerId: string, modelId: string, limit: number) => void;
  /** Record an observed context window from an API error. */
  recordContextWindow: (providerId: string, modelId: string, window: number) => void;
  /** Record that a model emits reasoning_content despite the registry saying otherwise. */
  recordReasoningObserved: (providerId: string, modelId: string) => void;
  /** Get discovered caps for a model, or undefined if none recorded. */
  get: (providerId: string, modelId: string) => DiscoveredCaps | undefined;
  /** Clear all discovered caps (debug/reset). */
  clear: () => void;
}

export type DiscoveredCapsStore = DiscoveredCapsState & DiscoveredCapsActions;

function makeKey(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`;
}

export const useDiscoveredCapsStore = create<DiscoveredCapsStore>()(
  persist(
    (set, get) => ({
      capabilities: {},

      recordMaxOutputTokens: (providerId, modelId, limit) => {
        if (!Number.isFinite(limit) || limit <= 0) return;
        const key = makeKey(providerId, modelId);
        set((state) => {
          const prev = state.capabilities[key];
          // Skip writes that wouldn't change anything
          if (prev?.maxOutputTokens === limit) return state;
          return {
            capabilities: {
              ...state.capabilities,
              [key]: {
                ...prev,
                maxOutputTokens: limit,
                source: 'error-derived',
                updatedAt: Date.now(),
              },
            },
          };
        });
      },

      recordContextWindow: (providerId, modelId, window) => {
        if (!Number.isFinite(window) || window <= 0) return;
        const key = makeKey(providerId, modelId);
        set((state) => {
          const prev = state.capabilities[key];
          if (prev?.contextWindow === window) return state;
          return {
            capabilities: {
              ...state.capabilities,
              [key]: {
                ...prev,
                contextWindow: window,
                source: 'error-derived',
                updatedAt: Date.now(),
              },
            },
          };
        });
      },

      recordReasoningObserved: (providerId, modelId) => {
        const key = makeKey(providerId, modelId);
        set((state) => {
          const prev = state.capabilities[key];
          if (prev?.isReasoningModel === true) return state;
          return {
            capabilities: {
              ...state.capabilities,
              [key]: {
                ...prev,
                isReasoningModel: true,
                source: 'reasoning-observed',
                updatedAt: Date.now(),
              },
            },
          };
        });
      },

      get: (providerId, modelId) => {
        return get().capabilities[makeKey(providerId, modelId)];
      },

      clear: () => set({ capabilities: {} }),
    }),
    {
      name: 'abu-discovered-caps',
      version: 1,
      partialize: (state) => ({ capabilities: state.capabilities }),
    },
  ),
);
