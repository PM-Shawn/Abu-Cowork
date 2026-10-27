/**
 * Model Capability Registry
 *
 * Resolves per-model capabilities regardless of provider/apiFormat.
 * Enables correct behavior when using proxy services like OpenRouter
 * that route to different models via a single API format.
 */
import { GENERATED_KNOWN_MODELS } from './generated/modelData.generated';
import { FALLBACK_DEFAULT, bareModelId, hasVisionName, resolveFamilyCapabilities } from './model-data/families';
import type { DeclaredCapabilities, ProviderSource } from '@/types/provider';

export { hasVisionName, resolveModelVisionUpdate } from './model-data/families';

// How images in tool results are handled
export type ToolResultImageSupport = 'native' | 'workaround' | 'none';

// How the model supports extended thinking / reasoning
export type ThinkingProtocol =
  | false              // not a reasoning model
  | 'anthropic'        // thinking.budget_tokens (Claude)
  | 'openai-reasoning' // reasoning_effort (o-series / gpt-5)
  | 'qwen'             // thinking_budget — forced-on, cap only (DashScope Qwen3.x)
  | 'uncontrollable';  // reasons, but no budget knob to bound it (e.g. DeepSeek R1)

export interface ModelCapabilities {
  /** Can the model understand image inputs? */
  vision: boolean;
  /** Extended thinking / reasoning protocol */
  thinking: ThinkingProtocol;
  /** How tool_result image blocks are handled */
  toolResultImages: ToolResultImageSupport;
  /** Can receive PDF as document content block? (Claude only) */
  documentBlock: boolean;
  /** Suggested max output tokens */
  maxOutputTokens: number;
  /** The model's true maximum output capability (hard ceiling for clamping/escalation).
   *  Distinct from maxOutputTokens, which is the conservative per-turn request budget.
   *  Optional: pattern-fallback caps omit it (consumers fall back to maxOutputTokens). */
  outputCeiling?: number;
  /** Context window size */
  contextWindow: number;
}

export type ComputerUseModelTier = 'full' | 'structured' | 'unsupported' | 'unknown';
export type ToolCallingCapability = 'native' | 'text-recovery' | 'none';
export type StructuredArgumentsCapability = 'reliable' | 'best-effort' | 'unknown';
export type ModelCapabilitySource = 'builtin' | 'evaluated' | 'user-declared' | 'fallback';

export interface AgentModelCapabilities {
  toolCalling: ToolCallingCapability;
  structuredArguments: StructuredArgumentsCapability;
  computerUseTier: ComputerUseModelTier;
  capabilitySource: ModelCapabilitySource;
  vision: boolean;
}

/**
 * Resolve the product-facing Computer Use tier without over-promising custom
 * endpoints. A familiar model id does not prove that an arbitrary proxy or
 * local server preserves native tool calling, so custom providers remain
 * unknown until the user explicitly declares tool support.
 */
export function resolveAgentModelCapabilities({
  modelId,
  providerSource,
  declared,
}: {
  modelId: string;
  providerSource?: ProviderSource;
  declared?: DeclaredCapabilities;
}): AgentModelCapabilities {
  const vision = declared?.supportsImages ?? resolveCapabilities(modelId).vision;

  if (declared?.supportsTools === false) {
    return {
      toolCalling: 'none',
      structuredArguments: 'unknown',
      computerUseTier: 'unsupported',
      capabilitySource: 'user-declared',
      vision,
    };
  }

  if (providerSource === 'custom') {
    if (declared?.supportsTools !== true) {
      return {
        toolCalling: 'text-recovery',
        structuredArguments: 'unknown',
        computerUseTier: 'unknown',
        capabilitySource: 'fallback',
        vision,
      };
    }
    return {
      toolCalling: 'native',
      structuredArguments: 'best-effort',
      computerUseTier: vision ? 'full' : 'structured',
      capabilitySource: 'user-declared',
      vision,
    };
  }

  if (providerSource === 'builtin' && isKnownModel(modelId)) {
    return {
      toolCalling: 'native',
      structuredArguments: 'reliable',
      computerUseTier: vision ? 'full' : 'structured',
      capabilitySource: 'builtin',
      vision,
    };
  }

  return {
    toolCalling: 'text-recovery',
    structuredArguments: 'unknown',
    computerUseTier: 'unknown',
    capabilitySource: 'fallback',
    vision,
  };
}

