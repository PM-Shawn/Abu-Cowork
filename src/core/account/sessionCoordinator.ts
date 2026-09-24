export type AccountSessionKind = 'personal' | 'enterprise';

export type AccountSessionRollback = () => Promise<void>;

export interface AccountSessionDeactivation {
  rollback: AccountSessionRollback;
  commit?: () => Promise<void> | void;
}

type AccountSessionDeactivator = () => Promise<AccountSessionDeactivation | void>;

const deactivators = new Map<AccountSessionKind, AccountSessionDeactivator>();
let transitionQueue: Promise<void> = Promise.resolve();

/**
 * Registers the implementation that clears one account session from this device.
 * The public host owns the coordination contract; each account module owns its
 * own credentials and deactivation behavior.
 */
export function registerAccountSessionDeactivator(
  kind: AccountSessionKind,
  deactivate: AccountSessionDeactivator,
): () => void {
  deactivators.set(kind, deactivate);
  return () => {
    if (deactivators.get(kind) === deactivate) deactivators.delete(kind);
  };
}

/**
 * Serializes account switches and clears every other account session before
 * committing the newly authenticated session.
 */
export function activateExclusiveAccountSession(
  kind: AccountSessionKind,
  activate: () => Promise<AccountSessionRollback | void>,
  canActivate: () => boolean = () => true,
): Promise<boolean> {
  const transition = transitionQueue.then(async () => {
    if (!canActivate()) return false;

    const deactivated: AccountSessionDeactivation[] = [];
    let rollbackActivation: AccountSessionRollback | void;
    let rollbackAttempted = false;
    const rollback = async () => {
      if (rollbackAttempted) return;
      rollbackAttempted = true;
      const failures: unknown[] = [];
      if (rollbackActivation) {
        await rollbackActivation().catch((error) => failures.push(error));
      }
      for (const session of [...deactivated].reverse()) {
        await session.rollback().catch((error) => failures.push(error));
      }
      if (failures.length > 0) throw new AggregateError(failures, 'account_session_rollback_failed');
    };

    try {
      for (const [registeredKind, deactivate] of deactivators) {
        if (registeredKind === kind) continue;
        const result = await deactivate();
        if (result) deactivated.push(result);
      }
      if (!canActivate()) {
        await rollback();
        return false;
      }
      rollbackActivation = await activate();
      if (!canActivate()) {
        await rollback();
        return false;
      }
    } catch (error) {
      try {
        await rollback();
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'account_session_transition_failed',
          { cause: rollbackError },
        );
      }
      throw error;
    }

    await Promise.allSettled(deactivated.map(({ commit }) => commit?.()));
    return true;
  });

  transitionQueue = transition.then(() => undefined, () => undefined);
  return transition;
}
