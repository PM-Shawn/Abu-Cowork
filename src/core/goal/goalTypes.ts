/**
 * Goal mode — one persistent objective per conversation that the app keeps
 * working toward, round after round, until the model reports it complete,
 * it is blocked, the user pauses it, or the round budget runs out.
 *
 * Only the durable part lives here. Whether automatic rounds may start right
 * now ("armed") is process-local state in goalActivation.ts and is never
 * persisted, so a restored goal can never resume on its own.
 */

export type GoalPhase = 'active' | 'paused' | 'blocked' | 'complete';

export type GoalBlockedCode =
  /** The model reported that no progress is possible without the user. */
  | 'model-reported'
  /** Consecutive rounds ended without any tool call and without completing. */
  | 'no-progress'
  /** The round budget is spent. */
  | 'round-limit'
  /** The next round could not be dispatched. */
  | 'dispatch-failed'
  /** Team conversation: the goal-wide member hand-off budget is spent. */
  | 'team-dispatch-limit';

export interface GoalBlockedReason {
  code: GoalBlockedCode;
  message: string;
}

export interface GoalCompletion {
  summary: string;
  evidence: string[];
}

export interface GoalState {
  id: string;
  /** Bumped on every mutation; writers must present the revision they read. */
  revision: number;
  objective: string;
  phase: GoalPhase;
  blockedReason?: GoalBlockedReason;
  maxRounds: number;
  roundsStarted: number;
  /** Rounds in a row that ended with no tool call and no completion. */
  consecutiveIdleRounds: number;
  /** Team conversations only: member hand-offs spent across all rounds. */
  teamDispatches?: number;
  completion?: GoalCompletion;
  /**
   * The run (loopId) that completed or blocked the goal. Only that run gets
   * the "write a closing note, no more tools" wrap-up in its context tail.
   */
  settledLoopId?: string;
  createdAt: number;
  updatedAt: number;
}

/** Compare-and-set handle: the goal a writer read, at the revision it read. */
export interface GoalRef {
  id: string;
  revision: number;
}

export const GOAL_OBJECTIVE_MAX_CHARS = 2000;
export const GOAL_DEFAULT_MAX_ROUNDS = 256;
export const GOAL_MIN_MAX_ROUNDS = 1;
export const GOAL_MAX_MAX_ROUNDS = 1000;
/** The model may report `blocked` only after this many rounds (same as DSH). */
export const GOAL_BLOCK_AFTER_ROUNDS = 3;
/** Idle rounds in a row that stop the goal as `no-progress`. */
export const GOAL_MAX_IDLE_ROUNDS = 2;
/** Goal-wide cap on team member hand-offs (the per-run cap resets each round). */
export const GOAL_TEAM_MAX_DISPATCHES = 200;
/** Rounds added by the goal bar's "run more" once the budget is spent. */
export const GOAL_RESUME_EXTRA_ROUNDS = 20;
export const GOAL_COMPLETION_SUMMARY_MAX_CHARS = 4000;
export const GOAL_COMPLETION_EVIDENCE_MAX_ITEMS = 20;
export const GOAL_COMPLETION_EVIDENCE_MAX_CHARS = 500;

export function goalRef(goal: Pick<GoalState, 'id' | 'revision'>): GoalRef {
  return { id: goal.id, revision: goal.revision };
}

const PHASES: ReadonlySet<string> = new Set<GoalPhase>(['active', 'paused', 'blocked', 'complete']);
const BLOCKED_CODES: ReadonlySet<string> = new Set<GoalBlockedCode>([
  'model-reported',
  'no-progress',
  'round-limit',
  'dispatch-failed',
  'team-dispatch-limit',
]);

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Validate a goal read back from disk (index.json) or any other untrusted
 * copy. Returns undefined for anything malformed, so a corrupt entry drops
 * the goal instead of crashing the conversation load.
 */
export function sanitizeGoalState(value: unknown): GoalState | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || !raw.id) return undefined;
  if (!isNonNegativeInt(raw.revision) || raw.revision < 1) return undefined;
  if (typeof raw.objective !== 'string' || !raw.objective.trim()) return undefined;
  if (typeof raw.phase !== 'string' || !PHASES.has(raw.phase)) return undefined;
  if (!isNonNegativeInt(raw.maxRounds) || raw.maxRounds < GOAL_MIN_MAX_ROUNDS) return undefined;
  if (!isNonNegativeInt(raw.roundsStarted)) return undefined;
  if (typeof raw.createdAt !== 'number' || typeof raw.updatedAt !== 'number') return undefined;

  const goal: GoalState = {
    id: raw.id,
    revision: raw.revision,
    objective: raw.objective.slice(0, GOAL_OBJECTIVE_MAX_CHARS),
    phase: raw.phase as GoalPhase,
    maxRounds: Math.min(raw.maxRounds, GOAL_MAX_MAX_ROUNDS),
    roundsStarted: raw.roundsStarted,
    consecutiveIdleRounds: isNonNegativeInt(raw.consecutiveIdleRounds) ? raw.consecutiveIdleRounds : 0,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
  if (isNonNegativeInt(raw.teamDispatches)) goal.teamDispatches = raw.teamDispatches;
  if (typeof raw.settledLoopId === 'string' && (raw.phase === 'complete' || raw.phase === 'blocked')) {
    goal.settledLoopId = raw.settledLoopId;
  }

  const blocked = raw.blockedReason as Record<string, unknown> | undefined;
  if (goal.phase === 'blocked') {
    goal.blockedReason = blocked
      && typeof blocked.code === 'string' && BLOCKED_CODES.has(blocked.code)
      && typeof blocked.message === 'string'
      ? { code: blocked.code as GoalBlockedCode, message: blocked.message }
      : { code: 'model-reported', message: '' };
  }

  const completion = raw.completion as Record<string, unknown> | undefined;
  if (goal.phase === 'complete' && completion && typeof completion.summary === 'string') {
    goal.completion = {
      summary: completion.summary,
      evidence: Array.isArray(completion.evidence)
        ? completion.evidence.filter((item): item is string => typeof item === 'string')
        : [],
    };
  }
  return goal;
}
