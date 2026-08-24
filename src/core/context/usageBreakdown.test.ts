import { beforeEach, describe, expect, it } from 'vitest';
import type { Message, ToolDefinition } from '@/types';
import type { PromptSection } from '@/core/llm/promptSections';
import {
  estimateMessageTokens,
  estimateTokens,
  estimateToolSchemaTokens,
  resetCalibration,
} from './tokenEstimator';
import {
  computeBreakdownWeights,
  distributeWithConservation,
  type UsageBreakdownBuckets,
} from './usageBreakdown';

const ZERO_BUCKETS: UsageBreakdownBuckets = {
  systemPrompt: 0,
  tools: 0,
  mcp: 0,
  skills: 0,
  conversation: 0,
};

function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: 'object', properties: {} },
    execute: async () => 'ok',
  };
}

function sumBuckets(buckets: UsageBreakdownBuckets): number {
  return Object.values(buckets).reduce((sum, value) => sum + value, 0);
}

describe('usageBreakdown', () => {
  beforeEach(() => {
    resetCalibration();
  });

  describe('computeBreakdownWeights', () => {
    it('maps skill and MCP sections explicitly and falls unknown sections back to systemPrompt', () => {
      const sections: PromptSection[] = [
        { name: 'identity', text: 'system identity', cacheable: true },
        { name: 'future-section', text: 'future content', cacheable: false },
        { name: 'active-skills', text: 'active skill', cacheable: true },
        { name: 'preload-skills', text: 'preloaded skill', cacheable: true },
        { name: 'available-skills', text: 'available skill', cacheable: true },
        { name: 'mcp-capabilities', text: 'mcp capability', cacheable: true },
      ];

      const result = computeBreakdownWeights({
        allSections: sections,
        tools: [],
        deferredToolsSummary: '',
        messagesForContext: [],
        volatileContextTail: '',
      });

      expect(result).toEqual({
        systemPrompt: estimateTokens('system identity') + estimateTokens('future content'),
        tools: 0,
        mcp: estimateTokens('mcp capability'),
        skills: estimateTokens('active skill')
          + estimateTokens('preloaded skill')
          + estimateTokens('available skill'),
        conversation: 0,
      });
    });

    it('routes tool schemas by the repository MCP naming convention', () => {
      const mcpTool = makeTool('server__tool');
      const builtinTool = makeTool('run_command');

      const result = computeBreakdownWeights({
        allSections: [],
        tools: [mcpTool, builtinTool],
        deferredToolsSummary: '',
        messagesForContext: [],
        volatileContextTail: '',
      });

      expect(result.mcp).toBe(estimateToolSchemaTokens([mcpTool]));
      expect(result.tools).toBe(estimateToolSchemaTokens([builtinTool]));
    });

    it('attributes the deferred summary to tools and messages plus volatile tail to conversation', () => {
      const deferredToolsSummary = 'Deferred tools summary';
      const messages: Message[] = [
        { id: 'm1', role: 'user', content: 'conversation text', timestamp: 1_700_000_000_000 },
      ];
      const volatileContextTail = 'volatile context tail';

      const result = computeBreakdownWeights({
        allSections: [{
          name: 'deferred-tools',
          text: deferredToolsSummary,
          cacheable: true,
        }],
        tools: [],
        deferredToolsSummary,
        messagesForContext: messages,
        volatileContextTail,
      });

      expect(result.systemPrompt).toBe(0);
      expect(result.tools).toBe(estimateTokens(deferredToolsSummary));
      expect(result.conversation).toBe(
        estimateMessageTokens(messages) + estimateTokens(volatileContextTail),
      );
    });
  });

  describe('distributeWithConservation', () => {
    it('preserves the total with deterministic pseudo-random and extreme weights', () => {
      let seed = 0x51f15e;
      const nextWeight = () => {
        seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
        return seed / 0xffff_ffff;
      };
      const samples: Array<{ weights: UsageBreakdownBuckets; total: number }> = [
        { weights: { ...ZERO_BUCKETS, systemPrompt: 1 }, total: 1 },
        { weights: { ...ZERO_BUCKETS, skills: 1_000_000_000 }, total: 123_456 },
        { weights: { systemPrompt: 1, tools: 1, mcp: 1, skills: 1, conversation: 1 }, total: 1 },
      ];

      for (let index = 0; index < 100; index += 1) {
        samples.push({
          weights: {
            systemPrompt: nextWeight(),
            tools: nextWeight(),
            mcp: nextWeight(),
            skills: nextWeight(),
            conversation: nextWeight(),
          },
          total: index * 137 + 1,
        });
      }

      for (const { weights, total } of samples) {
        const result = distributeWithConservation(weights, total);
        expect(sumBuckets(result)).toBe(total);
        expect(Object.values(result).every(Number.isInteger)).toBe(true);
      }
    });

    it('assigns the entire total to conversation when every weight is zero', () => {
      expect(distributeWithConservation(ZERO_BUCKETS, 321)).toEqual({
        ...ZERO_BUCKETS,
        conversation: 321,
      });
    });

    it('treats negative and non-finite weights as zero without emitting negative buckets', () => {
      const result = distributeWithConservation({
        systemPrompt: -1,
        tools: 2,
        mcp: Number.NaN,
        skills: Number.POSITIVE_INFINITY,
        conversation: 0,
      }, 100);

      expect(result).toEqual({
        systemPrompt: 0,
        tools: 100,
        mcp: 0,
        skills: 0,
        conversation: 0,
      });
      expect(Object.values(result).every((value) => Number.isSafeInteger(value) && value >= 0))
        .toBe(true);
      expect(sumBuckets(result)).toBe(100);
    });

    it('conserves Number.MAX_SAFE_INTEGER without floating-point sum drift', () => {
      const result = distributeWithConservation({
        systemPrompt: 630.1916233799867,
        tools: 947.7303130430473,
        mcp: 35.018655945318436,
        skills: 664.3417826072177,
        conversation: 741.5047848460974,
      }, Number.MAX_SAFE_INTEGER);

      expect(Object.values(result).every((value) => Number.isSafeInteger(value) && value >= 0))
        .toBe(true);
      expect(sumBuckets(result)).toBe(Number.MAX_SAFE_INTEGER);
    });

    it('never assigns remainder tokens to a zero-weight bucket', () => {
      const result = distributeWithConservation({
        systemPrompt: 0,
        tools: 68_021_453,
        mcp: 162_438_588,
        skills: 0,
        conversation: 0,
      }, Number.MAX_SAFE_INTEGER);

      expect(result.systemPrompt).toBe(0);
      expect(result.skills).toBe(0);
      expect(result.conversation).toBe(0);
      expect(sumBuckets(result)).toBe(Number.MAX_SAFE_INTEGER);
    });

    it('returns all zeroes when totalTokens is not a positive safe integer', () => {
      expect(distributeWithConservation(
        { systemPrompt: 1, tools: 2, mcp: 3, skills: 4, conversation: 5 },
        0,
      )).toEqual(ZERO_BUCKETS);
      expect(distributeWithConservation(
        { systemPrompt: 1, tools: 2, mcp: 3, skills: 4, conversation: 5 },
        -10,
      )).toEqual(ZERO_BUCKETS);
      expect(distributeWithConservation(
        { systemPrompt: 1, tools: 2, mcp: 3, skills: 4, conversation: 5 },
        Number.NaN,
      )).toEqual(ZERO_BUCKETS);
      expect(distributeWithConservation(
        { systemPrompt: 1, tools: 2, mcp: 3, skills: 4, conversation: 5 },
        Number.MAX_VALUE,
      )).toEqual(ZERO_BUCKETS);
      expect(distributeWithConservation(
        { systemPrompt: 1, tools: 2, mcp: 3, skills: 4, conversation: 5 },
        1.5,
      )).toEqual(ZERO_BUCKETS);
    });
  });
});
