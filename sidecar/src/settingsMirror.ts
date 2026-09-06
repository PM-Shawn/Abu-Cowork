/**
 * Sidecar-GLOBAL (NOT per-run) settings mirror — P1-3B-3A item 2 / design doc
 * §3 "settingsReader" row: "镜像 + state.settings 推送...比 3a 的 per-run 冻结强
 * （主循环可长跑）". A main-loop run can be long (minutes of streaming + many
 * tool turns); freezing settings for its whole duration would mean a user
 * changing e.g. `maxOutputTokens`/`allowUnattendedBrowser` mid-run never takes
 * effect until the NEXT loop. So settings live in ONE shared mirror, updated by
 * every `state.settings` push (`agentLoopRunner.ts`'s 50ms-debounced
 * `useSettingsStore.subscribe` — shell-side, P1-3b-2), and every run's injected
 * `SettingsReader` (via `AgentLoopOptions.settingsReader`) reads through to this
 * SAME shared mirror.
 *
 * Seeded per-run from that run's OWN `settingsSnapshot` param ONLY the FIRST
 * time (i.e. if no push has landed yet) — `seedIfEmpty` is a no-op once a
 * real value exists, so a late-starting run never regresses an
 * already-fresher mirror with its own (possibly staler, dispatch-time)
 * snapshot.
 *
 * ## Monotonic revisions (config-batch4, 2026-09-06)
 *
 * "Latest push wins" used to mean "latest ARRIVAL wins", which is not the same
 * thing. The shell debounces its pushes by 50ms and fires them through
 * `notifySidecar` — a fire-and-forget notification with no ordering guarantee
 * once two of them are in flight. Two rapid setting changes could therefore
 * land out of order, and the mirror would keep the OLDER one: a user who turned
 * the unattended browser master switch OFF could have it silently restored by a
 * late-arriving push carrying the pre-change snapshot, and the gate would then
 * read a permission the user had just taken away.
 *
 * So every push carries a shell-side monotonic `revision`, and a push whose
 * revision is not strictly greater than the last applied one is DROPPED. The
 * revision is required: a push without one cannot be ordered against anything,
 * and applying an unorderable snapshot is exactly the regression this exists to
 * prevent (`DEVELOPMENT-PLAN.md` §3: 「缺版本拒绝作为执行依据」). The shell and
 * the sidecar ship in the same binary, so there is no older producer to be
 * compatible with.
 *
 * The seed is deliberately NOT a revision: it is a run's dispatch-time snapshot,
 * not a point on the shell's push timeline, so it fills an empty mirror without
 * ever claiming an order relative to a push. The first real push (revision ≥ 0)
 * then supersedes it.
 */
import type { SettingsReader } from '@/core/agent/ports/settingsReader';
import type { SettingsState } from '@/stores/settingsStore';

let current: SettingsState | undefined;
/**
 * The highest revision applied so far. `undefined` means no PUSH has landed
 * (the mirror may still hold a seeded snapshot), so the first push of any
 * revision — including 0 — is accepted.
 */
let appliedRevision: number | undefined;

/**
 * `state.settings` notification handler.
 *
 * Applies the snapshot only when `revision` is strictly newer than the last
 * applied one. Returns whether it was applied, so the caller can log a dropped
 * push rather than silently swallowing it.
 */
export function applySettingsSnapshot(snapshot: SettingsState, revision: number): boolean {
  if (!Number.isFinite(revision)) return false;
  if (appliedRevision !== undefined && revision <= appliedRevision) return false;
  current = snapshot;
  appliedRevision = revision;
  return true;
}

/** Seed the mirror from a run's dispatch-time snapshot, but ONLY if nothing has landed yet (never regresses a fresher push). */
export function seedSettingsMirrorIfEmpty(snapshot: SettingsState): void {
  if (current === undefined) current = snapshot;
}

/** Test-only reset. */
export function __resetSettingsMirror(): void {
  current = undefined;
  appliedRevision = undefined;
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
