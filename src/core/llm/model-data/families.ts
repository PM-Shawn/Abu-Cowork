/**
 * Model families — the one place in `src/core/llm` that reads a model id.
 *
 * A family groups the models that were trained the same way and so answer the
 * same request shape, edit-tool format and prompt the same way. Everything
 * else in the LLM layer (capabilities fallback, request processors, image
 * policy, the model profile) asks this module which family an id belongs to
 * and never inspects the id itself; `modelNameGuard.test.ts` holds that line.
 *
 * Three tables live here:
 *  - `resolveModelFamily`: id → family.
 *  - `resolveFamilyCapabilities`: the capability fallback for an id the
 *    generated table does not know (window, output budget, vision, thinking).
 *  - `FAMILY_PROFILE_DEFAULTS` + `MODEL_ID_RULES`: the wire and harness
 *    defaults per family, and the few per-id patches on top of them.
 */
import type { ModelCapabilities } from '../modelCapabilities';
import { classifyThinkingProtocol } from './classify';

export type ModelFamily =
  | 'claude'
  | 'gpt'
  | 'deepseek'
  | 'kimi'
  | 'qwen'
  | 'glm'
  | 'gemini'
  | 'other';

export const MODEL_FAMILIES: readonly ModelFamily[] = [
  'claude', 'gpt', 'deepseek', 'kimi', 'qwen', 'glm', 'gemini', 'other',
];

/** Strip an OpenRouter-style `provider/` prefix. */
export function bareModelId(modelId: string): string {
  return modelId.includes('/') ? modelId.split('/').pop()! : modelId;
}

export function resolveModelFamily(modelId: string): ModelFamily {
  const id = bareModelId(modelId).toLowerCase();
  if (/claude/.test(id)) return 'claude';
  if (/^o[1-9]/.test(id) || /gpt-/.test(id) || /codex/.test(id)) return 'gpt';
  if (/deepseek/.test(id)) return 'deepseek';
  if (/kimi|moonshot/.test(id)) return 'kimi';
  if (/qwen/.test(id)) return 'qwen';
  if (/glm/.test(id)) return 'glm';
  if (/gemini/.test(id)) return 'gemini';
  return 'other';
}

// ── Capability fallback for ids the generated table does not know ──────────

const CLAUDE_DEFAULT: ModelCapabilities =       { vision: true,  thinking: false,              toolResultImages: 'native',     documentBlock: true,  maxOutputTokens: 16384, contextWindow: 200000 };
const GPT_MODERN_DEFAULT: ModelCapabilities =   { vision: true,  thinking: false,              toolResultImages: 'workaround', documentBlock: false, maxOutputTokens: 16384, contextWindow: 128000 };
const DEEPSEEK_DEFAULT: ModelCapabilities =     { vision: false, thinking: false,              toolResultImages: 'none',       documentBlock: false, maxOutputTokens: 8192,  contextWindow: 128000 };
const QWEN_DEFAULT: ModelCapabilities =         { vision: false, thinking: false,              toolResultImages: 'workaround', documentBlock: false, maxOutputTokens: 8192,  contextWindow: 131072 };
export const FALLBACK_DEFAULT: ModelCapabilities = { vision: true,  thinking: false,              toolResultImages: 'workaround', documentBlock: false, maxOutputTokens: 8192,  contextWindow: 128000 };

/** 名字里带 vl、vision、omni 或以 -v 结尾的模型能看图，先于家族规则判断。 */
const VISION_NAME_PATTERN = /(?:^|[-_.:/\d])vl(?:[-_.:/\d]|$)|vision|omni|-v$/i;

export function hasVisionName(modelId: string): boolean {
  return VISION_NAME_PATTERN.test(bareModelId(modelId));
}

export function isLlama32TextModel(modelId: string): boolean {
  return /llama[-_.]?3\.2(?:[-_:]|$)/i.test(bareModelId(modelId)) && !hasVisionName(modelId);
}

