import type { Message, ToolDefinition } from '@/types';
import type { PromptSection } from '@/core/llm/promptSections';
import {
  estimateMessageTokens,
  estimateTextTokenWeight,
  estimateTokens,
  estimateToolSchemaTokens,
} from './tokenEstimator';

export const BUCKET_KEYS = [
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
  'skill-content',
  'skills-guidance',
  'fork-task',
]);

type UsageBreakdownBucket = (typeof BUCKET_KEYS)[number];

export type UsageBreakdownBuckets = Record<UsageBreakdownBucket, number>;

export type UsageBreakdownToolWeights = Pick<UsageBreakdownBuckets, 'tools' | 'mcp'>;

export interface ComputeBreakdownWeightsInput {
  allSections: PromptSection[];
  tools?: ToolDefinition[];
  toolWeights?: UsageBreakdownToolWeights;
  deferredToolsSummary?: string;
  messagesForContext: Message[];
  volatileContextTail?: string;
}

export function computeToolBreakdownWeights(
  tools: ToolDefinition[],
): UsageBreakdownToolWeights {
  const builtinTools: ToolDefinition[] = [];
  const mcpTools: ToolDefinition[] = [];
  for (const tool of tools) {
    (tool.name.includes('__') ? mcpTools : builtinTools).push(tool);
  }

  return {
    tools: builtinTools.length > 0 ? estimateToolSchemaTokens(builtinTools) : 0,
    mcp: mcpTools.length > 0 ? estimateToolSchemaTokens(mcpTools) : 0,
  };
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
  const sectionWeights = emptyBuckets();
  let hasDeferredToolsSection = false;

  for (const [index, section] of input.allSections.entries()) {
    // sectionsToString() inserts this exact separator before every section
    // after the first. Assigning it to the following section keeps the raw
    // weights additive, so rounding once below reproduces the old aggregate
    // estimateTokens(effectiveSystemPrompt) value exactly.
    const sectionWeight = estimateTextTokenWeight(
      `${index > 0 ? '\n\n' : ''}${section.text}`,
    );
    if (SKILL_SECTION_NAMES.has(section.name)) {
      sectionWeights.skills += sectionWeight;
    } else if (section.name === 'mcp-capabilities') {
      sectionWeights.mcp += sectionWeight;
    } else if (section.name === 'deferred-tools') {
      hasDeferredToolsSection = true;
      sectionWeights.tools += sectionWeight;
    } else {
      sectionWeights.systemPrompt += sectionWeight;
    }
  }

  const systemPromptTokens = Math.ceil(
    Object.values(sectionWeights).reduce((sum, value) => sum + value, 0),
  );
  const distributedSections = distributeWithConservation(sectionWeights, systemPromptTokens);
  for (const key of BUCKET_KEYS) weights[key] += distributedSections[key];

  const toolWeights = input.toolWeights ?? computeToolBreakdownWeights(input.tools ?? []);
  weights.tools += toolWeights.tools;
  weights.mcp += toolWeights.mcp;

  if (!hasDeferredToolsSection && input.deferredToolsSummary) {
    weights.tools += estimateTokens(input.deferredToolsSummary);
  }
  weights.conversation += estimateMessageTokens(input.messagesForContext);
  if (input.volatileContextTail) {
    weights.conversation += estimateTokens(input.volatileContextTail);
  }

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
