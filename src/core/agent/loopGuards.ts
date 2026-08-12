/**
 * Shared no-progress predicate for the agent loops.
 *
 * `allToolsUnparseable` is true when a turn produced tool calls but EVERY one
 * failed to parse (carries `_parse_error`). That's not real progress — the loop
 * can only send the parse errors back and hope the model recovers. Both
 * `subagentLoop.isNoProgressTurn` and `agentLoop`'s no-progress guard build on
 * this, extracted here so the two can't drift apart.
 *
 * An empty batch (zero tool calls) is intentionally NOT "all unparseable": a
 * pure-text turn is handled by the truncation / max-tokens-recovery paths, not
 * the no-progress guard.
 */
export function allToolsUnparseable(
  toolCalls: Array<{ input: Record<string, unknown> }>,
): boolean {
  return toolCalls.length > 0 && toolCalls.every((tc) => '_parse_error' in tc.input);
}

export type SemanticToolLoopReason =
  | 'repeated_call'
  | 'periodic_cycle'
  | 'meta_only';

export interface ToolLoopObservation {
  name: string;
  input: Record<string, unknown>;
  result: string;
  error: boolean;
}

/** Maximum history needed by the deterministic M0 semantic loop checks. */
export const SEMANTIC_TOOL_LOOP_WINDOW = 6;

const META_TOOL_NAMES = new Set([
  'tool_search',
  'use_skill',
  'read_skill_file',
  'read_me',
  'skill_view',
  'recall',
  'read_memory',
]);

function stableValue(value: unknown): unknown {
  if (typeof value === 'string') return value.trim().replace(/\s+/g, ' ');
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(source).sort().map(key => [key, stableValue(source[key])]),
    );
  }
  return value;
}

