import { useDiscoveredCapsStore, type DiscoveredCaps } from '@/stores/discoveredCapabilitiesStore';
import { createPortSlot } from './portSlot';

/**
 * Port abstracting agentLoop's reads AND writes of discoveredCapabilitiesStore
 * — the persisted, error-derived overrides for a model's max_tokens/context
 * window/reasoning-observed flag (see discoveredCapabilitiesStore.ts's
 * top-of-file doc for why the store exists: the static capability registry
 * can be stale or wrong, so a 400 response's real limit gets remembered and
 * used pre-emptively next time).
 *
 * Unlike `SettingsReader`/`ChatDelta`'s clean read/write split, this port
 * combines both directions: agentLoop's `get()` (capability resolution,
 * once per turn) and the three `record*` writes (fired when the adapter
 * observes a real limit or reasoning behavior) target the SAME store, and
 * the write is meant to be visible to the *next* turn's `get()` — a
 * write-then-later-reread loop, not two independent read/write families.
 * In-process this is trivially satisfied (both directions hit the same
 * synchronous Zustand store).
 *
 * ⚠️ Out-of-process caveat: a future out-of-process implementation of this
 * port MUST NOT fire-and-forget the `record*` writes to a remote/shell
 * store without an ack or a synchronously-updated local mirror. If a write
 * hasn't landed (or hasn't been mirrored locally) by the time the next
 * turn's `get()` runs in this same process, that reread observes a stale
 * value — reintroducing exactly the "retries with the same wrong limit and
 * 400s again" bug this store exists to prevent. Implement either (a) an
 * awaited ack before `record*` resolves, or (b) a local read-through mirror
 * updated synchronously on write, ahead of the async forward to the remote
 * store.
 *
 * Same call-time-not-cached discipline as the other ports in this
 * directory: every method re-fetches `useDiscoveredCapsStore.getState()` at
 * call time, never memoized.
 */
export interface CapsPort {
  /** Mirrors discoveredCapabilitiesStore's `get`. */
  get(providerId: string, modelId: string): DiscoveredCaps | undefined;
  /** Mirrors discoveredCapabilitiesStore's `recordMaxOutputTokens`. */
  recordMaxOutputTokens(providerId: string, modelId: string, limit: number): void;
  /** Mirrors discoveredCapabilitiesStore's `recordContextWindow`. */
  recordContextWindow(providerId: string, modelId: string, window: number): void;
  /** Mirrors discoveredCapabilitiesStore's `recordReasoningObserved`. */
  recordReasoningObserved(providerId: string, modelId: string): void;
}

/** Default in-process implementation over the Zustand store's synchronous
 *  getState(). This is the seam a future out-of-process agent runtime
 *  (headless Node sidecar) would replace — see this file's top-level JSDoc
 *  for the ack/mirror requirement any such implementation must satisfy. */
export function createInProcessCapsPort(): CapsPort {
  return {
    get: (providerId, modelId) => useDiscoveredCapsStore.getState().get(providerId, modelId),
    recordMaxOutputTokens: (providerId, modelId, limit) =>
      useDiscoveredCapsStore.getState().recordMaxOutputTokens(providerId, modelId, limit),
    recordContextWindow: (providerId, modelId, window) =>
      useDiscoveredCapsStore.getState().recordContextWindow(providerId, modelId, window),
    recordReasoningObserved: (providerId, modelId) =>
      useDiscoveredCapsStore.getState().recordReasoningObserved(providerId, modelId),
  };
}

/** Module-level slot for the app-wide default CapsPort — see `portSlot.ts`
 *  for the shared get/set/swap-hook contract every port in this directory
 *  follows. All core/ callers that don't receive an explicit port via
 *  options should go through `getCapsPort()` instead of constructing their
 *  own in-process port, so there's a single seam to flip when the headless
 *  Node runtime starts up (see `setCapsPort`, which must honor the
 *  ack/mirror requirement documented above). */
const slot = createPortSlot<CapsPort>(createInProcessCapsPort);

export function getCapsPort(): CapsPort {
  return slot.get();
}

export function setCapsPort(port: CapsPort): void {
  slot.set(port);
}
