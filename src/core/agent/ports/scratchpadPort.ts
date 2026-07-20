import { useScratchpadStore, type ScratchpadEntry } from '@/stores/scratchpadStore';
import { createPortSlot } from './portSlot';

/**
 * Port abstracting agentLoop's single write to scratchpadStore: the
 * `addScratchpadEntry` callback threaded into `createEventRouter`'s deps
 * (see `eventRouter.ts`'s `EventRouterDeps.addScratchpadEntry` — a DI seam
 * that already keeps `eventRouter.ts` itself free of any direct store
 * import for this call; this port is the *implementation* agentLoop.ts's
 * call site plugs into that seam).
 *
 * A dedicated one-method file rather than folding into `ChatDelta` or
 * `ExecutionPort`: scratchpad entries are a distinct store
 * (`scratchpadStore.ts`, not `chatStore`/`taskExecutionStore`) with no
 * shared lifecycle or write cadence with either — the existing precedent in
 * this directory (`C-REPORT.md` §0: "one file per port... each targets a
 * different store with a different future out-of-process shape") argues for
 * the same split here, not consolidation.
 *
 * NOTE: `eventRouter.ts` separately imports `shouldCaptureScratchpad` /
 * `inferScratchpadType` / `generateScratchpadTitle` / `truncateScratchpadContent`
 * directly from `scratchpadStore.ts` — those are classification/formatting
 * helpers (not store writes) used to decide *whether* and *how* to build the
 * entry passed into this port's `addEntry`. They are a separate import-graph
 * finding (see P1-3b-pre-REPORT.md's import-classification table) and are
 * NOT covered by this port, which only wraps the one write call agentLoop.ts
 * itself makes.
 */
export interface ScratchpadPort {
  /** Mirrors scratchpadStore's `addEntry` 1:1 (including its `string` (new
   *  entry id) return value) — this is a low-frequency, one-shot write, so
   *  per `ChatDelta`'s "Discrete family" precedent the port mirrors the
   *  store's own vocabulary rather than inventing new naming. */
  addEntry(entry: Omit<ScratchpadEntry, 'id' | 'timestamp' | 'isViewed'>): string;
}

/** Default in-process implementation over the Zustand store's synchronous
 *  getState(). This is the seam a future out-of-process agent runtime
 *  (headless Node sidecar) would replace with an IPC/RPC-backed
 *  implementation. */
export function createInProcessScratchpadPort(): ScratchpadPort {
  return {
    addEntry: (entry) => useScratchpadStore.getState().addEntry(entry),
  };
}

/** Module-level slot for the app-wide default ScratchpadPort — see
 *  `portSlot.ts` for the shared get/set/swap-hook contract every port in
 *  this directory follows. */
const slot = createPortSlot<ScratchpadPort>(createInProcessScratchpadPort);

export function getScratchpadPort(): ScratchpadPort {
  return slot.get();
}

export function setScratchpadPort(port: ScratchpadPort): void {
  slot.set(port);
}
