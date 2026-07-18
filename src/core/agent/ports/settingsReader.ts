import { useSettingsStore, type SettingsState } from '@/stores/settingsStore';

/**
 * Port abstracting agentLoop's reads of settingsStore.
 *
 * Intentionally minimal: a single `getSnapshot()` action. The distinction
 * between "entry snapshot" (provider identity, pinned once at loop start)
 * and "per-turn snapshot" (mid-loop-tunable knobs like computerUseEnabled/
 * maxOutputTokens/contextWindowSize) is NOT modeled here — that anti-bleed
 * semantic lives in the caller (agentLoop.ts), which must call
 * `getSnapshot()` independently at each point and never cache or merge the
 * two results. See agentLoop.ts's `settings` vs `freshSettings` comment for
 * the invariant this protects (a global model switch mid-loop must never
 * bleed into an in-flight conversation on a different model).
 */
export interface SettingsReader {
  getSnapshot(): Readonly<SettingsState>;
}

/** Default in-process implementation over the Zustand store's synchronous
 *  getState(). This is the seam a future out-of-process agent runtime
 *  (headless Node sidecar) would replace with an IPC/RPC-backed
 *  implementation.
 *
 *  The snapshot is a shallow copy with all function-valued properties
 *  (store actions) stripped. `getState()` actually returns the full
 *  `SettingsStore` (state + actions); returning it as-is would smuggle
 *  invisible bound methods past the `SettingsState` label — harmless
 *  in-process, but methods cannot cross a process boundary, so an
 *  IPC-backed reader would return a structurally different object. Strip
 *  here so both readers return the same data-only shape from day one.
 *  Shallow copy keeps nested references (e.g. `activeModel`) identical
 *  across snapshots, so reference comparisons against store-derived
 *  values keep working. SettingsState has no function-valued data fields
 *  (verified), so the typeof filter cannot drop real data. */
export function createInProcessSettingsReader(): SettingsReader {
  return {
    getSnapshot: () => {
      const full = useSettingsStore.getState() as unknown as Record<string, unknown>;
      const snapshot: Record<string, unknown> = {};
      for (const key of Object.keys(full)) {
        if (typeof full[key] !== 'function') snapshot[key] = full[key];
      }
      return snapshot as Readonly<SettingsState>;
    },
  };
}

let current: SettingsReader = createInProcessSettingsReader();

/** Module-level accessor for the app-wide default SettingsReader. All core/
 *  callers that don't receive an explicit reader via options should go
 *  through this instead of constructing their own in-process reader, so
 *  there's a single seam to flip when the headless Node runtime starts up
 *  (see `setSettingsReader`). */
export function getSettingsReader(): SettingsReader {
  return current;
}

/** One-time swap hook for a future out-of-process (IPC/RPC-backed) reader,
 *  to be called once at Node runtime startup. Not used anywhere yet — the
 *  in-process default remains active until a real out-of-process
 *  implementation exists. */
export function setSettingsReader(reader: SettingsReader): void {
  current = reader;
}
