import type { ModelProfile } from './modelProfile';
import { THINKING_SWITCH_FORMATS } from './thinkingEffort';

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

/**
 * Recursively replace `anyOf` / `oneOf` with their first branch. DeepSeek's
 * function-calling endpoint rejects a schema that carries either keyword.
 */
function flattenSchemaUnions(node: unknown): void {
  if (node === null || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    for (const item of node) flattenSchemaUnions(item);
    return;
  }

  const obj = node as Record<string, unknown>;
  for (const key of ['anyOf', 'oneOf'] as const) {
    const branches = obj[key];
    if (Array.isArray(branches) && branches.length > 0 && branches[0] && typeof branches[0] === 'object') {
      const first = branches[0] as Record<string, unknown>;
      delete obj[key];
      for (const [k, v] of Object.entries(first)) {
        if (!(k in obj)) obj[k] = v;
      }
    }
  }

  for (const val of Object.values(obj)) {
    flattenSchemaUnions(val);
  }
}

function forEachToolParameters(body: Record<string, unknown>, fn: (parameters: unknown) => void): void {
  const tools = body.tools;
  if (!Array.isArray(tools)) return;
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    const fn_ = (tool as Record<string, unknown>).function;
    if (!fn_ || typeof fn_ !== 'object') continue;
    const parameters = (fn_ as Record<string, unknown>).parameters;
    if (parameters != null) fn(parameters);
  }
}

export interface RequestContext {
  profile: ModelProfile;
  hasTools: boolean;
}

export interface ModelRequestProcessor {
  name: string;
  priority?: number;
  matches(body: Record<string, unknown>, ctx: RequestContext): boolean;
  apply(body: Record<string, unknown>, ctx: RequestContext): void;
}

const EFFORT_ORDER = ['low', 'medium', 'high'] as const;

/** `reasoning_effort` next to tools is rejected by the models whose profile says so (gpt-5.5, every host). */
const reasoningEffortWithTools: ModelRequestProcessor = {
  name: 'reasoning-effort-with-tools',
  priority: 10,
  matches: (_b, ctx) => ctx.hasTools && !ctx.profile.wire.reasoningEffortWithTools,
  apply: (b) => { delete b.reasoning_effort; delete (b as { reasoning?: unknown }).reasoning; },
};

/** The endpoint rejected `reasoning_effort` itself (rejection memory): the field alone is dropped. */
const reasoningEffortGate: ModelRequestProcessor = {
  name: 'reasoning-effort-gate',
  priority: 15,
  matches: (_b, ctx) => !ctx.profile.wire.sendReasoningEffort,
  apply: (b) => { delete b.reasoning_effort; },
};

/** The user declared the endpoint cannot reason: no reasoning parameter leaves. */
const reasoningSupport: ModelRequestProcessor = {
  name: 'reasoning-support',
  priority: 20,
  matches: (_b, ctx) => ctx.profile.wire.stripReasoningParams,
  apply: (b) => { delete b.reasoning_effort; delete (b as { reasoning?: unknown }).reasoning; delete b.thinking_budget; },
};

const toolsGate: ModelRequestProcessor = {
  name: 'tools-gate',
  priority: 20,
  matches: (_b, ctx) => ctx.profile.agent.toolCalling === 'none',
  apply: (b) => { delete b.tools; delete b.tool_choice; },
};

/**
 * Clamp the default `reasoning_effort` to the levels the user ticked for the endpoint.
 * Two things are left alone: a value outside low/medium/high (DeepSeek's `max`), which
 * the nearest-level search below has no place for, and any request while the user has
 * picked a thinking effort themselves, whose value is authoritative.
 */
