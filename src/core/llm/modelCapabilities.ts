/**
 * Model Capability Registry
 *
 * Resolves per-model capabilities regardless of provider/apiFormat.
 * Enables correct behavior when using proxy services like OpenRouter
 * that route to different models via a single API format.
 */

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
  /** Context window size */
  contextWindow: number;
}

// ── Known model capabilities ────────────────────────────────────────

const KNOWN_MODELS: Record<string, ModelCapabilities> = {
  // Claude 4.x series
  'claude-opus-4-6':            { vision: true,  thinking: 'anthropic',        toolResultImages: 'native', documentBlock: true,  maxOutputTokens: 32768, contextWindow: 200000 },
  'claude-sonnet-4-6':          { vision: true,  thinking: 'anthropic',        toolResultImages: 'native', documentBlock: true,  maxOutputTokens: 32768, contextWindow: 200000 },
  'claude-haiku-4-5-20251001':  { vision: true,  thinking: false,              toolResultImages: 'native', documentBlock: true,  maxOutputTokens: 8192,  contextWindow: 200000 },
  // Claude 3.x series
  'claude-3-5-sonnet-20241022': { vision: true,  thinking: false,              toolResultImages: 'native', documentBlock: true,  maxOutputTokens: 8192,  contextWindow: 200000 },
  'claude-3-5-haiku-20241022':  { vision: true,  thinking: false,              toolResultImages: 'native', documentBlock: true,  maxOutputTokens: 8192,  contextWindow: 200000 },

  // OpenAI GPT series
  'gpt-4o':                     { vision: true,  thinking: false,              toolResultImages: 'workaround', documentBlock: false, maxOutputTokens: 16384,  contextWindow: 128000 },
  'gpt-4o-mini':                { vision: true,  thinking: false,              toolResultImages: 'workaround', documentBlock: false, maxOutputTokens: 16384,  contextWindow: 128000 },
  'gpt-4.1':                    { vision: true,  thinking: false,              toolResultImages: 'workaround', documentBlock: false, maxOutputTokens: 32768,  contextWindow: 1048576 },
  'gpt-4.1-mini':               { vision: true,  thinking: false,              toolResultImages: 'workaround', documentBlock: false, maxOutputTokens: 32768,  contextWindow: 1048576 },
  'gpt-4.1-nano':               { vision: true,  thinking: false,              toolResultImages: 'workaround', documentBlock: false, maxOutputTokens: 32768,  contextWindow: 1048576 },
  'gpt-5.4':                    { vision: true,  thinking: 'openai-reasoning', toolResultImages: 'workaround', documentBlock: false, maxOutputTokens: 128000, contextWindow: 1048576 },
  'o3':                         { vision: true,  thinking: 'openai-reasoning', toolResultImages: 'workaround', documentBlock: false, maxOutputTokens: 100000, contextWindow: 200000 },
  'o3-mini':                    { vision: false, thinking: 'openai-reasoning', toolResultImages: 'workaround', documentBlock: false, maxOutputTokens: 100000, contextWindow: 200000 },
  'o4-mini':                    { vision: true,  thinking: 'openai-reasoning', toolResultImages: 'workaround', documentBlock: false, maxOutputTokens: 100000, contextWindow: 200000 },

  // DeepSeek series
  'deepseek-chat':              { vision: false, thinking: false,              toolResultImages: 'none',       documentBlock: false, maxOutputTokens: 8192,  contextWindow: 128000 },
  'deepseek-reasoner':          { vision: false, thinking: 'uncontrollable',   toolResultImages: 'none',       documentBlock: false, maxOutputTokens: 8192,  contextWindow: 128000 },

  // Doubao (Volcengine)
  'doubao-seed-2-0-pro-260215': { vision: true,  thinking: false,              toolResultImages: 'workaround', documentBlock: false, maxOutputTokens: 32768, contextWindow: 256000 },

  // Qwen (Bailian) — text-only models, vision requires separate qwen-vl-* models
  // Output limits & reasoning status probe-verified against DashScope (2026-05).
  'qwen-max':                   { vision: false, thinking: false,              toolResultImages: 'workaround', documentBlock: false, maxOutputTokens: 8192,  contextWindow: 262144 },
  'qwen-plus':                  { vision: false, thinking: false,              toolResultImages: 'workaround', documentBlock: false, maxOutputTokens: 32768, contextWindow: 131072 },
  // Qwen3.x flagship — reasoning models (thinking always on, bounded via thinking_budget)
  'qwen3-max':                  { vision: false, thinking: 'qwen',             toolResultImages: 'workaround', documentBlock: false, maxOutputTokens: 65536, contextWindow: 262144 },
  'qwen3.7-max':                { vision: false, thinking: 'qwen',             toolResultImages: 'workaround', documentBlock: false, maxOutputTokens: 65536, contextWindow: 1000000 },

  // Moonshot
  'moonshot-v1-128k':           { vision: false, thinking: false,              toolResultImages: 'none',       documentBlock: false, maxOutputTokens: 4096,  contextWindow: 128000 },

  // MiniMax series (M2.7 supports vision via OpenAI-compatible image_url format)
  'MiniMax-M2.7':              { vision: true,  thinking: false,              toolResultImages: 'workaround', documentBlock: false, maxOutputTokens: 8192,  contextWindow: 204800 },
  'MiniMax-M2.7-highspeed':    { vision: true,  thinking: false,              toolResultImages: 'workaround', documentBlock: false, maxOutputTokens: 8192,  contextWindow: 204800 },
  'MiniMax-M2.5':              { vision: false, thinking: false,              toolResultImages: 'workaround', documentBlock: false, maxOutputTokens: 8192,  contextWindow: 204800 },
  'MiniMax-M2.5-highspeed':    { vision: false, thinking: false,              toolResultImages: 'workaround', documentBlock: false, maxOutputTokens: 8192,  contextWindow: 204800 },

  // Local / Ollama models
  'gemma3':                     { vision: true,  thinking: false,              toolResultImages: 'none',       documentBlock: false, maxOutputTokens: 8192,  contextWindow: 128000 },
  'gemma3:27b':                 { vision: true,  thinking: false,              toolResultImages: 'none',       documentBlock: false, maxOutputTokens: 8192,  contextWindow: 128000 },
  'gemma3:12b':                 { vision: true,  thinking: false,              toolResultImages: 'none',       documentBlock: false, maxOutputTokens: 8192,  contextWindow: 128000 },
  'gemma3:4b':                  { vision: true,  thinking: false,              toolResultImages: 'none',       documentBlock: false, maxOutputTokens: 8192,  contextWindow: 128000 },
  'gemma2':                     { vision: false, thinking: false,              toolResultImages: 'none',       documentBlock: false, maxOutputTokens: 8192,  contextWindow: 8192 },
  'llama3.3':                   { vision: false, thinking: false,              toolResultImages: 'none',       documentBlock: false, maxOutputTokens: 4096,  contextWindow: 128000 },
  'llama3.2':                   { vision: true,  thinking: false,              toolResultImages: 'none',       documentBlock: false, maxOutputTokens: 4096,  contextWindow: 128000 },
  'llama3.1':                   { vision: false, thinking: false,              toolResultImages: 'none',       documentBlock: false, maxOutputTokens: 4096,  contextWindow: 128000 },
  'qwen2.5':                    { vision: false, thinking: false,              toolResultImages: 'none',       documentBlock: false, maxOutputTokens: 8192,  contextWindow: 32768 },
  'qwen3':                      { vision: false, thinking: false,              toolResultImages: 'none',       documentBlock: false, maxOutputTokens: 8192,  contextWindow: 128000 },
  'phi4':                       { vision: false, thinking: false,              toolResultImages: 'none',       documentBlock: false, maxOutputTokens: 4096,  contextWindow: 16384 },
  'phi3':                       { vision: false, thinking: false,              toolResultImages: 'none',       documentBlock: false, maxOutputTokens: 4096,  contextWindow: 128000 },
  'mistral':                    { vision: false, thinking: false,              toolResultImages: 'none',       documentBlock: false, maxOutputTokens: 4096,  contextWindow: 32768 },
  'codellama':                  { vision: false, thinking: false,              toolResultImages: 'none',       documentBlock: false, maxOutputTokens: 4096,  contextWindow: 16384 },
  'deepseek-r1:distill':        { vision: false, thinking: 'uncontrollable',   toolResultImages: 'none',       documentBlock: false, maxOutputTokens: 8192,  contextWindow: 128000 },

  // GLM series (Zhipu AI / Huawei ModelArts)
  'glm-4':                      { vision: false, thinking: false,              toolResultImages: 'none',       documentBlock: false, maxOutputTokens: 4096,  contextWindow: 128000 },
  'glm-4v':                     { vision: true,  thinking: false,              toolResultImages: 'workaround', documentBlock: false, maxOutputTokens: 4096,  contextWindow: 128000 },
  'glm-5':                      { vision: false, thinking: false,              toolResultImages: 'none',       documentBlock: false, maxOutputTokens: 8192,  contextWindow: 128000 },
};

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

  if (/claude.*opus/i.test(id)) {
    return { ...CLAUDE_DEFAULT, thinking: 'anthropic', maxOutputTokens: 16384 };
  }
  if (/claude/i.test(id)) return CLAUDE_DEFAULT;

  if (/^o[34]/i.test(id)) {
    return { ...GPT_MODERN_DEFAULT, thinking: 'openai-reasoning' };
  }
  if (/gpt-[45]/i.test(id) || /gpt-4o/i.test(id)) return GPT_MODERN_DEFAULT;
  if (/gpt-3\.5/i.test(id)) return { ...GPT_MODERN_DEFAULT, vision: false };

  if (/deepseek.*r1|deepseek.*reasoner/i.test(id)) {
    // DeepSeek R1 reasons but exposes no budget knob → can't bound it.
    return { ...DEEPSEEK_DEFAULT, thinking: 'uncontrollable' };
  }
  if (/deepseek/i.test(id)) return DEEPSEEK_DEFAULT;

  // Qwen3.x flagship (e.g. qwen3-max, qwen3.7-max, dated variants) — reasoning,
  // thinking always on, bounded via thinking_budget. Probe-verified 65536 output.
  if (/qwen3\.?\d*-max/i.test(id)) {
    return { ...QWEN_DEFAULT, thinking: 'qwen', maxOutputTokens: 65536, contextWindow: 1000000 };
  }
  if (/qwen/i.test(id)) return QWEN_DEFAULT;
  if (/doubao|seed/i.test(id)) return { ...GPT_MODERN_DEFAULT, maxOutputTokens: 8192 };
  if (/minimax.*m2\.7/i.test(id)) return { vision: true, thinking: false, toolResultImages: 'workaround', documentBlock: false, maxOutputTokens: 8192, contextWindow: 204800 };
  if (/minimax/i.test(id)) return { vision: false, thinking: false, toolResultImages: 'workaround', documentBlock: false, maxOutputTokens: 8192, contextWindow: 204800 };
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
