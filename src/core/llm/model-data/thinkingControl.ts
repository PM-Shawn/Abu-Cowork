/**
 * How each model's thinking can be steered — the one table behind the 思考强度
 * setting, the request budget and the request writers.
 *
 * What a pick can do depends on the model and on the wire it travels over, so the
 * facts live here with the other per-model data and nobody else reads an id for
 * them. Sources (checked 2026-11):
 *  - Anthropic, Thinking / Effort / Thinking troubleshooting pages: Fable 5.x and
 *    Opus 5.5 are adaptive-only and always think (`disabled` is a 400); Opus 5 and
 *    Haiku 5.5 think by default and accept `disabled` at effort high or below;
 *    Sonnet 5 accepts `disabled`, Sonnet 5.5 turns thinking off with `between_tools`;
 *    Opus 4.7/4.8 are adaptive-only and think only when asked; every adaptive
 *    model rejects `enabled` + `budget_tokens`; Claude 4.6 and older take the budget.
 *  - OpenAI, latest-model guide and model pages: `reasoning_effort` `none` exists
 *    from gpt-5.1 on, `xhigh` from gpt-5.2 on; gpt-5 and the o-series start at `low`.
 *  - DeepSeek, thinking mode and chat-completion reference: `thinking` enabled or
 *    disabled plus `reasoning_effort` low | high | max.
 */
import type { ThinkingEffort } from '@/types/provider';
import type { ThinkingProtocol } from '../modelCapabilities';
import type { ThinkingFormat } from './families';

/** What turns a default-on Claude model's thinking off (null: it cannot be turned off). */
export type AnthropicOffSwitch = 'disabled' | 'between_tools' | 'omit' | null;

export type ThinkingControl =
  /** Nothing the user picks reaches the request, so no level is offered. */
  | { kind: 'none' }
  /** Claude 4.6 and older: `thinking: {type:'enabled', budget_tokens}`; off sends no thinking. */
  | { kind: 'anthropic-budget' }
  /** Claude 4.7 and newer: `thinking: {type:'adaptive'}` + `output_config.effort`. */
  | { kind: 'anthropic-adaptive'; off: AnthropicOffSwitch }
  /** OpenAI `reasoning_effort`; `none` / `xhigh` exist only on the newer models. */
  | { kind: 'reasoning-effort'; none: boolean; xhigh: boolean }
  /** An on/off switch in the request (`thinking`, `enable_thinking`...); `effort`: DeepSeek's levels too. */
  | { kind: 'switch'; effort: boolean };

/** A level the user picked, together with what the model's control can do with it. */
export interface ThinkingPick {
  effort: ThinkingEffort;
  control: ThinkingControl;
}

export interface ThinkingControlInput {
  /** Bare (no `provider/` prefix), lower-cased model id. */
  bareId: string;
  /** The thinking protocol of the resolved capabilities (the user's declaration applied). */
  protocol: ThinkingProtocol;
  /** The thinking format the request is written in (host, id rule, declaration). */
  format: ThinkingFormat;
  /** The adapter the provider type selects; unknown on the adapter side, where the model's own wire counts. */
  adapter?: 'claude' | 'openai-compatible' | 'ollama';
  /** `reasoning_effort` may travel next to tools (agent turns always carry tools). */
  reasoningEffortWithTools: boolean;
  /** The user declared the endpoint cannot reason, or it rejected the thinking field. */
  reasoningStripped: boolean;
}

const SWITCH_FORMATS: ReadonlySet<ThinkingFormat> = new Set<ThinkingFormat>([
  'deepseek', 'qwen', 'zai', 'qwen-chat-template', 'kimi',
]);

/** The Claude control for an id, or null when the id is not a Claude model that thinks. */
function claudeControl(bareId: string, protocol: ThinkingProtocol): ThinkingControl | null {
  const id = bareId.replace(/\./g, '-');
  const adaptive = (off: AnthropicOffSwitch): ThinkingControl => ({ kind: 'anthropic-adaptive', off });
  if (/claude-(fable|mythos)-5(?!-preview)/.test(id)) return adaptive(null);
  if (/claude-opus-5-5/.test(id)) return adaptive(null);
  if (/claude-opus-5(?!-\d)/.test(id)) return adaptive('disabled');
  if (/claude-sonnet-5-5/.test(id)) return adaptive('between_tools');
  if (/claude-sonnet-5(?!-\d)/.test(id)) return adaptive('disabled');
  if (/claude-haiku-5/.test(id)) return adaptive('disabled');
  if (/claude-opus-4-[78]/.test(id)) return adaptive('omit');
  return /claude/.test(id) && protocol === 'anthropic' ? { kind: 'anthropic-budget' } : null;
}

function openAiControl(bareId: string): ThinkingControl {
  // gpt-5.1 and later take `none`; gpt-5.2 and later take `xhigh`. gpt-5 and the o-series
  // start at `low`.
  const minor = /gpt-?5\.(\d+)/.exec(bareId);
  const generation = minor ? Number(minor[1]) : 0;
  return { kind: 'reasoning-effort', none: generation >= 1, xhigh: generation >= 2 };
}

/**
 * The control that actually carries a pick for a model on a wire. A level the
 * request cannot carry (next to tools, through another adapter, past what the
 * model accepts) is not offered, so no pick is ever a silent no-op.
 */
export function resolveThinkingControl(input: ThinkingControlInput): ThinkingControl {
  if (input.reasoningStripped) return { kind: 'none' };
  const { adapter, bareId, protocol, format } = input;

  if (adapter === 'ollama') {
    // The native adapter reads `think: false`; there is no other level.
    return protocol === false ? { kind: 'none' } : { kind: 'switch', effort: false };
  }
  // Claude models speak the Anthropic wire; on a gateway with its own dialect, or behind
  // an OpenAI-compatible provider, the adapter does not write those fields.
  const claude = claudeControl(bareId, protocol);
  if (claude) return adapter !== 'openai-compatible' && format === 'openai' ? claude : { kind: 'none' };
  if (adapter === 'claude') return { kind: 'none' };

  if (protocol === false) return { kind: 'none' };
  // A gateway's own dialect wins over the model's, as everywhere in the profile.
  if (SWITCH_FORMATS.has(format)) return { kind: 'switch', effort: format === 'deepseek' };
  if (protocol === 'openai-reasoning') {
    // gpt-5.5 rejects `reasoning_effort` next to tools, so the profile drops it from every
    // agent turn: none of its levels reach the provider there.
    if (!input.reasoningEffortWithTools) return { kind: 'none' };
    return format === 'openai' || format === 'openrouter' ? openAiControl(bareId) : { kind: 'none' };
  }
  return { kind: 'none' };
}

/** The levels a control carries, in the order the picker lists them. */
export function offeredThinkingEfforts(control: ThinkingControl): ThinkingEffort[] {
  switch (control.kind) {
    case 'none':
      return [];
    case 'anthropic-budget':
      return ['off', 'low', 'high', 'max'];
    case 'anthropic-adaptive':
      return control.off === null ? ['low', 'high', 'max'] : ['off', 'low', 'high', 'max'];
    case 'reasoning-effort':
      return [...(control.none ? ['off' as const] : []), 'low', 'high', ...(control.xhigh ? ['max' as const] : [])];
    case 'switch':
      return control.effort ? ['off', 'low', 'high', 'max'] : ['off', 'high'];
  }
}

/** Anthropic `budget_tokens` for each level that thinks, on the models that take a budget. */
export const ANTHROPIC_THINKING_BUDGET = { low: 4096, high: 10000, max: 32000 } as const;
