import { describe, it, expect } from 'vitest';
import {
  resolveCapabilities,
  resolveEffectiveContextWindow,
  computeReasoningParams,
  isReasoningStarvation,
  deriveDeclaredDefaults,
  isKnownModel,
  CONTENT_FLOOR_TOKENS,
} from './modelCapabilities';
import { classifyThinking } from './model-data/classify';

describe('modelCapabilities', () => {
  describe('resolveCapabilities — generated table wired', () => {
    it('resolves opus 4.8 from the generated snapshot (table is wired)', () => {
      const caps = resolveCapabilities('claude-opus-4-8');
      expect(caps.contextWindow).toBe(200000);
      expect(caps.thinking).toBe('anthropic');
      expect(caps.toolResultImages).toBe('native');
    });
  });

  describe('resolveCapabilities — reasoning classification', () => {
    it('classifies qwen3.7-max (dated variant) as a qwen reasoning model with 65536 output', () => {
      const caps = resolveCapabilities('qwen3.7-max-2026-05-17');
      expect(caps.thinking).toBe('qwen');
      expect(caps.maxOutputTokens).toBe(65536);
    });

    it('classifies qwen3-max as a qwen reasoning model', () => {
      expect(resolveCapabilities('qwen3-max').thinking).toBe('qwen');
    });

    it('keeps qwen2.5-72b-instruct as non-reasoning with 8192 output', () => {
      const caps = resolveCapabilities('qwen2.5-72b-instruct');
      expect(caps.thinking).toBe(false);
      expect(caps.maxOutputTokens).toBe(8192);
    });

    it('keeps qwen-max as non-reasoning 8192 (probe-corrected)', () => {
      const caps = resolveCapabilities('qwen-max');
      expect(caps.thinking).toBe(false);
      expect(caps.maxOutputTokens).toBe(8192);
    });

    it('marks deepseek-r1 reasoning as uncontrollable', () => {
      expect(resolveCapabilities('deepseek-r1').thinking).toBe('uncontrollable');
      expect(resolveCapabilities('deepseek-reasoner').thinking).toBe('uncontrollable');
    });

    // Regression: the pattern fallback used /^o[34]/ and silently missed o1/o2/o5,
    // diverging from classifyThinking's /^o[1-9]/. An unknown o-series model (not yet
    // in the snapshot) was classified non-reasoning at runtime. After the dedup both
    // paths share classifyThinkingProtocol, so the fallback now catches all o[1-9].
    it('classifies fallback o-series (o1/o1-mini/o5 not in snapshot) as openai-reasoning', () => {
      expect(resolveCapabilities('o1').thinking).toBe('openai-reasoning');
      expect(resolveCapabilities('o1-mini').thinking).toBe('openai-reasoning');
      expect(resolveCapabilities('o5-preview').thinking).toBe('openai-reasoning');
    });

    // Same drift as the o-series: the fallback gpt branch (/gpt-[45]/) treated gpt-5
    // like gpt-4 (non-reasoning), diverging from classifyThinking's /gpt-?5/. Current
    // gpt-5* are all in the snapshot; an unknown gpt-5 reaching the fallback is now
    // labelled reasoning to match the single source of truth.
    it('classifies fallback gpt-5 (unknown variant not in snapshot) as openai-reasoning', () => {
      expect(resolveCapabilities('gpt-5.9-preview').thinking).toBe('openai-reasoning');
    });

    // The dedup contract: the runtime pattern fallback and the build-time classifier
    // must resolve the SAME protocol, so a new reasoning model can't be labelled one
    // way inside the snapshot and another way outside it.
    it('fallback reasoning protocol agrees with classifyThinking (single source of truth)', () => {
      for (const id of ['o1', 'o5-preview', 'gpt-5.9-preview']) {
        expect(resolveCapabilities(id).thinking).toBe(classifyThinking({ id, reasoning: true }));
      }
    });
  });

  describe('resolveCapabilities — vision classification', () => {
    // Regression: Xiaomi mimo-v2.5-pro is text-only. It was hitting FALLBACK_DEFAULT
    // (vision:true), so computer-use screenshots were sent and rejected by the provider
    // ("No endpoints found that support image input"), crashing the agent turn.
    it('mimo base models are non-vision; MiMo-VL variants are vision', () => {
      expect(resolveCapabilities('mimo-v2.5-pro').vision).toBe(false);
      expect(resolveCapabilities('mimo-7b').vision).toBe(false);
      expect(resolveCapabilities('MiMo-VL-7B').vision).toBe(true);
    });

    it('known non-vision Chinese/local models resolve to vision:false', () => {
      expect(resolveCapabilities('glm-5').vision).toBe(false);
      expect(resolveCapabilities('qwen3-max').vision).toBe(false);
      expect(resolveCapabilities('deepseek-chat').vision).toBe(false);
    });
  });

  describe('computeReasoningParams — content floor', () => {
    it('qwen: reserves the content floor below max_tokens via thinking_budget', () => {
      const caps = resolveCapabilities('qwen3.7-max');
      const p = computeReasoningParams(caps, 32768);
      // reasoning model uses its full ceiling regardless of the requested budget
      expect(p.maxTokens).toBe(65536);
      expect(p.thinkingBudget).toBe(65536 - CONTENT_FLOOR_TOKENS);
      // content always has room
      expect(p.maxTokens - p.thinkingBudget!).toBeGreaterThanOrEqual(CONTENT_FLOOR_TOKENS);
    });

    it('non-reasoning: clamps to the smaller of user budget and model ceiling', () => {
      const caps = resolveCapabilities('qwen2.5-72b-instruct'); // 8192
      const p = computeReasoningParams(caps, 32768);
      expect(p.maxTokens).toBe(8192);
      expect(p.thinkingBudget).toBeUndefined();
      expect(p.reasoningEffort).toBeUndefined();
    });

    it('anthropic: enables thinking and keeps a 16384 floor', () => {
      const caps = resolveCapabilities('claude-sonnet-4-6');
      const p = computeReasoningParams(caps, 32768);
      expect(p.enableThinking).toBe(true);
      expect(p.thinkingBudget).toBe(10000);
      expect(p.maxTokens).toBeGreaterThanOrEqual(16384);
    });

    it('uncontrollable: gives full ceiling, no budget knob', () => {
      const caps = resolveCapabilities('deepseek-r1');
      const p = computeReasoningParams(caps, 32768);
      expect(p.thinkingBudget).toBeUndefined();
      expect(p.reasoningEffort).toBeUndefined();
      expect(p.maxTokens).toBe(caps.maxOutputTokens);
    });

    it('never lets thinking_budget drop below the 1024 minimum on tiny budgets', () => {
      const p = computeReasoningParams(
        { vision: false, thinking: 'qwen', toolResultImages: 'none', documentBlock: false, maxOutputTokens: 4096, contextWindow: 32768 },
        4096,
      );
      expect(p.thinkingBudget).toBe(1024);
    });
  });

  describe('isReasoningStarvation', () => {
    it('true when truncated with no content and no tool calls', () => {
      expect(isReasoningStarvation('max_tokens', 0, 0)).toBe(true);
      expect(isReasoningStarvation('length', 0, 0)).toBe(true);
    });

    it('false when content was produced', () => {
      expect(isReasoningStarvation('max_tokens', 120, 0)).toBe(false);
    });

    it('false when a tool call was produced', () => {
      expect(isReasoningStarvation('max_tokens', 0, 1)).toBe(false);
    });

    it('false on normal end_turn', () => {
      expect(isReasoningStarvation('end_turn', 0, 0)).toBe(false);
    });
  });

  describe('resolveEffectiveContextWindow', () => {
    it('returns model cap when no user setting or discovered value provided', () => {
      // mimo-v2.5-pro falls back to FALLBACK_DEFAULT which has contextWindow=128000
      expect(resolveEffectiveContextWindow('mimo-v2.5-pro')).toBe(128_000);
    });

    it('does NOT overstate when user setting exceeds model cap (the 200k-on-128k bug)', () => {
      // User has settingsStore default of 200000, but the model is 128k.
      // The effective window must be clamped to 128k so the indicator does not
      // claim more headroom than the model actually has.
      expect(resolveEffectiveContextWindow('mimo-v2.5-pro', 200_000)).toBe(128_000);
    });

    it('honours a smaller user setting as an intentional self-limit', () => {
      // If the user sets a tighter window than the model cap, respect it.
      expect(resolveEffectiveContextWindow('claude-opus-4-6', 100_000)).toBe(100_000);
    });

    it('clamps further when runtime-discovered cap is smaller still', () => {
      // Provider returned a smaller window at runtime (e.g. tenant-scoped quota).
      expect(resolveEffectiveContextWindow('claude-opus-4-6', 200_000, 50_000)).toBe(50_000);
    });

    it('ignores invalid (zero / negative / undefined) candidates', () => {
      expect(resolveEffectiveContextWindow('claude-opus-4-6', 0)).toBe(200_000);
      expect(resolveEffectiveContextWindow('claude-opus-4-6', undefined, -5)).toBe(200_000);
    });
  });

  describe('deriveDeclaredDefaults', () => {
    it('declares supportsImages: true for a known vision model (regression guard — gpt-4o vision must not be silently disabled)', () => {
      expect(deriveDeclaredDefaults('gpt-4o')).toEqual({
        supportsTools: true,
        supportsImages: true,
        supportsReasoning: false,
      });
    });

    it('declares supportsImages: false for a known non-vision family (deepseek-chat)', () => {
      expect(deriveDeclaredDefaults('deepseek-chat')).toEqual({
        supportsTools: true,
        supportsImages: false,
        supportsReasoning: false,
      });
    });

    it('declares supportsReasoning: true for a claude reasoning id', () => {
      const result = deriveDeclaredDefaults('claude-opus-4-8');
      expect(result.supportsReasoning).toBe(true);
      expect(result.supportsTools).toBe(true);
    });

    it('stays conservative (supportsImages: false) for an unrecognized proxy model id, even though the fallback default assumes vision — avoids re-introducing the 400-on-image-send bug for unknown models', () => {
      expect(deriveDeclaredDefaults('totally-unknown-proxy-model-xyz')).toEqual({
        supportsTools: true,
        supportsImages: false,
        supportsReasoning: false,
      });
    });

    it('always declares supportsTools: true (no tools axis in ModelCapabilities)', () => {
      expect(deriveDeclaredDefaults('gpt-4o').supportsTools).toBe(true);
      expect(deriveDeclaredDefaults('deepseek-chat').supportsTools).toBe(true);
      expect(deriveDeclaredDefaults('totally-unknown-proxy-model-xyz').supportsTools).toBe(true);
    });
  });

  describe('isKnownModel', () => {
    it('returns true for a KNOWN_MODELS-table id', () => {
      expect(isKnownModel('gpt-4o')).toBe(true);
    });

    it('returns false for an unrecognized id that falls through to FALLBACK_DEFAULT', () => {
      expect(isKnownModel('totally-unknown-xyz')).toBe(false);
    });
  });
});