// ── Known model capabilities ────────────────────────────────────────

// Static capability table, generated from models.dev + overlays.
// Regenerate with `npm run gen:models`. DO NOT hand-edit model entries here —
// edit src/core/llm/model-data/overlay/* instead. resolveCapabilities() below
// keeps its pattern fallback for ids not present in this table.
const KNOWN_MODELS: Record<string, ModelCapabilities> = GENERATED_KNOWN_MODELS;

/**
 * Resolve model capabilities from a model ID.
 *
 * Resolution order:
 *  1. Exact match in KNOWN_MODELS
 *  2. Strip provider prefix (e.g. "anthropic/claude-opus-4-6" → "claude-opus-4-6")
 *  3. 名字先认视觉，再按家族规则匹配（model-data/families.ts）
 *  4. Fallback default (assumes vision + workaround images)
 */
export function resolveCapabilities(modelId: string): ModelCapabilities {
  // 1. Exact match
  if (KNOWN_MODELS[modelId]) return KNOWN_MODELS[modelId];

  // 2. Strip provider/ prefix (OpenRouter format: "anthropic/claude-opus-4-6")
  const bare = bareModelId(modelId);
  if (bare !== modelId && KNOWN_MODELS[bare]) return KNOWN_MODELS[bare];

  // 3. 名字先认视觉，再按家族规则；只改视觉一项，其余上限沿用家族值
  const family = resolveFamilyCapabilities(bare);
  return !family.vision && hasVisionName(bare) ? { ...family, vision: true } : family;
}

// ── Reasoning budget policy ─────────────────────────────────────────

/** Tokens always reserved for the visible answer so reasoning can't starve it. */
export const CONTENT_FLOOR_TOKENS = 4096;

/** 给回答预留的空间最多占窗口的四分之一，8K 窗口也留得出输入空间。 */
export const OUTPUT_RESERVE_RATIO = 0.25;

export function reserveOutputTokens(requested: number, contextWindow: number): number {
  return Math.max(1, Math.min(requested, Math.floor(contextWindow * OUTPUT_RESERVE_RATIO)));
}

export interface ReasoningRequestParams {
  /** Output token budget to request (max_tokens). */
  maxTokens: number;
  /** Claude only — turn extended thinking on. */
  enableThinking?: boolean;
  /** Max reasoning tokens (Claude budget_tokens / Qwen thinking_budget). */
  thinkingBudget?: number;
  /** OpenAI o-series / gpt-5 — coarse reasoning depth. */
  reasoningEffort?: 'low' | 'medium' | 'high';
}

/**
 * Decide the output budget and reasoning-control params for a model.
 *
 * Reasoning models split their output budget between hidden reasoning and the
 * visible answer. Left unbounded, reasoning can consume the whole budget and
 * leave the answer empty (finish_reason=length, no content) — a documented
 * failure mode across OpenAI/Anthropic/Qwen. We mirror Anthropic's contract
 * (reasoning budget < max_tokens, reserving CONTENT_FLOOR_TOKENS for the answer)
 * and follow OpenAI's "reserve a generous total" guidance by giving reasoning
 * models their full output ceiling.
 *
 * @param caps  Resolved capabilities (overlay any discovered limits before calling).
 * @param requestedMaxTokens  The caller's desired budget (e.g. user setting).
 * @param contextWindow  Effective context window; caps the answer reserve at 25% of it.
 */
