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