const effortClamp: ModelRequestProcessor = {
  name: 'effort-clamp',
  priority: 30,
  matches: (b, ctx) =>
    typeof b.reasoning_effort === 'string' &&
    (EFFORT_ORDER as readonly string[]).includes(b.reasoning_effort) &&
    ctx.profile.wire.thinkingEffort === null &&
    ctx.profile.wire.supportedEfforts !== null &&
    ctx.profile.wire.supportedEfforts.length > 0 &&
    !ctx.profile.wire.supportedEfforts.includes(b.reasoning_effort as 'low' | 'medium' | 'high'),
  apply: (b, ctx) => {
    const supported = ctx.profile.wire.supportedEfforts!;
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
 * Swap `max_tokens` → `max_completion_tokens` when the profile says the endpoint
 * takes the renamed field. Only fires when `max_tokens` is present AND
 * `max_completion_tokens` is absent (no double-write).
 */
const maxTokensField: ModelRequestProcessor = {
  name: 'max-tokens-field',
  priority: 25,
  matches: (body, ctx) =>
    typeof body.max_tokens !== 'undefined' &&
    typeof body.max_completion_tokens === 'undefined' &&
    ctx.profile.wire.maxTokensField === 'max_completion_tokens',
  apply: (body) => {
    body.max_completion_tokens = body.max_tokens;
    delete body.max_tokens;
  },
};

/**
 * Translate thinking/reasoning parameters into the shape the profile's
 * `thinkingFormat` names.
 *
 * Runs AFTER the delete/clamp rules (priority 10-30) so reasoning_effort is only
 * translated when it has survived those gates. Only translates when thinking is
 * explicitly ON; there is deliberately no "thinking off → inject disabled" branch,
 * because a non-reasoning model on the same host would then receive a `thinking`
 * field and may 400.
 */
const thinkingFormatTranslator: ModelRequestProcessor = {
  name: 'thinking-format-translator',
  priority: 40,
  matches(body, ctx) {
    const thinkingEnabled = body.reasoning_effort != null || body.thinking_budget != null;
    return ctx.profile.wire.thinkingFormat !== 'openai' && thinkingEnabled;
  },
  apply(body, ctx) {
    switch (ctx.profile.wire.thinkingFormat) {
      case 'openrouter': {
        // Only translate when reasoning_effort is a string; if only thinking_budget is
        // set (no reasoning_effort), leave untouched.
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
        // Ensure body.thinking is an object with type='enabled'. KEEP reasoning_effort — DeepSeek also reads it.
        const t = (body.thinking ?? {}) as Record<string, unknown>;
        if (t.type === undefined) t.type = 'enabled';
        body.thinking = t;
        break;
      }
      case 'together': {
        // Ensure body.reasoning is an object with enabled=true. KEEP reasoning_effort.
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
      case 'kimi': {
        // Moonshot's endpoint does not accept `reasoning_effort`; thinking mode is
        // `thinking: {type:'enabled'}` and requires the profile's temperature.
        body.thinking = { type: 'enabled' };
        if (ctx.profile.wire.temperatureWhenThinking !== null) {
          body.temperature = ctx.profile.wire.temperatureWhenThinking;
        }
        delete body.reasoning_effort;
        break;
      }
      // 'openai' is excluded by matches() above — no default branch needed.
    }
  },
};

/**
 * The user's own thinking-effort pick (设置 → 思考强度), written in the dialect of the
 * profile's `thinkingFormat`. It runs after the delete/clamp rules and the format
 * translator, so the pick replaces whatever the caller's defaults put in the body.
 *
 * Unlike the translator it also writes the OFF position, because here thinking is off
 * on the user's word, not guessed from a model name. It stays silent where the profile
 * says the endpoint cannot take the field: a declared non-reasoning model
 * (`stripReasoningParams`, which a rejected `thinking` field also sets), and a
 * `reasoning_effort` the endpoint rejected or does not accept next to tools.
 *
 * The formats without an on/off switch (`openai`, `openrouter`, `together`) are not
 * handled here: they take the effort through `reasoning_effort`, which
 * `computeReasoningParams` already derived from the same pick.
 */
const thinkingEffortOverride: ModelRequestProcessor = {
  name: 'thinking-effort-override',
  priority: 42,
  matches: (_b, ctx) =>
    ctx.profile.wire.thinkingEffort !== null &&
    !ctx.profile.wire.stripReasoningParams &&
    THINKING_SWITCH_FORMATS.has(ctx.profile.wire.thinkingFormat),
  apply(body, ctx) {
    const { wire } = ctx.profile;
    const effort = wire.thinkingEffort!;
    const on = effort !== 'off';
    switch (wire.thinkingFormat) {
      case 'deepseek': {
        // Official shape: `thinking: {type: 'enabled' | 'disabled'}` plus
        // `reasoning_effort` low | high | max, which only exists while thinking is on.
        body.thinking = { type: on ? 'enabled' : 'disabled' };
        const effortAllowed = wire.sendReasoningEffort && (!ctx.hasTools || wire.reasoningEffortWithTools);
        if (on && effortAllowed) body.reasoning_effort = effort;
        else delete body.reasoning_effort;
        break;
      }
      case 'zai':
      case 'qwen': {
        // A switch only: the budget stays what the caller derived while thinking is on.
        body.enable_thinking = on;
        delete body.reasoning_effort;
        if (!on) delete body.thinking_budget;
        break;
      }
      case 'qwen-chat-template': {
        const kt = (body.chat_template_kwargs ?? {}) as Record<string, unknown>;
        kt.enable_thinking = on;
        body.chat_template_kwargs = kt;
        delete body.reasoning_effort;
        if (!on) delete body.thinking_budget;
        break;
      }
      case 'kimi': {
        // Moonshot's switch is `thinking: {type: 'enabled' | 'disabled'}`, and `reasoning_effort`
        // is not accepted. The profile's fixed temperature belongs to thinking mode only.
        body.thinking = { type: on ? 'enabled' : 'disabled' };
        if (wire.temperatureWhenThinking !== null) {
          if (on) body.temperature = wire.temperatureWhenThinking;
          else delete body.temperature;
        }
        delete body.reasoning_effort;
        break;
      }
    }
  },
};

/** Drop `temperature` for endpoints that reject it. The thinking translator's forced temperature stays. */
const temperatureGate: ModelRequestProcessor = {
  name: 'temperature-gate',
  priority: 45,
  matches: (body, ctx) =>
    typeof body.temperature !== 'undefined' &&
    !ctx.profile.wire.sendTemperature &&
    ctx.profile.wire.temperatureWhenThinking === null,
  apply: (body) => { delete body.temperature; },
};

/** Clean Gemini-unsupported JSON Schema keys from tool parameters. */
const geminiToolSchemaCleanup: ModelRequestProcessor = {
  name: 'gemini-tool-schema-cleanup',
  priority: 46,
  matches: (body, ctx) => ctx.profile.wire.toolSchemaDialect === 'gemini' && Array.isArray(body.tools),
  apply: (body) => forEachToolParameters(body, stripGeminiUnsupportedKeys),
};

/** Replace schema unions with their first branch for endpoints that reject `anyOf` / `oneOf`. */
const deepseekToolSchemaCleanup: ModelRequestProcessor = {
  name: 'deepseek-tool-schema-cleanup',
  priority: 46,
  matches: (body, ctx) => ctx.profile.wire.toolSchemaDialect === 'deepseek' && Array.isArray(body.tools),
  apply: (body) => forEachToolParameters(body, flattenSchemaUnions),
};

/**
 * Inject `thought_signature` into Gemini assistant tool_call messages.
 *
 * When routing Gemini through an openai-compatible endpoint, Gemini's thought
 * signature validator requires `tool_calls[*].extra_content.google.thought_signature`
 * on assistant messages that carry tool calls. Abu doesn't track real thought
 * signatures, so the documented validator-bypass placeholder is injected when the
 * real signature is absent.
 *
 * Source precedence:
 *  1. Already set on `tool_calls[i].extra_content.google.thought_signature` → leave as-is.
 *  2. `msg.extra_fields.google.thought_signature` (string) → use that value.
 *  3. Fallback: `'skip_thought_signature_validator'`.
 */
const thoughtSignaturePlaceholder: ModelRequestProcessor = {
  name: 'thought-signature-placeholder',
  priority: 47,
  matches: (body, ctx) => ctx.profile.wire.thoughtSignaturePlaceholder && Array.isArray(body.messages),
  apply: (body) => {
    const messages = body.messages as Record<string, unknown>[];
    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') continue;
      if (msg.role !== 'assistant') continue;
      const toolCalls = msg.tool_calls;
      if (!Array.isArray(toolCalls) || toolCalls.length === 0) continue;

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

      // Inject into EVERY tool call — Gemini's validator rejects the next request
      // (400) if any parallel tool_call lacks a thought_signature.
      for (const rawTc of toolCalls) {
        if (!rawTc || typeof rawTc !== 'object') continue;
        const tc = rawTc as Record<string, unknown>;

        const existingExtraContent = tc.extra_content;
        if (existingExtraContent != null && typeof existingExtraContent === 'object') {
          const existingGoogle = (existingExtraContent as Record<string, unknown>).google;
          if (existingGoogle != null && typeof existingGoogle === 'object') {
            if (typeof (existingGoogle as Record<string, unknown>).thought_signature === 'string') {
              continue;
            }
          }
        }

        if (!tc.extra_content || typeof tc.extra_content !== 'object') {
          tc.extra_content = {};
        }
        const ecObj = tc.extra_content as Record<string, unknown>;
        if (!ecObj.google || typeof ecObj.google !== 'object') {
          ecObj.google = {};
        }
        (ecObj.google as Record<string, unknown>).thought_signature = signature;
      }
    }
  },
};

/**
 * Inject the `name` field into `role:'tool'` messages for endpoints that require it.
 *
 * The OpenAI spec treats `name` as optional and Abu's serializer omits it; this
 * processor back-fills it from the originating `tool_calls` entry when the profile
 * says the endpoint needs it.
 */
const toolResultName: ModelRequestProcessor = {
  name: 'tool-result-name',
  priority: 50,
  matches: (body, ctx) => ctx.profile.wire.toolResultName && Array.isArray(body.messages),
  apply: (body) => {
    const messages = body.messages as Record<string, unknown>[];

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

    for (const msg of messages) {
      if (msg.role !== 'tool') continue;
      const callId = msg.tool_call_id;
      if (typeof callId !== 'string' || !callId) continue;
      if (msg.name && typeof msg.name === 'string') continue;
      const resolvedName = idToName[callId];
      if (resolvedName) {
        msg.name = resolvedName;
      }
    }
  },
};

/**
 * Tell the endpoint not to return several tool calls in one turn when the
 * profile says the model cannot take them. Silent when the endpoint rejected
 * the field itself (rejection memory): the local serial execution stays.
 */
const parallelToolCalls: ModelRequestProcessor = {
  name: 'parallel-tool-calls',
  priority: 55,
  matches: (_body, ctx) =>
    ctx.hasTools && !ctx.profile.capabilities.parallelToolCalls && ctx.profile.wire.sendParallelToolCalls,
  apply: (body) => { body.parallel_tool_calls = false; },
};

const PROCESSORS: ModelRequestProcessor[] = [
  reasoningEffortWithTools,
  reasoningEffortGate,
  reasoningSupport,
  toolsGate,
  maxTokensField,
  effortClamp,
  thinkingFormatTranslator,
  thinkingEffortOverride,
  temperatureGate,
  geminiToolSchemaCleanup,
  deepseekToolSchemaCleanup,
  thoughtSignaturePlaceholder,
  toolResultName,
  parallelToolCalls,
];

export function applyModelRequestProcessors(body: Record<string, unknown>, ctx: RequestContext): void {
  for (const p of [...PROCESSORS].sort((a, b) => (a.priority ?? 1000) - (b.priority ?? 1000))) {
    if (p.matches(body, ctx)) p.apply(body, ctx);
  }
}