export function computeReasoningParams(
  caps: ModelCapabilities,
  requestedMaxTokens: number,
  contextWindow?: number,
): ReasoningRequestParams {
  const isReasoning = caps.thinking !== false;
  // Reasoning models need room for both reasoning and answer → use the model's
  // full ceiling. Non-reasoning models take the smaller of the user budget and
  // the model ceiling (avoids over-asking → a guaranteed 400).
  const uncapped = isReasoning
    ? caps.maxOutputTokens
    : Math.min(requestedMaxTokens, caps.maxOutputTokens);
  const maxTokens = contextWindow === undefined ? uncapped : reserveOutputTokens(uncapped, contextWindow);

  // Reasoning cap that still leaves CONTENT_FLOOR_TOKENS for the answer.
  // 回答预算很小、原式算出的思考预算不小于回答预算时，改用回答预算的一半
  const floorCap = Math.max(1024, maxTokens - CONTENT_FLOOR_TOKENS);
  const reasoningCap = floorCap < maxTokens ? floorCap : Math.floor(maxTokens / 2);

  switch (caps.thinking) {
    case 'qwen':
      return { maxTokens, thinkingBudget: reasoningCap };
    case 'anthropic':
      // Claude counts thinking toward max_tokens; preserve the prior 10k budget.
      return { maxTokens: Math.max(maxTokens, 16384), enableThinking: true, thinkingBudget: 10000 };
    case 'openai-reasoning':
      return { maxTokens, reasoningEffort: 'medium' };
    case 'uncontrollable':
      // No budget knob — give the full ceiling; the reactive net catches starvation.
      return { maxTokens };
    case false:
    default:
      return { maxTokens };
  }
}

/**
 * Reasoning-starvation detector (model-agnostic, reactive safety net).
 *
 * True when a turn hit the output ceiling but produced nothing the loop can act
 * on — no visible answer and no tool call. This is the signature of reasoning
 * eating the entire budget. Used to surface a clear error instead of a silent
 * empty reply, regardless of provider/model.
 */
export function isReasoningStarvation(
  stopReason: string,
  contentLength: number,
  toolCallCount: number,
): boolean {
  return (stopReason === 'max_tokens' || stopReason === 'length')
    && contentLength === 0
    && toolCallCount === 0;
}

/**
 * Derive UI-facing capability tags from a model ID.
 * Maps technical ModelCapabilities → ModelCapability[] used by ModelSelector badges.
 * Shared by modelFetcher (dynamic fetch) and settingsStore (static list).
 */
export function deriveUiCaps(modelId: string): import('@/types/provider').ModelCapability[] {
  const caps = resolveCapabilities(modelId);
  const result: import('@/types/provider').ModelCapability[] = [];
  if (caps.vision) result.push('vision');
  if (caps.thinking !== false) result.push('thinking');
  if (caps.contextWindow >= 512000) result.push('long_context');
  return result;
}

/**
 * Derive the declared-capabilities default for a newly-added custom model, from
 * the same `resolveCapabilities` source of truth `deriveUiCaps` uses for the UI
 * badges — so a hand-typed `gpt-4o` gets `supportsImages: true` instead of the
 * old hardcoded `false`, which silently disabled vision at runtime
 * (`applyDeclaredCapabilities` treats any defined `supportsImages` as an
 * override) even though the model is known to support it.
 *
 * Unrecognized ids (`resolveCapabilities` falls through to `FALLBACK_DEFAULT`,
 * identity-checked below) stay conservative by default — `FALLBACK_DEFAULT.vision`
 * is `true`, but declaring vision for an unknown proxy model is unsafe: it would
 * forward images to a model that may reject them (400). 唯一例外是名字本身能看出是
 * 视觉模型的（`hasVisionName`，带 vl / vision / omni 的本地或私有模型），这类直接
 * 声明 `supportsImages: true`，新添加的本地视觉模型不用用户再手动打开开关。Every
 * recognized family/KNOWN_MODELS branch returns a fresh object, so
 * `=== FALLBACK_DEFAULT` only matches the pure-fallback path.
 */
export function deriveDeclaredDefaults(modelId: string): import('@/types/provider').ModelDeclaredCapabilities {
  const caps = resolveCapabilities(modelId);
  const isUnknown = caps === FALLBACK_DEFAULT;
  return {
    supportsTools: true, // no tools axis in ModelCapabilities; matches prior default
    supportsImages: isUnknown ? hasVisionName(modelId) : caps.vision,
    supportsReasoning: caps.thinking !== false,
  };
}

/**
 * True if the id resolves to real capabilities (KNOWN_MODELS exact/family-prefix
 * match, or a family regex pattern), false if it falls through to the generic
 * FALLBACK_DEFAULT (unrecognized id). Reuses the same identity check as
 * `deriveDeclaredDefaults` above — every recognized branch returns a fresh
 * object literal, so `=== FALLBACK_DEFAULT` only matches the pure-fallback path.
 */
export function isKnownModel(modelId: string): boolean {
  return resolveCapabilities(modelId) !== FALLBACK_DEFAULT;
}