/** Small deterministic hash; keeps tool inputs/results out of retained guard state. */
function hashText(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function observationFingerprint(observation: ToolLoopObservation): string {
  const input = JSON.stringify(stableValue(observation.input));
  return `${observation.name}:${hashText(input)}:${hashText(observation.result)}:${observation.error ? 1 : 0}`;
}

/**
 * Reduce an observation before retaining it in the loop's rolling window.
 * Tool inputs/results can contain file contents or user data; the guard needs
 * only deterministic equality plus the non-sensitive tool name/error bit.
 */
export function minimizeToolLoopObservation(
  observation: ToolLoopObservation,
): ToolLoopObservation {
  return {
    name: observation.name,
    input: {
      fingerprint: hashText(JSON.stringify(stableValue(observation.input))),
    },
    result: hashText(observation.result),
    error: observation.error,
  };
}

/**
 * Detect well-formed but unproductive tool loops using only signals available in
 * M0. Repetition/cycle checks require the corresponding observable tool result
 * to stay unchanged, avoiding false positives when repeated observation calls
 * are actually seeing new state. M1 will replace this proxy with state_id.
 */
export function detectSemanticToolLoop(
  observations: ToolLoopObservation[],
): SemanticToolLoopReason | null {
  const recent = observations.slice(-SEMANTIC_TOOL_LOOP_WINDOW);
  const fingerprints = recent.map(observationFingerprint);

  const lastThree = fingerprints.slice(-3);
  if (lastThree.length === 3 && lastThree.every(value => value === lastThree[0])) {
    return 'repeated_call';
  }

  // Detect repeated periods ABAB and ABCABC inside the six-call window.
  for (const period of [2, 3]) {
    const suffix = fingerprints.slice(-(period * 2));
    if (
      suffix.length === period * 2
      && suffix.slice(0, period).every((value, index) => value === suffix[index + period])
      && new Set(suffix.slice(0, period)).size > 1
    ) {
      return 'periodic_cycle';
    }
  }

  if (
    recent.length === SEMANTIC_TOOL_LOOP_WINDOW
    && recent.every(observation => META_TOOL_NAMES.has(observation.name))
  ) {
    return 'meta_only';
  }

  return null;
}

/**
 * How many consecutive no-progress turns to tolerate before aborting the loop.
 * Shared by both agentLoop and subagentLoop so the threshold can't drift. One bad
 * turn is expected (the model gets the _parse_error results back and can recover);
 * a sustained run means a model that simply can't emit valid tool calls.
 */
export const MAX_NO_PROGRESS_TURNS = 3;

/**
 * Default turn cap used when nothing (skill / agent / global setting) specifies
 * one. An agent loop must never run unbounded by default — that's the industry
 * baseline (OpenAI Agents SDK ~10, LangChain ~15, LangGraph ~25). 200 matches
 * Claude Code's fork subagent. The no-progress guard catches a degenerate spin in
 * MAX_NO_PROGRESS_TURNS, so this cap only needs to bound the rarer "well-formed but
 * unproductive" loop — generous is fine.
 */
export const DEFAULT_MAX_TURNS = 200;

/**
 * Resolve the per-run turn cap. Shared by agentLoop and subagentLoop. Explicit
 * settings stay authoritative (skill > agent definition > global setting); only
 * when none is set do we fall back to {@link DEFAULT_MAX_TURNS} — never
 * unlimited-by-default. An explicit non-positive setting (`<= 0`) is the opt-in
 * escape hatch for truly unlimited turns (returns `Infinity`), preserving the
 * capability the old `undefined` default used to give implicitly.
 */
export function resolveMaxTurns(params: {
  skillMaxTurns?: number;
  definitionMaxTurns?: number;
  globalMaxTurns?: number;
}): number {
  const { skillMaxTurns, definitionMaxTurns, globalMaxTurns } = params;
  const explicit = skillMaxTurns ?? definitionMaxTurns ?? globalMaxTurns;
  if (explicit === undefined) return DEFAULT_MAX_TURNS;
  return explicit > 0 ? explicit : Infinity;
}

/**
 * Calculate the escalated maxOutputTokens for a max_tokens recovery turn.
 *
 * A fixed 2× that PERSISTS for every recovery (recoveryCount >= 1), so the budget
 * sequence is base → 2× → 2× → 2×, clamped to contextWindowSize - 1000. Callers
 * recompute `currentMax` from base each turn, so the escalation must be a pure
 * function of `recoveryCount`. The old one-shot `alreadyEscalated` latch made the
 * budget fall back to base on later recoveries (base → 2× → base → base) — bug #5.
 *
 * The multiplier is deliberately NOT progressive (e.g. 2^recoveryCount): the
 * recovery prompt tells the model to break remaining work into smaller pieces, so
 * a single doubling suffices, and an ever-growing budget would compound the input
 * squeeze below. Note the unavoidable tradeoff: escalation raises maxOutputTokens,
 * which lowers maxInputTokens (= contextWindowSize - maxOutputTokens) for the whole
 * recovery sequence. On large windows this is negligible; on small windows it is
 * inherent to escalating output at all (the "break into smaller pieces" prompt, not
 * a bigger budget, is the real lever there). The clamp keeps ≥1000 input tokens.
 * Pure function. Shared by agentLoop and subagentLoop (see subagentLoop.ts's
 * `MAX_OUTPUT_TOKENS_RECOVERY_LIMIT` usage) — extracted here (rather than staying
 * in agentLoop.ts) so subagentLoop doesn't have to import agentLoop's whole
 * store-import graph just to reuse this pure helper (P1-3a-pre).
 */
export function escalateMaxOutputTokens(
  currentMax: number,
  contextWindowSize: number,
  recoveryCount: number,
): { maxOutputTokens: number; changed: boolean } {
  if (recoveryCount <= 0) {
    return { maxOutputTokens: currentMax, changed: false };
  }
  const escalated = Math.min(currentMax * 2, contextWindowSize - 1000);
  if (escalated > currentMax) {
    return { maxOutputTokens: escalated, changed: true };
  }
  return { maxOutputTokens: currentMax, changed: false };
}

/**
 * Decide whether to continue the loop when a turn was cut off by max_tokens but
 * still carried complete tool calls. The Claude adapter only emits a tool_use
 * event on content_block_stop, so a call truncated mid-JSON is dropped — any
 * collected calls are complete; sending their results back lets the model resume
 * instead of the turn being discarded (legacy behavior excluded these entirely).
 *
 * We require at least one WELL-FORMED tool call (input without `_parse_error`). An
 * all-malformed batch is not real progress: continuing on it would re-prompt a
 * broken model indefinitely — agentLoop has no no-progress guard and maxTurns
 * defaults to unlimited. This mirrors the subagent's `allToolsUnparseable` guard
 * (see isNoProgressTurn). Pure. Shared by agentLoop and subagentLoop — see
 * `escalateMaxOutputTokens`'s doc comment for why this lives here.
 */
export function shouldContinueTruncatedToolCalls(
  stopReason: string,
  toolCalls: Array<{ input: Record<string, unknown> }>,
): boolean {
  return stopReason === 'max_tokens' && toolCalls.some((tc) => !('_parse_error' in tc.input));
}
