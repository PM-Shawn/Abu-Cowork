/**
 * Sidecar-local replacement for `src/core/agent/ports/capsPort.ts`.
 *
 * Same bundle-graph reasoning as `settingsReaderRun.ts`/`toolInvokerRun.ts`
 * — the REAL module's default factory imports `useDiscoveredCapsStore`
 * from `src/stores/discoveredCapabilitiesStore.ts`. `subagentHost.ts`
 * always injects a per-run `capsPort` (see that file), so this default is
 * provably unreached; throws if it ever is (wiring-bug signal, not a
 * legitimate empty-state case).
 */
import type { CapsPort } from '@/core/agent/ports/capsPort';

function throwingDefault(): CapsPort {
  const throwFn = (): never => {
    throw new Error(
      '[sidecar] getCapsPort() fallback reached inside the sidecar bundle — subagentHost.ts should always inject an explicit capsPort. This indicates a wiring bug.',
    );
  };
  return {
    get: throwFn,
    recordMaxOutputTokens: throwFn,
    recordContextWindow: throwFn,
    recordReasoningObserved: throwFn,
  };
}

let current: CapsPort = throwingDefault();

export function getCapsPort(): CapsPort {
  return current;
}

export function setCapsPort(port: CapsPort): void {
  current = port;
}
