/**
 * Hard bounds for one team run (in-conversation team, "全程自主" batch).
 *
 * Aligned with DSH's goal layer (packages/goal/tool-goal: maxGoalRounds 256,
 * blockedAfterConsecutiveRounds default 3, both enforced in code) and Codex's
 * "3 exec failures → Blocked": the loop stays simple, the bound lives in the
 * dispatch tools and refuses loudly so the leader must stop and report.
 *
 * Pure module (no stores): the dispatch tools run inside the sidecar.
 * Keyed by the leader loop id; only the owning run can retire its entry.
 */

/** Hand-offs (delegate calls + batch tasks) one leader run may make. */
export const TEAM_MAX_DISPATCHES_PER_RUN = 40;
/** A member that fails this many hand-offs in a row is blocked for the run. */
export const TEAM_MAX_CONSECUTIVE_FAILURES_PER_MEMBER = 3;
/**
 * FLOOR for the leader's own turn budget, applied ONLY over a positive explicit
 * `maxTurns` on its role card. A leader spends turns on planning, dispatching,
 * reviewing every result and reporting; a member-sized 30-turn card capped the
 * whole run at one hand-off's allowance, so such a value is raised to this
 * number. A leader card with NO maxTurns is left alone — the user's global
 * 最大轮次 setting (and DEFAULT_MAX_TURNS) still decide, as for any root run.
 * A card value <= 0 (resolveMaxTurns' own "unlimited" opt-in, see loopGuards.ts)
 * is also left alone — the floor never clamps an explicit unlimited budget
 * down to 120.
 *
 * 120 sits above TEAM_MAX_DISPATCHES_PER_RUN (40 hand-offs, so ~3 turns per
 * hand-off for dispatch + review + follow-up) and below WorkBuddy's 150-200
 * orchestrator budget; TEAM_MAX_DISPATCHES_PER_RUN stays the bound that
 * actually stops a runaway run.
 */
export const TEAM_LEADER_MAX_TURNS = 120;

interface RunBounds {
  dispatches: number;
  consecutiveFailures: Map<string, number>;
}

const runs = new Map<string, RunBounds>();

function boundsFor(loopId: string): RunBounds {
  let entry = runs.get(loopId);
  if (!entry) {
    entry = { dispatches: 0, consecutiveFailures: new Map() };
    runs.set(loopId, entry);
  }
  return entry;
}

export type DispatchRefusal =
  | { ok: false; reason: 'run_cap'; max: number; used: number }
  | { ok: false; reason: 'member_blocked'; member: string; failures: number };

export type DispatchAdmission = { ok: true } | DispatchRefusal;

/**
 * Check `members` (one entry per hand-off about to start) against the run's
 * bounds and, when admitted, count them. Refusals count nothing.
 */
export function admitDispatches(loopId: string, members: readonly string[]): DispatchAdmission {
  const entry = boundsFor(loopId);
  if (entry.dispatches + members.length > TEAM_MAX_DISPATCHES_PER_RUN) {
    return { ok: false, reason: 'run_cap', max: TEAM_MAX_DISPATCHES_PER_RUN, used: entry.dispatches };
  }
  for (const member of members) {
    const failures = entry.consecutiveFailures.get(member) ?? 0;
    if (failures >= TEAM_MAX_CONSECUTIVE_FAILURES_PER_MEMBER) {
      return { ok: false, reason: 'member_blocked', member, failures };
    }
  }
  entry.dispatches += members.length;
  return { ok: true };
}

/** A hand-off settled: success resets the member's streak, failure extends it. */
export function recordDispatchOutcome(loopId: string, member: string, succeeded: boolean): void {
  const entry = boundsFor(loopId);
  if (succeeded) entry.consecutiveFailures.delete(member);
  else entry.consecutiveFailures.set(member, (entry.consecutiveFailures.get(member) ?? 0) + 1);
}

/** Snapshot for tests / diagnostics. */
export function getRunBounds(loopId: string): { dispatches: number; consecutiveFailures: Record<string, number> } {
  const entry = runs.get(loopId);
  return {
    dispatches: entry?.dispatches ?? 0,
    consecutiveFailures: Object.fromEntries(entry?.consecutiveFailures ?? []),
  };
}

export function clearRunBounds(loopId: string): void {
  runs.delete(loopId);
}
