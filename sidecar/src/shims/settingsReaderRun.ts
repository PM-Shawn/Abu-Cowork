/**
 * Sidecar-local replacement for `src/core/agent/ports/settingsReader.ts`.
 *
 * NOT a behavior shim — a BUNDLE-GRAPH shim, discovered by
 * `scripts/build-sidecar.mjs`'s fail-fast guard (P1-3a design doc §2 item
 * 9). `subagentLoop.ts` calls `options.settingsReader ?? getSettingsReader()`
 * — a fallback that is PROVABLY never taken in the sidecar (`subagentHost.ts`
 * always passes an explicit per-run `settingsReader`). But esbuild can't
 * see that at bundle time: the `getSettingsReader` import is syntactically
 * present and called, so the REAL module's default factory
 * (`createInProcessSettingsReader`, which imports `useSettingsStore` from
 * `src/stores/settingsStore.ts`) gets bundled anyway — dragging in that
 * store's entire zustand/persist/secretStore graph purely because of a
 * runtime-dead branch.
 *
 * This shim keeps the same public shape (`getSettingsReader`/
 * `setSettingsReader`) but its default throws instead of constructing a
 * real store-backed reader. If it's ever ACTUALLY called, that means
 * `subagentHost.ts` dispatched a `SubagentLoopOptions` without a
 * `settingsReader` — a real wiring bug — and throwing loudly here catches
 * it immediately instead of silently running the loop against wrong/empty
 * settings (which would NOT be an acceptable no-op — this throw is the
 * "escalate cleanly instead of silently degrade" the card requires).
 */
import type { SettingsReader } from '@/core/agent/ports/settingsReader';

function throwingDefault(): SettingsReader {
  return {
    getSnapshot: () => {
      throw new Error(
        '[sidecar] getSettingsReader() fallback reached inside the sidecar bundle — subagentHost.ts should always inject an explicit settingsReader for every sidecar-run subagent. This indicates a wiring bug in subagentHost.ts, not a legitimate "no settings available" case.',
      );
    },
  };
}

let current: SettingsReader = throwingDefault();

export function getSettingsReader(): SettingsReader {
  return current;
}

export function setSettingsReader(reader: SettingsReader): void {
  current = reader;
}
