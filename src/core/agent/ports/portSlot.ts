/**
 * Shared accessor-slot boilerplate for the agent runtime's "port" seam
 * pattern used by every file in this directory (`SettingsReader`,
 * `ChatDelta`, `ConversationReader`, `CapsPort`, `ExecutionPort`,
 * `WorkspaceReader`, ...): each port module holds a single module-level
 * "current implementation" — defaulting to an in-process Zustand-backed one
 * — a `getXxx()` accessor that every real call site goes through, and a
 * `setXxx()` one-time swap hook reserved for a future out-of-process
 * (headless Node sidecar) implementation to register itself at startup.
 *
 * `createPortSlot()` factors that repeated `let current = createDefault();
 * get() { return current } set(v) { current = v }` shape into one place.
 * Each port file still exports its own `getXxxPort`/`setXxxPort` names —
 * thin aliases over the slot's `.get()`/`.set()` — so no external caller
 * needs to change; only the six ports' internal plumbing does.
 */
export interface PortSlot<T> {
  /** Returns the currently-registered implementation (the in-process
   *  default until `set()` is called). */
  get(): T;
  /** Swaps in a new implementation. Intended as a one-time call at runtime
   *  startup (e.g. a future headless Node runtime registering its
   *  IPC/RPC-backed implementation) — not a per-call toggle. */
  set(value: T): void;
}

export function createPortSlot<T>(createDefault: () => T): PortSlot<T> {
  let current: T = createDefault();
  return {
    get: () => current,
    set: (value: T) => {
      current = value;
    },
  };
}
