/**
 * The warning a run gets before it runs out of steps.
 *
 * A run stops at maxTurns and nothing tells the model beforehand, so a run that
 * leaves saving or delivering for last can end with nothing delivered. The note
 * travels in the per-request volatile tail (see `buildVolatileContextTail`), after
 * the cached history, so it never changes the cached prefix, and it is not stored
 * in the conversation: a note seen on one request is gone from the next. It is
 * therefore given on every step from the threshold on, with the count of steps
 * left as of that step, and in its own wording on the last request (tool calls it returns still run; the run just gets no further request). A pure function
 * of the step number, so a retried step gets the same note again.
 */

/** Share of maxTurns left when the warning first appears (200 steps: 20 left). */
const STEP_BUDGET_FRACTION = 0.1;
/** Fewest steps left at the first warning, so a small cap still gets a useful notice. */
const STEP_BUDGET_FLOOR = 5;

/** Steps left (this one included) at which the warning first appears. */
export function stepBudgetThreshold(maxTurns: number): number {
  return Math.max(STEP_BUDGET_FLOOR, Math.ceil(maxTurns * STEP_BUDGET_FRACTION));
}

/**
 * The note for request number `turnCount` (1-based) of a run capped at `maxTurns`,
 * or undefined. Runs capped below twice the threshold are short enough that the
 * model needs no warning.
 */
export function stepBudgetNote(turnCount: number, maxTurns: number): string | undefined {
  if (!Number.isFinite(maxTurns)) return undefined;
  const threshold = stepBudgetThreshold(maxTurns);
  if (maxTurns < threshold * 2) return undefined;
  const left = maxTurns - turnCount + 1;
  if (left === 1) {
    return '[This is the last model request in this run. You can still call the save tool in this one, but you will not get another request to summarise. Save every file the user asked for now, in a usable state.]';
  }
  if (left > 1 && left <= threshold) {
    return `[Only ${left} steps are left in this run. Make sure every file the user asked for is saved now in a usable state, before any further polishing.]`;
  }
  return undefined;
}
