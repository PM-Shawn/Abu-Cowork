import computerUsePolicy from '@/core/tools/computerUsePolicy.json';

const { eventRecoveryLimit, turnRecoveryLimit } = computerUsePolicy.progressPolicy;

/**
 * What the privileged tier observed about an action's execution.
 *
 * This must come from a structured Host receipt, never from parsing an error
 * message: the difference between "refused before touching the app" and "sent,
 * result unread" is the difference between a safe retry and a double submit,
 * and error text is not evidence of either.
 */
export type ExecutionOutcome = 'not-executed' | 'dispatched' | 'outcome-unknown';

/**
 * `observe-once` — re-observe and let the model choose again. It never replays
 * the old action, because the old action provably did not run.
 * `handoff` — end the turn and give control back to the user.
 * `stop` — the turn is already stopped; do not recover, do not observe.
 */
export type RecoveryDecision = 'observe-once' | 'handoff' | 'stop';

export interface RecoveryBudgetKey {
  conversationId: string;
  loopId: string;
}

/**
 * Stable key for one run. Lengths are encoded so that a conversation id
 * containing the separator cannot impersonate another run's key.
 */
export function runBudgetKey(key: RecoveryBudgetKey): string {
  return `${key.conversationId.length}:${key.conversationId}:${key.loopId}`;
}

interface RunBudget {
  /** Recoveries spent since the last verified progress. */
  eventRecoveries: number;
  /** Recoveries spent across the whole run; verified progress does not refund these. */
  turnRecoveries: number;
}

/**
 * Bounded automatic recovery for Computer Use.
 *
 * Without a bound, an action that keeps being refused turns into a tool that
 * spins: observe, retry, refuse, observe… The budget is deliberately small and
 * asymmetric — one retry per event so a transient refusal costs the user
 * nothing, and a hard per-run ceiling so alternating progress and failure
 * cannot buy unlimited retries.
 *
 * Only `not-executed` is ever recovered. `dispatched` and `outcome-unknown`
 * both mean the action may have changed the world, and re-running it could
 * change it twice.
 *
 * Thresholds live in `computerUsePolicy.json` alongside the no-progress ones so
 * the recovery policy has a single home rather than a third set of literals —
 * see `computerUseProgressPolicy.contract.test.ts` for why that matters here.
 */
export function createRecoveryBudget() {
  const runs = new Map<string, RunBudget>();

  function getOrCreate(key: string): RunBudget {
    const existing = runs.get(key);
    if (existing) return existing;
    const created: RunBudget = { eventRecoveries: 0, turnRecoveries: 0 };
    runs.set(key, created);
    return created;
  }

  function decide(key: string, execution: ExecutionOutcome, stopped: boolean): RecoveryDecision {
    if (stopped) return 'stop';
    if (execution !== 'not-executed') return 'handoff';

    const budget = getOrCreate(key);
    if (budget.eventRecoveries >= eventRecoveryLimit) return 'handoff';
    if (budget.turnRecoveries >= turnRecoveryLimit) return 'handoff';

    budget.eventRecoveries += 1;
    budget.turnRecoveries += 1;
    return 'observe-once';
  }

  /**
   * Marks that the run genuinely moved forward, freeing the per-event budget.
   * The per-turn total is deliberately not refunded.
   */
  function recordVerifiedProgress(key: string): void {
    const budget = runs.get(key);
    if (!budget) return;
    budget.eventRecoveries = 0;
  }

  /** Called from the run's normal, aborted and errored cleanup paths alike. */
  function clear(key: string): void {
    runs.delete(key);
  }

  return { decide, recordVerifiedProgress, clear };
}

export const recoveryBudget = createRecoveryBudget();
