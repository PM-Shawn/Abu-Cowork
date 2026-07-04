/**
 * Registry directory watcher (skills + agents).
 *
 * The in-memory skill/agent registries (`skillLoader` / `agentRegistry`) are only
 * rebuilt on app boot, workspace switch, or an explicit install/create. Dropping a
 * folder straight into `~/.abu/skills/` or `~/.abu/agents/` (the intuitive "just
 * put it in the directory" flow) would otherwise not show up until a restart.
 *
 * This watcher observes BOTH registry dirs and triggers a debounced discovery
 * refresh (which re-scans skills and agents together) on any change, so manually
 * added / removed skills and agents appear live.
 */

import { watch, exists, mkdir, type UnwatchFn } from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';
import { joinPath } from '../../utils/pathUtils';
import { useDiscoveryStore, getLastDiscoveryRefreshAt } from '../../stores/discoveryStore';

let unwatchers: UnwatchFn[] = [];
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

// Monotonic token: every start/stop bumps it, invalidating any in-flight start().
// This makes start/stop safe under React StrictMode's mount→cleanup→mount, where a
// stop can run while an earlier start is still awaiting watch() (which would
// otherwise orphan the watcher it goes on to create).
let generation = 0;

/** Coalesce bursts of file events (an install writes many files) into one refresh. */
const DEBOUNCE_MS = 800;
/** If a discovery refresh ran within this window, treat our event as its echo and skip. */
const ECHO_WINDOW_MS = 1500;

function scheduleRefresh(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    // Skip the redundant re-scan when an explicit install already refreshed just now.
    if (Date.now() - getLastDiscoveryRefreshAt() < ECHO_WINDOW_MS) return;
    void useDiscoveryStore.getState().refresh();
  }, DEBOUNCE_MS);
}

function teardown(): void {
  for (const un of unwatchers) {
    try { un(); } catch { /* best-effort */ }
  }
  unwatchers = [];
}

/**
 * Start watching `~/.abu/skills/` and `~/.abu/agents/`. Idempotent and race-safe:
 * a start superseded by a later stop/start (generation bump) tears down anything
 * it created instead of leaking it. Failures are logged and swallowed.
 */
export async function startRegistryWatcher(): Promise<void> {
  const myGen = ++generation;
  teardown(); // drop any previous watchers before (re)starting
  try {
    const home = await homeDir();
    const dirs = [joinPath(home, '.abu', 'skills'), joinPath(home, '.abu', 'agents')];
    const created: UnwatchFn[] = [];
    for (const dir of dirs) {
      if (myGen !== generation) { created.forEach((u) => u()); return; } // superseded
      if (!(await exists(dir))) await mkdir(dir, { recursive: true });
      const un = await watch(dir, () => scheduleRefresh(), { recursive: true, delayMs: 500 });
      if (myGen !== generation) { un(); created.forEach((u) => u()); return; } // superseded mid-flight
      created.push(un);
    }
    if (myGen !== generation) { created.forEach((u) => u()); return; }
    unwatchers = created;
    console.log('[RegistryWatcher] Watching', dirs.join(', '));
  } catch (err) {
    console.warn('[RegistryWatcher] Failed to start:', err);
  }
}

/** Stop the watcher and cancel any pending refresh. Idempotent. */
export function stopRegistryWatcher(): void {
  generation++; // invalidate any in-flight start()
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  teardown();
}