/** Image capabilities applied once when upgrading the saved model settings. */
export function resolveModelVisionUpdate(modelId: string): boolean | undefined {
  const id = bareModelId(modelId).toLowerCase();
  if (['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].includes(id)) return true;
  return isLlama32TextModel(id) ? false : undefined;
}

/**
 * Family-level capability fallback. Every recognized branch returns a fresh
 * object; only the pure fallback returns the `FALLBACK_DEFAULT` identity, which
 * `isKnownModel` relies on.
 */
export function resolveFamilyCapabilities(bareId: string): ModelCapabilities {
  const id = bareId.toLowerCase();
  // Reasoning-protocol labels come from classifyThinkingProtocol (shared with
  // the build-time classifier) so the protocol labels can't drift. Which ids
  // reason at all is still decided by the branches here.
  if (/claude.*opus/.test(id)) {
    return { ...CLAUDE_DEFAULT, thinking: classifyThinkingProtocol(id), maxOutputTokens: 16384 };
  }
  if (/claude/.test(id)) return CLAUDE_DEFAULT;

  if (/^o[1-9]/.test(id)) {
    return { ...GPT_MODERN_DEFAULT, thinking: classifyThinkingProtocol(id) };
  }
  // gpt-5 family reasons (matches classifyThinkingProtocol's /gpt-?5/). Must precede
  // the gpt-4/5 branch below, which would otherwise label it non-reasoning. The
  // non-reasoning gpt-5-chat* variants are all in the snapshot, so only unknown
  // gpt-5 ids reach this branch.
  if (/gpt-?5/.test(id)) {
    return { ...GPT_MODERN_DEFAULT, thinking: classifyThinkingProtocol(id) };
  }
  if (/gpt-[45]/.test(id) || /gpt-4o/.test(id)) return GPT_MODERN_DEFAULT;
  if (/gpt-3\.5/.test(id)) return { ...GPT_MODERN_DEFAULT, vision: false };

  if (/deepseek.*r1|deepseek.*reasoner/.test(id)) {
    // DeepSeek R1 reasons but exposes no budget knob → can't bound it.
    return { ...DEEPSEEK_DEFAULT, thinking: classifyThinkingProtocol(id) };
  }
  if (/deepseek/.test(id)) return DEEPSEEK_DEFAULT;

  // Qwen3.x flagship (e.g. qwen3-max, qwen3.7-max, dated variants) — reasoning,
  // thinking always on, bounded via thinking_budget. Probe-verified 65536 output.
  if (/qwen3\.?\d*-max/.test(id)) {
    return { ...QWEN_DEFAULT, thinking: classifyThinkingProtocol(id), maxOutputTokens: 65536, contextWindow: 1000000 };
  }
  if (/qwen/.test(id)) return QWEN_DEFAULT;
  if (/doubao|seed/.test(id)) return { ...GPT_MODERN_DEFAULT, maxOutputTokens: 8192 };
  if (/minimax.*m2\.7/.test(id)) return { vision: true, thinking: false, toolResultImages: 'workaround', documentBlock: false, maxOutputTokens: 8192, contextWindow: 204800 };
  if (/minimax/.test(id)) return { vision: false, thinking: false, toolResultImages: 'workaround', documentBlock: false, maxOutputTokens: 8192, contextWindow: 204800 };
  // Xiaomi MiMo: MiMo-VL variants support vision; the base text models (e.g. mimo-v2.5-pro) do not.
  if (/mimo.*vl/.test(id)) return { ...FALLBACK_DEFAULT, vision: true, toolResultImages: 'workaround' };
  if (/mimo/.test(id)) return { ...FALLBACK_DEFAULT, vision: false, toolResultImages: 'none' };
  if (/moonshot|kimi/.test(id)) return { ...FALLBACK_DEFAULT, vision: false };
  if (/gemma3/.test(id)) return { vision: true, thinking: false, toolResultImages: 'none', documentBlock: false, maxOutputTokens: 8192, contextWindow: 128000 };
  if (/gemma/.test(id)) return { ...FALLBACK_DEFAULT, vision: false, toolResultImages: 'none' };
  if (/phi[34]/.test(id)) return { ...FALLBACK_DEFAULT, vision: false, toolResultImages: 'none' };
  if (isLlama32TextModel(id)) return { ...FALLBACK_DEFAULT, vision: false, toolResultImages: 'none' };
  if (/llama|mistral/.test(id)) return { ...FALLBACK_DEFAULT, toolResultImages: 'none' };
  if (/glm.*v/.test(id)) return { vision: true, thinking: false, toolResultImages: 'workaround', documentBlock: false, maxOutputTokens: 4096, contextWindow: 128000 };
  if (/glm/.test(id)) return { vision: false, thinking: false, toolResultImages: 'none', documentBlock: false, maxOutputTokens: 8192, contextWindow: 128000 };

  return FALLBACK_DEFAULT;
}

// ── Wire and harness defaults ─────────────────────────────────────────────

/** How the OpenAI-compatible request carries the thinking switch. */
export type ThinkingFormat =
  | 'openai'
  | 'deepseek'
  | 'qwen'
  | 'qwen-chat-template'
  | 'zai'
  | 'together'
  | 'openrouter'
  | 'kimi';

/** Whether earlier assistant turns carry `reasoning_content` on replay. */
export type ReasoningReplay =
  | 'none'                          // never sent
  | 'reasoning_content'             // sent when the turn captured thinking
  | 'reasoning_content-or-empty';   // always sent; '' on a tool-call turn without thinking

export type ToolSchemaDialect = 'standard' | 'gemini' | 'deepseek';

export type EditToolStyle = 'replace' | 'patch';

export interface ProfileWire {
  /** Chosen by the host first (a gateway speaks its own format), then by the id rules, then by the family. */
  thinkingFormat: ThinkingFormat;
  maxTokensField: 'max_tokens' | 'max_completion_tokens';
  reasoningReplay: ReasoningReplay;
  /** `reasoning_effort` is dropped when tools are present (gpt-5.5 rejects the pair). */
  reasoningEffortWithTools: boolean;
  /** Every reasoning parameter is dropped (the user declared the endpoint cannot reason). */
  stripReasoningParams: boolean;
  /** The efforts the endpoint accepts; a request outside them is clamped to the nearest. */
  supportedEfforts: ReadonlyArray<'low' | 'medium' | 'high'> | null;
  /** `reasoning_effort` leaves the request; off once the endpoint rejected the field. */
  sendReasoningEffort: boolean;
  /** `parallel_tool_calls` may be written; off once the endpoint rejected the field. */
  sendParallelToolCalls: boolean;
  toolSchemaDialect: ToolSchemaDialect;
  /** `role:tool` messages carry `name` (some gateways require it). */
  toolResultName: boolean;
  /** `temperature` is forwarded; families that reject it drop the field. */
  sendTemperature: boolean;
  /** Forced temperature while thinking is on (Kimi requires 1). */
  temperatureWhenThinking: number | null;
  /** `prompt_cache_key` is sent (only the official OpenAI endpoint reads it). */
  promptCacheKey: boolean;
  /** Gemini through a gateway: assistant tool calls need a `thought_signature` placeholder. */
  thoughtSignaturePlaceholder: boolean;
}

export interface ProfileHarness {
  editToolStyle: EditToolStyle;
  /** Key for the prompt variant; usually the family itself. */
  promptVariant: ModelFamily;
  guards: {
    /** Nudge once more when a turn ends with text only in the middle of a task. */
    textOnlyEndTurnNudge: boolean;
    /** Repair stringified JSON / numeric strings in tool arguments before dispatch. */
    toolArgumentRepair: boolean;
    /**
     * On a spent-quota error, retry the same turn on another enabled model
     * (see src/core/agent/modelFailover.ts). Run-scoped: the run stays on the
     * failover model once switched; the user's activeModel is untouched.
     */
    quotaFailover: boolean;
  };
}

export interface FamilyProfileDefaults {
  wire: ProfileWire;
  harness: ProfileHarness;
  parallelToolCalls: boolean;
}

const BASE_WIRE: ProfileWire = {
  thinkingFormat: 'openai',
  maxTokensField: 'max_tokens',
  reasoningReplay: 'reasoning_content-or-empty',
  reasoningEffortWithTools: true,
  stripReasoningParams: false,
  supportedEfforts: null,
  sendReasoningEffort: true,
  sendParallelToolCalls: true,
  toolSchemaDialect: 'standard',
  toolResultName: false,
  sendTemperature: true,
  temperatureWhenThinking: null,
  promptCacheKey: false,
  thoughtSignaturePlaceholder: false,
};

const guardsOff = { textOnlyEndTurnNudge: false, toolArgumentRepair: false, quotaFailover: true } as const;
// textOnlyEndTurnNudge：OpenAI-compatible 家族全开。网关/第三方模型会以空响应
// （无正文、无工具调用）静默结束回合，任务中途死掉却记 completed——2026-10-27
// 会话 mvphffrthde2vb 的 0/106 事故即此。claude/gpt 走 guardsOff 保持关闭。
const guardsRepair = { textOnlyEndTurnNudge: true, toolArgumentRepair: true, quotaFailover: true } as const;

/**
 * Per-family defaults. The values are the request shapes the adapters sent
 * before the profile existed; the eval batches adjust them with evidence.
 */
export const FAMILY_PROFILE_DEFAULTS: Record<ModelFamily, FamilyProfileDefaults> = {
  claude: {
    wire: { ...BASE_WIRE, reasoningReplay: 'none', sendTemperature: false },
    harness: { editToolStyle: 'replace', promptVariant: 'claude', guards: guardsOff },
    parallelToolCalls: true,
  },
  gpt: {
    wire: { ...BASE_WIRE, maxTokensField: 'max_completion_tokens' },
    harness: { editToolStyle: 'patch', promptVariant: 'gpt', guards: guardsOff },
    parallelToolCalls: true,
  },
  deepseek: {
    wire: { ...BASE_WIRE, thinkingFormat: 'deepseek', toolSchemaDialect: 'deepseek' },
    harness: { editToolStyle: 'replace', promptVariant: 'deepseek', guards: guardsRepair },
    parallelToolCalls: true,
  },
  kimi: {
    wire: { ...BASE_WIRE },
    harness: { editToolStyle: 'replace', promptVariant: 'kimi', guards: guardsRepair },
    parallelToolCalls: true,
  },
  qwen: {
    wire: { ...BASE_WIRE, thinkingFormat: 'qwen' },
    harness: { editToolStyle: 'replace', promptVariant: 'qwen', guards: guardsRepair },
    parallelToolCalls: true,
  },
  glm: {
    wire: { ...BASE_WIRE, thinkingFormat: 'zai' },
    harness: { editToolStyle: 'replace', promptVariant: 'glm', guards: guardsRepair },
    parallelToolCalls: true,
  },
  gemini: {
    wire: { ...BASE_WIRE, toolSchemaDialect: 'gemini', thoughtSignaturePlaceholder: true },
    harness: { editToolStyle: 'replace', promptVariant: 'other', guards: guardsRepair },
    parallelToolCalls: true,
  },
  other: {
    wire: { ...BASE_WIRE },
    harness: { editToolStyle: 'replace', promptVariant: 'other', guards: guardsRepair },
    parallelToolCalls: true,
  },
};

export interface ModelIdRule {
  /** Tested against the bare, lower-cased id. */
  test: RegExp;
  wire?: Partial<ProfileWire>;
  harness?: Partial<Omit<ProfileHarness, 'guards'>> & { guards?: Partial<ProfileHarness['guards']> };
  parallelToolCalls?: boolean;
}

/**
 * Per-id patches on top of the family defaults, applied in order. Keep this
 * list short: a model that differs from its family in one field belongs here,
 * a whole new behaviour belongs in a family.
 */
export const MODEL_ID_RULES: readonly ModelIdRule[] = [
  // OpenAI models that still take `max_tokens`; the newer ones take
  // `max_completion_tokens` (the family default).
  { test: /^gpt-4o|^gpt-3\.5|^gpt-4-|^gpt-4$|^chatgpt-/, wire: { maxTokensField: 'max_tokens' } },
  // gpt-4 generation was never trained on the patch format (Shawn, 2026-10-19).
  { test: /^gpt-4/, harness: { editToolStyle: 'replace' } },
  // gpt-5.5 rejects reasoning_effort when tools are present, on every host.
  { test: /gpt-?5\.5/, wire: { reasoningEffortWithTools: false } },
  // Kimi K2.5/K2.6 take `thinking: {type:'enabled'}` with temperature 1.
  { test: /(^|[:/,\s])kimi-k2\.[56]/, wire: { thinkingFormat: 'kimi', temperatureWhenThinking: 1 } },
];
