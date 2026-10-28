/**
 * Quota failover: when a model's budget is spent mid-run, retry the same turn
 * on another enabled model instead of terminating the run.
 *
 * Run-scoped by design: the run stays on the failover model once switched, and
 * the user's `activeModel` setting is untouched — switching a user's
 * configured model as a side effect of a run is not expected behavior. The
 * guard is `ProfileHarness.guards.quotaFailover` (default true), so a family
 * that must never fail over can opt out.
 */
import type { ActiveModel } from '../../types/provider';
import type { SettingsState } from '../../stores/settingsStore';
import { getModelUnavailableReason } from '../../utils/settingsSelectors';
import { LLMError } from '../llm/adapter';
import type { LLMErrorCode } from '../llm/adapter';

/** How many candidate models a single run may try after the primary fails. */
export const MAX_FAILOVER_ATTEMPTS = 2;

/** Error codes that say "this model/provider has no budget left right now". */
const FAILOVER_CODES: ReadonlySet<LLMErrorCode> = new Set<LLMErrorCode>([
  'quota_exceeded',
  'rate_limit',
]);

export function isFailoverWorthyError(err: unknown): err is LLMError {
  if (!(err instanceof LLMError)) return false;
  // The user aborted: switching models would override the decision to stop.
  if (err.code === 'cancelled') return false;
  return FAILOVER_CODES.has(err.code);
}

/**
 * Ordered candidate models to try when the current model fails with a
 * failover-worthy error: the user's favorites first, then recently used
 * models, then the first enabled provider's first model as a floor. The
 * current model, unavailable entries (removed/disabled provider, deleted
 * model) and duplicates are filtered out.
 */
export function buildFailoverChain(
  settings: Pick<SettingsState, 'providers' | 'favoriteModels' | 'recentModels'>,
  current: ActiveModel,
): ActiveModel[] {
  const seen = new Set<string>([key(current)]);
  const chain: ActiveModel[] = [];
  const push = (ref: ActiveModel | undefined | null) => {
    if (!ref) return;
    const k = key(ref);
    if (seen.has(k)) return;
    if (getModelUnavailableReason(settings, ref) !== null) return;
    seen.add(k);
    chain.push({ providerId: ref.providerId, modelId: ref.modelId });
  };
  for (const ref of settings.favoriteModels ?? []) push(ref);
  for (const ref of settings.recentModels ?? []) push(ref);
  // Floor: the first enabled provider whose first model is not already in the
  // chain (the first provider may be the one that just failed).
  const floor = settings.providers.find((p) => p.enabled
    && p.models.length > 0
    && !seen.has(`${p.id}::${p.models[0].id}`));
  if (floor) push({ providerId: floor.id, modelId: floor.models[0].id });
  return chain.slice(0, MAX_FAILOVER_ATTEMPTS);
}

function key(ref: ActiveModel): string {
  return `${ref.providerId}::${ref.modelId}`;
}

/**
 * A label for user-facing copy and logs: `providerId/modelId`.
 */
export function failoverModelLabel(ref: ActiveModel): string {
  return `${ref.providerId}/${ref.modelId}`;
}

/** Mutable per-run failover state, threaded through the run's turns. */
export interface FailoverState {
  /** Ordered candidates still untried. */
  chain: ActiveModel[];
  /** The model the run has switched to, if any. */
  active: ActiveModel | null;
}

export function createFailoverState(chain: ActiveModel[]): FailoverState {
  return { chain, active: null };
}

/** Take the next candidate, or null when the chain is exhausted. */
export function nextFailoverCandidate(state: FailoverState): ActiveModel | null {
  if (state.chain.length === 0) return null;
  const next = state.chain.shift()!;
  state.active = next;
  return next;
}
