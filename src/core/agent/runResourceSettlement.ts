/**
 * Run-owned settlement barrier for sidecar → shell requests that may outlive
 * the sidecar transport which initiated them. A scoped run seals this owner
 * only after its sidecar execution can no longer start another request, then
 * waits for every request that already entered the shell to settle.
 */
export interface RunResourceSettlement {
  readonly signal: AbortSignal | undefined;
  readonly settlement: Promise<void>;
  readonly sealed: boolean;
  run<T>(operation: () => Promise<T>): Promise<T>;
  seal(): void;
}

export function createRunResourceSettlement(
  signal?: AbortSignal,
  onResourceStart?: () => void,
): RunResourceSettlement {
  let pending = 0;
  let sealed = false;
  let resolveSettlement!: () => void;
  const settlement = new Promise<void>((resolve) => {
    resolveSettlement = resolve;
  });

  const resolveIfSettled = (): void => {
    if (sealed && pending === 0) resolveSettlement();
  };

  return {
    signal,
    settlement,
    get sealed() {
      return sealed;
    },
    async run<T>(operation: () => Promise<T>): Promise<T> {
      if (sealed) {
        const error = new Error('Run resource owner is already sealed');
        error.name = 'AbortError';
        throw error;
      }
      onResourceStart?.();
      pending += 1;
      try {
        return await operation();
      } finally {
        pending -= 1;
        resolveIfSettled();
      }
    },
    seal(): void {
      if (sealed) return;
      sealed = true;
      resolveIfSettled();
    },
  };
}

const owners = new Map<string, RunResourceSettlement>();

export function registerRunResourceSettlement(runId: string, owner: RunResourceSettlement): void {
  owners.set(runId, owner);
}

export function getRunResourceSettlement(runId: string): RunResourceSettlement | undefined {
  return owners.get(runId);
}

export function unregisterRunResourceSettlement(
  runId: string,
  owner?: RunResourceSettlement,
): void {
  if (owner && owners.get(runId) !== owner) return;
  owners.delete(runId);
}

/** Test-only reset for dynamically re-imported runner suites. */
export function __resetRunResourceSettlementsForTests(): void {
  for (const owner of owners.values()) owner.seal();
  owners.clear();
}
