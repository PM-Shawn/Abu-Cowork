/**
 * Model Capability Registry
 *
 * Resolves per-model capabilities regardless of provider/apiFormat.
 * Enables correct behavior when using proxy services like OpenRouter
 * that route to different models via a single API format.
 */
import { GENERATED_KNOWN_MODELS } from './generated/modelData.generated';
import { classifyThinkingProtocol } from './model-data/classify';

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

// ── Known model capabilities ────────────────────────────────────────

// Static capability table, generated from models.dev + overlays.
// Regenerate with `npm run gen:models`. DO NOT hand-edit model entries here —
// edit src/core/llm/model-data/overlay/* instead. resolveCapabilities() below
// keeps its pattern fallback for ids not present in this table.
const KNOWN_MODELS: Record<string, ModelCapabilities> = GENERATED_KNOWN_MODELS;

// ── Pattern-based defaults ──────────────────────────────────────────

const CLAUDE_DEFAULT: ModelCapabilities =       { vision: true,  thinking: false,              toolResultImages: 'native',     documentBlock: true,  maxOutputTokens: 16384, contextWindow: 200000 };
const GPT_MODERN_DEFAULT: ModelCapabilities =   { vision: true,  thinking: false,              toolResultImages: 'workaround', documentBlock: false, maxOutputTokens: 16384, contextWindow: 128000 };
const DEEPSEEK_DEFAULT: ModelCapabilities =     { vision: false, thinking: false,              toolResultImages: 'none',       documentBlock: false, maxOutputTokens: 8192,  contextWindow: 128000 };
const QWEN_DEFAULT: ModelCapabilities =         { vision: false, thinking: false,              toolResultImages: 'workaround', documentBlock: false, maxOutputTokens: 8192,  contextWindow: 131072 };
const FALLBACK_DEFAULT: ModelCapabilities =     { vision: true,  thinking: false,              toolResultImages: 'workaround', documentBlock: false, maxOutputTokens: 8192,  contextWindow: 128000 };

/**
 * Resolve model capabilities from a model ID.
 *
 * Resolution order:
 *  1. Exact match in KNOWN_MODELS
 *  2. Strip provider prefix (e.g. "anthropic/claude-opus-4-6" → "claude-opus-4-6")
 *  3. Pattern match (claude-*, gpt-*, deepseek-*, etc.)
 *  4. Fallback default (assumes vision + workaround images)
 */
export function resolveCapabilities(modelId: string): ModelCapabilities {
  // 1. Exact match
  if (KNOWN_MODELS[modelId]) return KNOWN_MODELS[modelId];

  // 2. Strip provider/ prefix (OpenRouter format: "anthropic/claude-opus-4-6")
  const bare = modelId.includes('/') ? modelId.split('/').pop()! : modelId;
  if (bare !== modelId && KNOWN_MODELS[bare]) return KNOWN_MODELS[bare];

  // 3. Pattern match
  const id = bare.toLowerCase();

  // Reasoning-protocol labels below come from classifyThinkingProtocol (shared with
  // the build-time classifier in model-data/classify.ts) so the protocol labels can't
  // drift. The family branches themselves (which ids reason) are still maintained here.
  if (/claude.*opus/i.test(id)) {
    return { ...CLAUDE_DEFAULT, thinking: classifyThinkingProtocol(id), maxOutputTokens: 16384 };
  }
  if (/claude/i.test(id)) return CLAUDE_DEFAULT;

  // o[1-9]: matches classifyThinkingProtocol's /^o[1-9]/ (was /^o[34]/ here, which
  // silently dropped o1/o2/o5 to non-reasoning for ids not in the snapshot).
  if (/^o[1-9]/i.test(id)) {
    return { ...GPT_MODERN_DEFAULT, thinking: classifyThinkingProtocol(id) };
  }
  // gpt-5 family reasons (matches classifyThinkingProtocol's /gpt-?5/). Must precede
  // the gpt-4/5 branch below, which would otherwise label it non-reasoning. The
  // non-reasoning gpt-5-chat* variants are all in the snapshot, so only unknown
  // gpt-5 ids reach this branch.
  if (/gpt-?5/i.test(id)) {
    return { ...GPT_MODERN_DEFAULT, thinking: classifyThinkingProtocol(id) };
  }
  if (/gpt-[45]/i.test(id) || /gpt-4o/i.test(id)) return GPT_MODERN_DEFAULT;
  if (/gpt-3\.5/i.test(id)) return { ...GPT_MODERN_DEFAULT, vision: false };

  if (/deepseek.*r1|deepseek.*reasoner/i.test(id)) {
    // DeepSeek R1 reasons but exposes no budget knob → can't bound it.
    return { ...DEEPSEEK_DEFAULT, thinking: classifyThinkingProtocol(id) };
  }
  if (/deepseek/i.test(id)) return DEEPSEEK_DEFAULT;

  // Qwen3.x flagship (e.g. qwen3-max, qwen3.7-max, dated variants) — reasoning,
  // thinking always on, bounded via thinking_budget. Probe-verified 65536 output.
  if (/qwen3\.?\d*-max/i.test(id)) {
    return { ...QWEN_DEFAULT, thinking: classifyThinkingProtocol(id), maxOutputTokens: 65536, contextWindow: 1000000 };
  }
  if (/qwen/i.test(id)) return QWEN_DEFAULT;
  if (/doubao|seed/i.test(id)) return { ...GPT_MODERN_DEFAULT, maxOutputTokens: 8192 };
  if (/minimax.*m2\.7/i.test(id)) return { vision: true, thinking: false, toolResultImages: 'workaround', documentBlock: false, maxOutputTokens: 8192, contextWindow: 204800 };
  if (/minimax/i.test(id)) return { vision: false, thinking: false, toolResultImages: 'workaround', documentBlock: false, maxOutputTokens: 8192, contextWindow: 204800 };
  // Xiaomi MiMo: MiMo-VL variants support vision; the base text models (e.g. mimo-v2.5-pro) do not.
  if (/mimo.*vl/i.test(id)) return { ...FALLBACK_DEFAULT, vision: true, toolResultImages: 'workaround' };
  if (/mimo/i.test(id)) return { ...FALLBACK_DEFAULT, vision: false, toolResultImages: 'none' };
  if (/moonshot|kimi/i.test(id)) return { ...FALLBACK_DEFAULT, vision: false };
  if (/gemma3/i.test(id)) return { vision: true, thinking: false, toolResultImages: 'none', documentBlock: false, maxOutputTokens: 8192, contextWindow: 128000 };
  if (/gemma/i.test(id)) return { ...FALLBACK_DEFAULT, vision: false, toolResultImages: 'none' };
  if (/phi[34]/i.test(id)) return { ...FALLBACK_DEFAULT, vision: false, toolResultImages: 'none' };
  if (/llama|mistral/i.test(id)) return { ...FALLBACK_DEFAULT, toolResultImages: 'none' };
  if (/glm.*v/i.test(id)) return { vision: true, thinking: false, toolResultImages: 'workaround', documentBlock: false, maxOutputTokens: 4096, contextWindow: 128000 };
  if (/glm/i.test(id)) return { vision: false, thinking: false, toolResultImages: 'none', documentBlock: false, maxOutputTokens: 8192, contextWindow: 128000 };

  // 4. Fallback: assume modern model with basic capabilities
  return FALLBACK_DEFAULT;
}

