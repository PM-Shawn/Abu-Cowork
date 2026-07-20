/**
 * Sidecar-local replacement for the bare `@tauri-apps/plugin-os` package
 * (P1-3d-4). Only `platform()` is exported — the sole export any
 * sidecar-reachable caller uses (`src/core/tools/helpers/toolHelpers.ts`'s
 * `getSystemInfoData()`, a dead-in-the-sidecar function — see below — pulled
 * in incidentally because `toolHelpers.ts` is a shared module also used by
 * the read-path file tools this batch migrates, e.g. `resizeImageIfNeeded`/
 * `extractOfficeText`/`listArchiveContents`).
 *
 * `getSystemInfoData()` itself is NEVER called from a locally-executed tool
 * today (`get_system_info`, its only caller, is not in `localTools/index.ts`'s
 * registry) — this shim exists purely so `toolHelpers.ts` as a WHOLE FILE is
 * bundle-safe (ES module semantics: importing any one named export from a
 * module evaluates ALL of that module's top-level imports, including the
 * unused `platform` import), not because this code path is expected to run.
 * Still implemented with REAL behavior (not a throwing stub) rather than
 * relying on that "never called" assumption staying true forever — cheap to
 * get right, and `src/utils/platform.ts`'s own sidecar shim
 * (`platformRun.ts`) already established the exact same `node:os.platform()`
 * mapping this reuses, so there's no new logic to get wrong.
 */
import { platform as nodePlatform } from 'node:os';

/** Matches `@tauri-apps/plugin-os`'s real `Os` union. Only the three values
 *  `node:os.platform()` can actually distinguish on this app's supported
 *  targets (macOS/Windows/Linux — see `utils/platform.ts`'s `Platform`
 *  union) are mapped precisely; the rest are included only for type-shape
 *  completeness with the real package and are unreachable here. */
type TauriOs = 'linux' | 'macos' | 'ios' | 'freebsd' | 'dragonfly' | 'netbsd' | 'openbsd' | 'solaris' | 'android' | 'windows';

/** The real `@tauri-apps/plugin-os` export is SYNCHRONOUS (`platform(): Platform`)
 *  — matched exactly here, not wrapped in a Promise, even though every
 *  sidecar-reachable call site (`toolHelpers.ts`'s `Promise.all([platform(), ...])`)
 *  would work fine either way (Promise.all/await accept a plain value). */
export function platform(): TauriOs {
  const p = nodePlatform();
  if (p === 'win32') return 'windows';
  if (p === 'darwin') return 'macos';
  return 'linux';
}
