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
export type ThinkingProtocol = false | 'anthropic' | 'openai-reasoning';

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
  'claude-opus-4-6':            { vision: true,  thinking: 'anthropic',        toolResultImages: 'native', documentBlock: true,  maxOutputTokens: 16384, contextWindow: 200000 },
  'claude-sonnet-4-6':          { vision: true,  thinking: 'anthropic',        toolResultImages: 'native', documentBlock: true,  maxOutputTokens: 16384, contextWindow: 200000 },
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
  'deepseek-reasoner':          { vision: false, thinking: 'openai-reasoning', toolResultImages: 'none',       documentBlock: false, maxOutputTokens: 8192,  contextWindow: 128000 },

  // Doubao (Volcengine)
  'doubao-seed-2-0-pro-260215': { vision: true,  thinking: false,              toolResultImages: 'workaround', documentBlock: false, maxOutputTokens: 32768, contextWindow: 256000 },

  // Qwen (Bailian) — text-only models, vision requires separate qwen-vl-* models
  'qwen-max':                   { vision: false, thinking: false,              toolResultImages: 'workaround', documentBlock: false, maxOutputTokens: 32768, contextWindow: 262144 },
  'qwen-plus':                  { vision: false, thinking: false,              toolResultImages: 'workaround', documentBlock: false, maxOutputTokens: 8192,  contextWindow: 131072 },

  // Moonshot
  'moonshot-v1-128k':           { vision: false, thinking: false,              toolResultImages: 'none',       documentBlock: false, maxOutputTokens: 4096,  contextWindow: 128000 },

  // Local models
  'llama3.2':                   { vision: true,  thinking: false,              toolResultImages: 'none',       documentBlock: false, maxOutputTokens: 4096,  contextWindow: 128000 },
  'qwen2.5':                    { vision: false, thinking: false,              toolResultImages: 'none',       documentBlock: false, maxOutputTokens: 8192,  contextWindow: 32768 },
};

// ── Pattern-based defaults ──────────────────────────────────────────

const CLAUDE_DEFAULT: ModelCapabilities =       { vision: true,  thinking: false,              toolResultImages: 'native',     documentBlock: true,  maxOutputTokens: 8192,  contextWindow: 200000 };
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
    return { ...DEEPSEEK_DEFAULT, thinking: 'openai-reasoning' };
  }
  if (/deepseek/i.test(id)) return DEEPSEEK_DEFAULT;

  if (/qwen/i.test(id)) return QWEN_DEFAULT;
  if (/doubao|seed/i.test(id)) return { ...GPT_MODERN_DEFAULT, maxOutputTokens: 8192 };
  if (/moonshot|kimi/i.test(id)) return { ...FALLBACK_DEFAULT, vision: false };
  if (/llama|mistral|gemma/i.test(id)) return { ...FALLBACK_DEFAULT, toolResultImages: 'none' };

  // 4. Fallback: assume modern model with basic capabilities
  return FALLBACK_DEFAULT;
}
