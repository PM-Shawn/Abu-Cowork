/**
 * Shows whether committed localStorage reached the start of a plugin operation.
 *
 * The operation journal stores the connector configuration and child
 * preferences the renderer had in memory at `begin`. Chromium commits
 * localStorage seconds after a write, so a process that dies before the commit
 * restarts with older values, and recovery cannot tell those older values from
 * a change the user made while the operation ran.
 *
 * Chromium applies an origin's localStorage writes in order and commits each
 * batch atomically as the full state at one moment, so the committed state is
 * always a prefix of the write sequence. The renderer writes this marker after
 * taking the snapshot and before `begin`; every change the user makes during
 * the operation is written after it. Committed storage without the marker
 * therefore predates the snapshot and holds none of those changes. Committed
 * storage with the marker holds everything the snapshot was taken from.
 *
 * The order holds for writes from one renderer, over its one connection to the
 * storage area. User changes to the stores behind the snapshot (MCP, settings,
 * plugins) are made in the main window; the pet window sends its position to
 * the main window instead of writing settings (see `usePetDrag`).
 *
 * One key per operation: a new operation never overwrites the evidence of one
 * whose journal still exists. A key is removed only once its journal is gone.
 */

const PREFIX = 'abu-plugin-operation:';

/** Write a new marker and return it for the `begin` request. */
export function writePluginOperationMarker(): string {
  const marker = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  localStorage.setItem(PREFIX + marker, '1');
  return marker;
}

export function pluginOperationMarkerStored(marker: string): boolean {
  return localStorage.getItem(PREFIX + marker) !== null;
}

/**
 * What recovery has applied, under the key the journal names in `progress`.
 * Each entry is written after the change it names, so a committed entry means
 * that change is committed too.
 */
export function pluginOperationProgress(progress: string): string[] {
  const raw = localStorage.getItem(PREFIX + progress);
  if (raw === null) return [];
  const entries: unknown = JSON.parse(raw);
  if (!Array.isArray(entries) || entries.some(entry => typeof entry !== 'string')) throw new Error('Plugin recovery progress is invalid');
  return entries;
}

export function writePluginOperationProgress(progress: string, entries: string[]): void {
  localStorage.setItem(PREFIX + progress, JSON.stringify(entries));
}

/** Only for a key whose journal the host has acknowledged or never wrote. */
export function forgetPluginOperationMarker(marker: string): void {
  localStorage.removeItem(PREFIX + marker);
}
