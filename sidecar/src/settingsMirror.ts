/**
 * Sidecar-GLOBAL (NOT per-run) settings mirror — P1-3B-3A item 2 / design doc
 * §3 "settingsReader" row: "镜像 + state.settings 推送...比 3a 的 per-run 冻结强
 * （主循环可长跑）". Unlike the 3a subagent path (a short-lived run, frozen
 * settings snapshot for its whole lifetime is an acceptable simplification —
 * see `subagentHost.ts`'s doc), a main-loop run can be long (minutes of
 * streaming + many tool turns); freezing settings for its whole duration
 * would mean a user changing e.g. `maxOutputTokens`/`computerUseEnabled`
 * mid-run never takes effect until the NEXT loop. So settings live in ONE
 * shared mirror, updated by every `state.settings` push
 * (`agentLoopRunner.ts`'s 50ms-debounced `useSettingsStore.subscribe` —
 * shell-side, P1-3b-2), and every run's injected `SettingsReader` (via
 * `AgentLoopOptions.settingsReader`) reads through to this SAME shared
 * mirror — "latest push wins; reads always return the current mirror", per
 * the design doc.
 *
 * Seeded per-run from that run's OWN `settingsSnapshot` param ONLY the FIRST
 * time (i.e. if no push has landed yet) — `seedIfEmpty` is a no-op once a
 * real value exists, so a late-starting run never regresses an
 * already-fresher mirror with its own (possibly staler, dispatch-time)
 * snapshot.
 */
import type { SettingsReader } from '@/core/agent/ports/settingsReader';
import type { SettingsState } from '@/stores/settingsStore';

let current: SettingsState | undefined;

/** `state.settings` notification handler — always wins (most recent, live). */
export function applySettingsSnapshot(snapshot: SettingsState): void {
  current = snapshot;
}

/** Seed the mirror from a run's dispatch-time snapshot, but ONLY if nothing has landed yet (never regresses a fresher push). */
export function seedSettingsMirrorIfEmpty(snapshot: SettingsState): void {
  if (current === undefined) current = snapshot;
}

/** Test-only reset. */
export function __resetSettingsMirror(): void {
  current = undefined;
}

const reader: SettingsReader = {
  getSnapshot: () => {
    if (current === undefined) {
      throw new Error(
        '[sidecar] settingsMirror read before any settingsSnapshot was seeded/pushed — agentLoopHost.ts must call seedSettingsMirrorIfEmpty() before running a loop.',
      );
    }
    return current;
  },
};

/** The single shared SettingsReader every run's `AgentLoopOptions.settingsReader` should be set to. */
export function getSettingsMirrorReader(): SettingsReader {
  return reader;
}
