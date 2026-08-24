import type { Message, ToolDefinition } from '@/types';
import type { PromptSection } from '@/core/llm/promptSections';
import {
  estimateMessageTokens,
  estimateTokens,
  estimateToolSchemaTokens,
} from './tokenEstimator';

const BUCKET_KEYS = [
  'systemPrompt',
  'tools',
  'mcp',
  'skills',
  'conversation',
] as const;

const SKILL_SECTION_NAMES = new Set([
  'active-skills',
  'preload-skills',
  'available-skills',
]);

type UsageBreakdownBucket = (typeof BUCKET_KEYS)[number];

export type UsageBreakdownBuckets = Record<UsageBreakdownBucket, number>;

export interface ComputeBreakdownWeightsInput {
  allSections: PromptSection[];
  tools: ToolDefinition[];
  deferredToolsSummary?: string;
  messagesForContext: Message[];
  volatileContextTail?: string;
}

function emptyBuckets(): UsageBreakdownBuckets {
  return {
    systemPrompt: 0,
    tools: 0,
    mcp: 0,
    skills: 0,
    conversation: 0,
  };
}

export function computeBreakdownWeights(
  input: ComputeBreakdownWeightsInput,
): UsageBreakdownBuckets {
  const weights = emptyBuckets();

  for (const section of input.allSections) {
    // The same deferred summary is supplied separately below so it is
    // attributed to tools exactly once instead of also falling through here.
    if (section.name === 'deferred-tools') continue;
    const sectionTokens = estimateTokens(section.text);
    if (SKILL_SECTION_NAMES.has(section.name)) {
      weights.skills += sectionTokens;
    } else if (section.name === 'mcp-capabilities') {
      weights.mcp += sectionTokens;
    } else {
      weights.systemPrompt += sectionTokens;
    }
  }

  for (const tool of input.tools) {
    const bucket = tool.name.includes('__') ? 'mcp' : 'tools';
    weights[bucket] += estimateToolSchemaTokens([tool]);
  }

  weights.tools += estimateTokens(input.deferredToolsSummary ?? '');
  weights.conversation += estimateMessageTokens(input.messagesForContext);
  weights.conversation += estimateTokens(input.volatileContextTail ?? '');

  return weights;
}

export function distributeWithConservation(
  weights: UsageBreakdownBuckets,
  totalTokens: number,
): UsageBreakdownBuckets {
  const result = emptyBuckets();
  if (!Number.isSafeInteger(totalTokens) || totalTokens <= 0) return result;

  const total = totalTokens;
  const safeWeights = BUCKET_KEYS.map((key) => {
    const weight = weights[key];
    return Number.isFinite(weight) && weight > 0 ? weight : 0;
  });
  const maxWeight = Math.max(...safeWeights);
  if (maxWeight <= 0) {
    result.conversation = totalTokens;
    return result;
  }

  // Normalize before summing so several finite values near Number.MAX_VALUE
  // cannot overflow the denominator to Infinity.
  const normalizedWeights = safeWeights.map((weight) => weight / maxWeight);
  const totalWeight = normalizedWeights.reduce((sum, weight) => sum + weight, 0);

  const remainders = BUCKET_KEYS.map((key, index) => {
    const exact = (normalizedWeights[index] / totalWeight) * total;
    result[key] = Math.floor(exact);
    return { key, index, remainder: exact - result[key] };
  });

  const allocated = BUCKET_KEYS.reduce((sum, key) => sum + BigInt(result[key]), 0n);
  const delta = BigInt(total) - allocated;
  // A zero-weight bucket must remain zero even when floating-point rounding at
  // Number.MAX_SAFE_INTEGER collapses every remainder into the same tie.
  const positiveRemainders = remainders.filter(({ index }) => safeWeights[index] > 0);
  const descendingRemainders = [...positiveRemainders].sort((left, right) => (
    right.remainder - left.remainder || left.index - right.index
  ));

  if (delta > 0n) {
    // Under normal LRM arithmetic this is at most bucketCount - 1. Bulk rounds
    // keep the correction bounded even for pathological floating-point input.
    const bucketCount = BigInt(descendingRemainders.length);
    const fullRounds = Number(delta / bucketCount);
    const remainderCount = Number(delta % bucketCount);
    for (const { key } of descendingRemainders) result[key] += fullRounds;
    for (let index = 0; index < remainderCount; index += 1) {
      result[descendingRemainders[index].key] += 1;
    }
  } else if (delta < 0n) {
    // At safe-integer extremes, independently rounded floating shares can
    // overshoot by a token. Remove from the smallest fractional remainders
    // without an unbounded per-token loop.
    let excess = Number(-delta);
    const ascendingRemainders = [...positiveRemainders].sort((left, right) => (
      left.remainder - right.remainder || right.index - left.index
    ));
    for (const { key } of ascendingRemainders) {
      const removable = Math.min(result[key], excess);
      result[key] -= removable;
      excess -= removable;
      if (excess === 0) break;
    }
  }

  return result;
}