// ── Reasoning budget policy ─────────────────────────────────────────

/** Tokens always reserved for the visible answer so reasoning can't starve it. */
export const CONTENT_FLOOR_TOKENS = 4096;

/**
 * Compute the effective context window for a model, clamped by the user's
 * preference. Used by both agentLoop (for compression/truncation thresholds)
 * and ContextIndicator (for the UI denominator) — keeping them aligned.
 *
 * Rule: take the MIN of any non-empty candidate among
 *   - the model's published contextWindow (from `resolveCapabilities`)
 *   - the user's configured `contextWindowSize` (typically 200000 by default)
 *   - the runtime-discovered contextWindow (if the provider returned one)
 *
 * This guarantees the UI never claims more context than the model actually
 * supports, even when the user setting is the project default of 200k but
 * the model is smaller (e.g. mimo / gpt-4o / kimi at 128k).
 */
export function resolveEffectiveContextWindow(
  modelId: string,
  userSetting?: number,
  discoveredContextWindow?: number,
): number {
  const modelCap = resolveCapabilities(modelId).contextWindow;
  const candidates: number[] = [modelCap];
  if (typeof userSetting === 'number' && userSetting > 0) candidates.push(userSetting);
  if (typeof discoveredContextWindow === 'number' && discoveredContextWindow > 0) {
    candidates.push(discoveredContextWindow);
  }
  return Math.min(...candidates);
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
 */
export function computeReasoningParams(
  caps: ModelCapabilities,
  requestedMaxTokens: number,
): ReasoningRequestParams {
  const isReasoning = caps.thinking !== false;
  // Reasoning models need room for both reasoning and answer → use the model's
  // full ceiling. Non-reasoning models take the smaller of the user budget and
  // the model ceiling (avoids over-asking → a guaranteed 400).
  const maxTokens = isReasoning
    ? caps.maxOutputTokens
    : Math.min(requestedMaxTokens, caps.maxOutputTokens);

  // Reasoning cap that still leaves CONTENT_FLOOR_TOKENS for the answer.
  const reasoningCap = Math.max(1024, maxTokens - CONTENT_FLOOR_TOKENS);

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
 * identity-checked below) stay conservative and declare `supportsImages: false`
 * — `FALLBACK_DEFAULT.vision` is `true`, but declaring vision for an unknown
 * proxy model is unsafe: it would forward images to a model that may reject
 * them (400). Every recognized family/KNOWN_MODELS branch returns a fresh
 * object, so `=== FALLBACK_DEFAULT` only matches the pure-fallback path.
 */
export function deriveDeclaredDefaults(modelId: string): import('@/types/provider').ModelDeclaredCapabilities {
  const caps = resolveCapabilities(modelId);
  const isUnknown = caps === FALLBACK_DEFAULT;
  return {
    supportsTools: true, // no tools axis in ModelCapabilities; matches prior default
    supportsImages: isUnknown ? false : caps.vision,
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
