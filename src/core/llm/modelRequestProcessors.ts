import type { DeclaredCapabilities } from '@/types/provider';
import { deriveThinkingFormat } from './thinkingFormat';

/**
 * True when `needle` appears in modelId as a segment: preceded by start-of-string,
 * ':', '/', ',', or whitespace — NOT a hyphen (so 'kimi-k2.5' matches
 * 'moonshotai/kimi-k2.5' but not 'x-kimi-k2.5'). Case-insensitive.
 */
export function modelSegmentMatch(modelId: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[:/,\\s])${escaped}`, 'i').test(modelId);
}

/**
 * Recursively delete Gemini-unsupported JSON Schema keys from a node.
 * Only removes: $schema, exclusiveMinimum, exclusiveMaximum.
 * Handles objects and arrays; silently skips null/primitives.
 */
function stripGeminiUnsupportedKeys(node: unknown): void {
  if (node === null || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    for (const item of node) stripGeminiUnsupportedKeys(item);
    return;
  }

  const obj = node as Record<string, unknown>;
  delete obj['$schema'];
  delete obj['exclusiveMinimum'];
  delete obj['exclusiveMaximum'];

  for (const val of Object.values(obj)) {
    stripGeminiUnsupportedKeys(val);
  }
}

export interface RequestContext {
  modelId: string;
  requestHost: string;
  hasTools: boolean;
  caps?: DeclaredCapabilities;
}

export interface ModelRequestProcessor {
  name: string;
  priority?: number;
  matches(body: Record<string, unknown>, ctx: RequestContext): boolean;
  apply(body: Record<string, unknown>, ctx: RequestContext): void;
}

const EFFORT_ORDER = ['low', 'medium', 'high'] as const;

function isGpt55(model: string): boolean {
  return /gpt-?5\.5/i.test(model);
}
const responsesNativeFallback: ModelRequestProcessor = {
  name: 'responses-native-fallback',
  priority: 10,
  // Host-agnostic: gpt-5.5 rejects reasoning_effort when tools are present on ANY
  // host (direct OpenAI, proxy, gateway). The original fix (#86) guarded only
  // api.openai.com — this restores protection for routed/proxied deployments.
  matches: (_b, ctx) => ctx.hasTools && isGpt55(ctx.modelId),
  apply: (b) => { delete b.reasoning_effort; delete (b as { reasoning?: unknown }).reasoning; },
};

const reasoningSupport: ModelRequestProcessor = {
  name: 'reasoning-support',
  priority: 20,
  matches: (_b, ctx) => ctx.caps?.supportsReasoning === false,
  apply: (b) => { delete b.reasoning_effort; delete (b as { reasoning?: unknown }).reasoning; delete b.thinking_budget; },
};

const toolsGate: ModelRequestProcessor = {
  name: 'tools-gate',
  priority: 20,
  matches: (_b, ctx) => ctx.caps?.supportsTools === false,
  apply: (b) => { delete b.tools; delete b.tool_choice; },
};

const effortClamp: ModelRequestProcessor = {
  name: 'effort-clamp',
  priority: 30,
  matches: (b, ctx) =>
    typeof b.reasoning_effort === 'string' &&
    Array.isArray(ctx.caps?.supportedEfforts) &&
    ctx.caps!.supportedEfforts!.length > 0 &&
    !ctx.caps!.supportedEfforts!.includes(b.reasoning_effort as 'low' | 'medium' | 'high'),
  apply: (b, ctx) => {
    const supported = ctx.caps!.supportedEfforts!;
    const want = EFFORT_ORDER.indexOf(b.reasoning_effort as typeof EFFORT_ORDER[number]);
    let best = supported[0];
    let bestDist = Infinity;
    for (const e of supported) {
      const d = Math.abs(EFFORT_ORDER.indexOf(e) - want);
      if (d < bestDist) { bestDist = d; best = e; }
    }
    b.reasoning_effort = best;
  },
};

/**
 * Swap `max_tokens` → `max_completion_tokens` for OpenAI o/gpt-4.1/gpt-5 models and
 * any provider that explicitly declares `caps.maxTokensField === 'max_completion_tokens'`.
 *
 * Rule:
 *  • Only fires when `max_tokens` is present AND `max_completion_tokens` is absent (no double-write).
 *  • `caps.maxTokensField === 'max_tokens'` (explicit keep) PREVENTS the swap, even for gpt-5 etc.
 *    This is how Moonshot/Together/Cloudflare AI GW keep `max_tokens` when they don't accept the
 *    renamed field.
 *  • Without explicit caps, modelId prefix matching handles standard OpenAI models.
 */
function shouldSwapMaxTokensField(ctx: RequestContext): boolean {
  if (ctx.caps?.maxTokensField === 'max_tokens') return false;           // explicit keep → never swap
  if (ctx.caps?.maxTokensField === 'max_completion_tokens') return true; // explicit swap
  const prefixes = ['o1', 'o3', 'o4', 'gpt-4.1', 'gpt-5'];
  return prefixes.some((p) => ctx.modelId.startsWith(p));
}

const maxTokensField: ModelRequestProcessor = {
  name: 'max-tokens-field',
  priority: 25,
  matches: (body, ctx) =>
    typeof body.max_tokens !== 'undefined' &&
    typeof body.max_completion_tokens === 'undefined' &&
    shouldSwapMaxTokensField(ctx),
  apply: (body) => {
    body.max_completion_tokens = body.max_tokens;
    delete body.max_tokens;
  },
};

/**
 * Translate thinking/reasoning parameters into the shape expected by each provider.
 *
 * This processor runs AFTER the delete/clamp rules (priority 10-30) so that
 * reasoning_effort is only translated when it has survived those gates.
 *
 * Safety note: we deliberately do NOT handle the "thinking off → inject disabled"
 * branch that WorkBuddy has. Abu derives format by HOST, so a non-reasoning model
 * on the same host (e.g. deepseek-chat on api.deepseek.com) would wrongly receive
 * a `thinking` field and may 400. We only translate when thinking is explicitly ON.
 */
const thinkingFormatTranslator: ModelRequestProcessor = {
  name: 'thinking-format-translator',
  priority: 40,
  matches(body, ctx) {
    const thinkingEnabled = body.reasoning_effort != null || body.thinking_budget != null;
    const fmt = deriveThinkingFormat(ctx.requestHost, ctx.modelId, ctx.caps);
    return fmt !== 'openai' && thinkingEnabled;
  },
  apply(body, ctx) {
    const fmt = deriveThinkingFormat(ctx.requestHost, ctx.modelId, ctx.caps);

    // TODO(smoke, step6): per-format thinking_budget handling — verify which providers
    // accept it before deleting/remapping. For now only reasoning_effort is translated.

    switch (fmt) {
      case 'openrouter': {
        // Only translate when reasoning_effort is a string; if only thinking_budget is
        // set (no reasoning_effort), leave untouched — documented edge case, defer.
        if (typeof body.reasoning_effort === 'string') {
          const existing = (body.reasoning ?? {}) as Record<string, unknown>;
          body.reasoning = {
            ...existing,
            // Existing effort wins so that an explicit per-request override is preserved.
            effort: existing.effort ?? body.reasoning_effort,
          };
          delete body.reasoning_effort;
        }
        break;
      }
      case 'deepseek': {
        // Ensure body.thinking is an object with type='enabled'.
        // KEEP reasoning_effort — DeepSeek also reads it (mirrors WorkBuddy).
        const t = (body.thinking ?? {}) as Record<string, unknown>;
        if (t.type === undefined) t.type = 'enabled';
        body.thinking = t;
        break;
      }
      case 'together': {
        // Ensure body.reasoning is an object with enabled=true.
        // KEEP reasoning_effort (mirrors WorkBuddy).
        const r = (body.reasoning ?? {}) as Record<string, unknown>;
        r.enabled = true;
        body.reasoning = r;
        break;
      }
      case 'zai':
      case 'qwen': {
        body.enable_thinking = true;
        delete body.reasoning_effort;
        break;
      }
      case 'qwen-chat-template': {
        const kt = (body.chat_template_kwargs ?? {}) as Record<string, unknown>;
        kt.enable_thinking = true;
        body.chat_template_kwargs = kt;
        delete body.reasoning_effort;
        break;
      }
      // 'openai' is excluded by matches() above — no default branch needed.
    }
  },
};

/**
 * Inject the `name` field into `role:'tool'` messages for providers that require it.
 *
 * Some providers (e.g. DeepSeek, certain OpenAI-compatible gateways) require every
 * tool-result message to carry a `name` field matching the function name of the
 * originating tool_call. The OpenAI spec treats `name` as optional; Abu's serializer
 * (`serializeForOpenAI`) omits it. This processor back-fills `name` when the
 * provider declares `caps.requiresToolResultName === true`.
 *
 * Algorithm:
 *  1. Walk all messages once, collecting a `tool_call_id → function.name` map from
 *     every assistant message's `tool_calls` array.
 *  2. Walk all `role:'tool'` messages; if `name` is absent/empty and the id is in
 *     the map, inject `name`.
 *
 * All accesses are guarded — a malformed/missing array is silently skipped.
 * Body shape (per serializeForOpenAI / OpenAIMessage interface):
 *   assistant: { role:'assistant', content, tool_calls?: [{ id, type:'function', function:{ name, arguments } }] }
 *   tool:      { role:'tool', tool_call_id: string, content: string }
 */
const toolResultName: ModelRequestProcessor = {
  name: 'tool-result-name',
  priority: 50,
  matches: (_body, ctx) => ctx.caps?.requiresToolResultName === true && Array.isArray(_body.messages),
  apply: (body) => {
    const messages = body.messages as Record<string, unknown>[];

    // Pass 1: build tool_call_id → function.name map from assistant messages
    const idToName: Record<string, string> = {};
    for (const msg of messages) {
      if (msg.role !== 'assistant') continue;
      const toolCalls = msg.tool_calls;
      if (!Array.isArray(toolCalls)) continue;
      for (const tc of toolCalls) {
        if (!tc || typeof tc !== 'object') continue;
        const call = tc as Record<string, unknown>;
        const id = call.id;
        const fn = call.function;
        if (typeof id !== 'string' || !id) continue;
        if (!fn || typeof fn !== 'object') continue;
        const fnName = (fn as Record<string, unknown>).name;
        if (typeof fnName === 'string' && fnName) {
          idToName[id] = fnName;
        }
      }
    }

    // Pass 2: inject name into role:'tool' messages that lack it
    for (const msg of messages) {
      if (msg.role !== 'tool') continue;
      const callId = msg.tool_call_id;
      if (typeof callId !== 'string' || !callId) continue;
      // Only inject when name is absent or empty
      if (msg.name && typeof msg.name === 'string') continue;
      const resolvedName = idToName[callId];
      if (resolvedName) {
        msg.name = resolvedName;
      }
    }
  },
};

/**
 * Translate thinking parameters for Moonshot Kimi K2.5/K2.6 models.
 *
 * Kimi's openai-compatible endpoint does not accept `reasoning_effort`; instead it
 * uses `thinking: { type: 'enabled' }` with `temperature: 1` (required by Kimi
 * thinking mode). Only fires when thinking is explicitly ON (same safety principle as
 * thinkingFormatTranslator — deliberately no "thinking off → disabled" branch).
 */
const kimiThinkingMode: ModelRequestProcessor = {
  name: 'kimi-thinking-mode',
  priority: 44,
  matches: (_body, ctx) =>
    (modelSegmentMatch(ctx.modelId, 'kimi-k2.5') || modelSegmentMatch(ctx.modelId, 'kimi-k2.6')) &&
    (_body.reasoning_effort != null || _body.thinking_budget != null),
  apply: (body) => {
    body.thinking = { type: 'enabled' };
    body.temperature = 1;
    delete body.reasoning_effort;
    // deliberately no "thinking off → disabled" branch (defer, consistent with step 2)
  },
};

/**
 * Clean Gemini-unsupported JSON Schema keys from tool parameters.
 *
 * Gemini's openai-compatible endpoint rejects tool schemas that contain
 * `$schema`, `exclusiveMinimum`, or `exclusiveMaximum` at any nesting level.
 * This processor recursively strips those three keys while leaving all other
 * schema fields (e.g. `type`, `properties`, `minimum`, `maximum`) intact.
 */
const geminiToolSchemaCleanup: ModelRequestProcessor = {
  name: 'gemini-tool-schema-cleanup',
  priority: 46,
  matches: (_body, ctx) =>
    (modelSegmentMatch(ctx.modelId, 'gemini-2.5') || modelSegmentMatch(ctx.modelId, 'gemini-3')) &&
    Array.isArray(_body.tools),
  apply: (body) => {
    const tools = body.tools as Record<string, unknown>[];
    for (const tool of tools) {
      if (!tool || typeof tool !== 'object') continue;
      const fn = tool.function;
      if (!fn || typeof fn !== 'object') continue;
      const parameters = (fn as Record<string, unknown>).parameters;
      if (parameters != null) {
        stripGeminiUnsupportedKeys(parameters);
      }
    }
  },
};

/**
 * Inject `thought_signature` into Gemini assistant tool_call messages.
 *
 * When routing Gemini through an openai-compatible endpoint, Gemini's thought
 * signature validator requires `tool_calls[0].extra_content.google.thought_signature`
 * to be present on assistant messages that carry tool calls. Abu doesn't track real
 * thought signatures, so the documented validator-bypass placeholder is injected
 * when the real signature is absent.
 *
 * Source precedence:
 *  1. Already set on `tool_calls[0].extra_content.google.thought_signature` → leave as-is.
 *  2. `msg.extra_fields.google.thought_signature` (string) → use that value.
 *  3. Fallback: `'skip_thought_signature_validator'`.
 */
const geminiThoughtSignature: ModelRequestProcessor = {
  name: 'gemini-thought-signature',
  priority: 47,
  matches: (_body, ctx) =>
    (modelSegmentMatch(ctx.modelId, 'gemini-2.5') || modelSegmentMatch(ctx.modelId, 'gemini-3')) &&
    Array.isArray(_body.messages),
  apply: (body) => {
    const messages = body.messages as Record<string, unknown>[];
    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') continue;
      if (msg.role !== 'assistant') continue;
      const toolCalls = msg.tool_calls;
      if (!Array.isArray(toolCalls) || toolCalls.length === 0) continue;

      const tc = toolCalls[0] as Record<string, unknown>;
      if (!tc || typeof tc !== 'object') continue;

      // 1. Already set → leave as-is
      const existingExtraContent = tc.extra_content;
      if (existingExtraContent != null && typeof existingExtraContent === 'object') {
        const existingGoogle = (existingExtraContent as Record<string, unknown>).google;
        if (existingGoogle != null && typeof existingGoogle === 'object') {
          if (typeof (existingGoogle as Record<string, unknown>).thought_signature === 'string') {
            continue;
          }
        }
      }

      // 2. Use real signature from msg.extra_fields.google.thought_signature if present
      let signature = 'skip_thought_signature_validator';
      const extraFields = msg.extra_fields;
      if (extraFields != null && typeof extraFields === 'object') {
        const google = (extraFields as Record<string, unknown>).google;
        if (google != null && typeof google === 'object') {
          const sig = (google as Record<string, unknown>).thought_signature;
          if (typeof sig === 'string') {
            signature = sig;
          }
        }
      }

      // 3. Build extra_content.google safely if absent
      if (!tc.extra_content || typeof tc.extra_content !== 'object') {
        tc.extra_content = {};
      }
      const ecObj = tc.extra_content as Record<string, unknown>;
      if (!ecObj.google || typeof ecObj.google !== 'object') {
        ecObj.google = {};
      }
      (ecObj.google as Record<string, unknown>).thought_signature = signature;
    }
  },
};

const PROCESSORS: ModelRequestProcessor[] = [responsesNativeFallback, reasoningSupport, toolsGate, maxTokensField, effortClamp, thinkingFormatTranslator, kimiThinkingMode, geminiToolSchemaCleanup, geminiThoughtSignature, toolResultName];

export function applyModelRequestProcessors(body: Record<string, unknown>, ctx: RequestContext): void {
  for (const p of [...PROCESSORS].sort((a, b) => (a.priority ?? 1000) - (b.priority ?? 1000))) {
    if (p.matches(body, ctx)) p.apply(body, ctx);
  }
}
