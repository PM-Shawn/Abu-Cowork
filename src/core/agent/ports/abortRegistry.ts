import { useChatStore } from '@/stores/chatStore';
import { createPortSlot } from './portSlot';

/**
 * Port abstracting agentLoop's AbortController trio on chatStore: the
 * per-conversation cancellation-signal registry that makes the LLM stream +
 * tool loop abortable via the UI's stop button (and the concurrency guard at
 * `runAgentLoop`'s entry, which checks whether a controller already exists
 * for a conversation before deciding to enqueue vs. start a new loop).
 *
 * Inventory (verified by grepping the whole repo, not assumed): agentLoop.ts
 * is the ONLY caller of `hasAbortController`/`getAbortController`/
 * `clearAbortController` outside chatStore.ts itself and its own test —
 * `setAbortController` doesn't exist as a separate action (chatStore's
 * `getAbortController` lazily creates-and-registers one on first access, see
 * `chatStore.ts`'s `abortControllers` module-level `Map`). So this port's
 * three methods are the *complete* surface agentLoop consumes, not a
 * best-guess subset.
 *
 * This is the future CONTROL channel (per
 * `docs/2026-07-19-phase1-p3-loop-migration-staging.md` §2's "P1-3b" —
 * "abort 三件套…走 control"): in a headless Node sidecar, cancellation can't
 * be a synchronous shared `Map` between the loop and the UI's stop button —
 * it becomes a `runId`-keyed control-plane message the shell sends the
 * sidecar (mirroring the `subagent.abort` notification the 3a design already
 * planned for the mini-loop, per the staging doc's step 3a-3). The default
 * in-process implementation below is the exact current behavior (chatStore's
 * `Map`), so this port is a pure indirection today — zero behavior change —
 * until a sidecar-side control-channel implementation registers itself via
 * `setAbortRegistry`.
 *
 * Same call-time-not-cached discipline as the other ports in this directory:
 * every method re-fetches `useChatStore.getState()` at call time.
 */
export interface AbortRegistry {
  /** Mirrors chatStore's `hasAbortController`. */
  hasAbortController(convId: string): boolean;
  /** Mirrors chatStore's `getAbortController` — lazily creates one if none
   *  exists yet for `convId` (this is chatStore's real behavior, not this
   *  port's invention; see chatStore.ts's `getAbortController`). */
  getAbortController(convId: string): AbortController;
  /** Mirrors chatStore's `clearAbortController`. */
  clearAbortController(convId: string): void;
}

/** Default in-process implementation over the Zustand store's synchronous
 *  getState(). This is the seam a future out-of-process agent runtime
 *  (headless Node sidecar) would replace with a control-channel-backed
 *  implementation — see this file's top-level JSDoc. */
export function createInProcessAbortRegistry(): AbortRegistry {
  return {
    hasAbortController: (convId) => useChatStore.getState().hasAbortController(convId),
    getAbortController: (convId) => useChatStore.getState().getAbortController(convId),
    clearAbortController: (convId) => useChatStore.getState().clearAbortController(convId),
  };
}

/** Module-level slot for the app-wide default AbortRegistry — see
 *  `portSlot.ts` for the shared get/set/swap-hook contract every port in
 *  this directory follows. All core/ callers that don't receive an explicit
 *  registry via options should go through `getAbortRegistry()` instead of
 *  constructing their own in-process registry, so there's a single seam to
 *  flip when the headless Node runtime starts up (see `setAbortRegistry`). */
const slot = createPortSlot<AbortRegistry>(createInProcessAbortRegistry);

export function getAbortRegistry(): AbortRegistry {
  return slot.get();
}

export function setAbortRegistry(registry: AbortRegistry): void {
  slot.set(registry);
}
