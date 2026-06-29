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
