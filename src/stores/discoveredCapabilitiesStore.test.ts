// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { useDiscoveredCapsStore } from './discoveredCapabilitiesStore';

describe('discoveredCapabilitiesStore', () => {
  beforeEach(() => {
    useDiscoveredCapsStore.setState({ capabilities: {} });
  });

  describe('recordMaxOutputTokens', () => {
    it('records the limit under provider:model key', () => {
      useDiscoveredCapsStore.getState().recordMaxOutputTokens('openai', 'gpt-3.5-turbo', 4096);
      const got = useDiscoveredCapsStore.getState().get('openai', 'gpt-3.5-turbo');
      expect(got?.maxOutputTokens).toBe(4096);
      expect(got?.source).toBe('error-derived');
      expect(got?.updatedAt).toBeGreaterThan(0);
    });

    it('overwrites previous value for the same model', () => {
      const { recordMaxOutputTokens, get } = useDiscoveredCapsStore.getState();
      recordMaxOutputTokens('openai', 'gpt-4o', 16384);
      recordMaxOutputTokens('openai', 'gpt-4o', 8192);
      expect(get('openai', 'gpt-4o')?.maxOutputTokens).toBe(8192);
    });

    it('keys are scoped per-provider', () => {
      const { recordMaxOutputTokens, get } = useDiscoveredCapsStore.getState();
      recordMaxOutputTokens('openai', 'gpt-4', 4096);
      recordMaxOutputTokens('openrouter', 'gpt-4', 8192);
      expect(get('openai', 'gpt-4')?.maxOutputTokens).toBe(4096);
      expect(get('openrouter', 'gpt-4')?.maxOutputTokens).toBe(8192);
    });

    it('ignores invalid values', () => {
      const { recordMaxOutputTokens, get } = useDiscoveredCapsStore.getState();
      recordMaxOutputTokens('openai', 'gpt-4', 0);
      recordMaxOutputTokens('openai', 'gpt-4', -1);
      recordMaxOutputTokens('openai', 'gpt-4', NaN);
      expect(get('openai', 'gpt-4')).toBeUndefined();
    });
  });

  describe('recordContextWindow', () => {
    it('records context window independently of max_tokens', () => {
      const { recordContextWindow, recordMaxOutputTokens, get } = useDiscoveredCapsStore.getState();
      recordMaxOutputTokens('openai', 'gpt-3.5-turbo', 4096);
      recordContextWindow('openai', 'gpt-3.5-turbo', 16385);
      const got = get('openai', 'gpt-3.5-turbo');
      expect(got?.maxOutputTokens).toBe(4096);
      expect(got?.contextWindow).toBe(16385);
    });

    it('records what the service reported when the window was learned', () => {
      const { recordContextWindow, get } = useDiscoveredCapsStore.getState();
      recordContextWindow('lmstudio', 'qwen3-8b', 6000, 8192);
      const got = get('lmstudio', 'qwen3-8b');
      expect(got?.contextWindow).toBe(6000);
      expect(got?.contextWindowProbe).toBe(8192);
    });

    it('a write without a service value clears the previous one', () => {
      const { recordContextWindow, get } = useDiscoveredCapsStore.getState();
      recordContextWindow('lmstudio', 'qwen3-8b', 6000, 8192);
      recordContextWindow('lmstudio', 'qwen3-8b', 5000);
      const got = get('lmstudio', 'qwen3-8b');
      expect(got?.contextWindow).toBe(5000);
      expect(got).not.toHaveProperty('contextWindowProbe');
    });

    it('the same window with a new service value still updates the service value', () => {
      const { recordContextWindow, get } = useDiscoveredCapsStore.getState();
      recordContextWindow('lmstudio', 'qwen3-8b', 6000, 8192);
      recordContextWindow('lmstudio', 'qwen3-8b', 6000, 16384);
      expect(get('lmstudio', 'qwen3-8b')?.contextWindowProbe).toBe(16384);
    });
  });

  describe('persist migration', () => {
    it('keeps version 1 data as it was', () => {
      const migrate = useDiscoveredCapsStore.persist.getOptions().migrate!;
      const v1 = {
        capabilities: {
          'openai:gpt-4': { contextWindow: 8192, maxOutputTokens: 4096, source: 'error-derived', updatedAt: 1 },
        },
      };
      expect(migrate(structuredClone(v1), 1)).toEqual(v1);
    });
  });

  describe('recordReasoningObserved', () => {
    it('flags a model as reasoning and preserves existing limits', () => {
      const { recordMaxOutputTokens, recordReasoningObserved, get } = useDiscoveredCapsStore.getState();
      recordMaxOutputTokens('bailian', 'mystery-model', 16384);
      recordReasoningObserved('bailian', 'mystery-model');
      const got = get('bailian', 'mystery-model');
      expect(got?.isReasoningModel).toBe(true);
      expect(got?.maxOutputTokens).toBe(16384);
      expect(got?.source).toBe('reasoning-observed');
    });

    it('is idempotent (no churn once flagged)', () => {
      const { recordReasoningObserved, get } = useDiscoveredCapsStore.getState();
      recordReasoningObserved('bailian', 'm');
      const first = get('bailian', 'm')?.updatedAt;
      recordReasoningObserved('bailian', 'm');
      expect(get('bailian', 'm')?.updatedAt).toBe(first);
    });
  });

  describe('clear', () => {
    it('removes all discovered caps', () => {
      const { recordMaxOutputTokens, clear, get } = useDiscoveredCapsStore.getState();
      recordMaxOutputTokens('openai', 'gpt-4', 4096);
      clear();
      expect(get('openai', 'gpt-4')).toBeUndefined();
    });
  });
});
