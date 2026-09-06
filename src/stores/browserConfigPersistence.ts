/**
 * Per-field merge and save confirmation for the browser authorization settings
 * (S18).
 *
 * ## The problem this solves
 *
 * `settingsStore` persists through zustand's `persist` middleware, which writes
 * the WHOLE partialized blob on every change. Each window holds its own
 * in-memory copy, so with two windows open the second one to write does not
 * merge — it overwrites, with values it read when it was opened. A user who
 * blocks a site in one window and then changes an operation row in another
 * silently loses the block. Nothing warned them, and the gate went on reading
 * the value they thought they had removed.
 *
 * The fix is scoped to the three fields where that is a SAFETY problem rather
 * than an annoyance — `browserOperationPolicy`, `browserSitePermissions`,
 * `allowUnattendedBrowser`. Each carries its own monotonic revision, and a
 * write keeps whichever side of each field is newer. The rest of the blob keeps
 * the last-writer-wins behaviour it has always had; widening this to every
 * setting would be a different change with a much larger blast radius.
 *
 * ## Why revisions rather than timestamps
 *
 * Two windows on one machine share a clock, but not a monotonic one: a clock
 * that steps backwards (NTP, sleep, a manual change) would make an older write
 * look newer, and the failure would be a silently restored permission. A
 * counter that is read from disk and incremented past it cannot go backwards,
 * whatever the clock does.
 *
 * This module is pure. It parses, compares and merges; the storage adapter that
 * uses it is in `settingsStore.ts`.
 */

/** The fields this module arbitrates, by their `SettingsState` key. */
export const BROWSER_CONFIG_FIELDS = [
  'browserOperationPolicy',
  'browserSitePermissions',
  'allowUnattendedBrowser',
] as const;

export type BrowserConfigField = (typeof BROWSER_CONFIG_FIELDS)[number];

/** One counter per field, persisted alongside the values they order. */
export type BrowserConfigRevisions = Record<BrowserConfigField, number>;

export const INITIAL_BROWSER_CONFIG_REVISIONS: BrowserConfigRevisions = {
  browserOperationPolicy: 0,
  browserSitePermissions: 0,
  allowUnattendedBrowser: 0,
};

/** The shape zustand's `persist` puts in storage. */
export interface PersistedSettingsBlob {
  state: Record<string, unknown>;
  version?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read the revision map out of a persisted blob, clamping anything unusable to
 * 0.
 *
 * 0 for a missing or corrupt counter is deliberate and safe in the direction
 * that matters: it makes THIS side look older, so a live write wins over it
 * rather than a corrupt file silently freezing a field.
 */
export function readBrowserConfigRevisions(state: unknown): BrowserConfigRevisions {
  const raw = isRecord(state) && isRecord(state.browserConfigRevisions)
    ? state.browserConfigRevisions
    : {};
  const revisions = { ...INITIAL_BROWSER_CONFIG_REVISIONS };
  for (const field of BROWSER_CONFIG_FIELDS) {
    const value = raw[field];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      revisions[field] = value;
    }
  }
  return revisions;
}

/** Parse a raw storage string into a blob, or null if it is absent/unusable. */
export function parsePersistedSettings(raw: string | null): PersistedSettingsBlob | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !isRecord(parsed.state)) return null;
    return {
      state: parsed.state,
      ...(typeof parsed.version === 'number' ? { version: parsed.version } : {}),
    };
  } catch {
    // A corrupt blob is not a reason to refuse the write that would replace it.
    return null;
  }
}

/**
 * The revision a field should carry after this edit: past whatever is in memory
 * AND whatever is on disk.
 *
 * Reading disk here is what makes a stale window's edit still WIN for the field
 * it touched. Bumping only the in-memory counter would leave a window that has
 * been open a while permanently behind, and its edits would be discarded by the
 * merge below — the same silent loss, arrived at from the other direction.
 */
export function nextBrowserConfigRevision(
  field: BrowserConfigField,
  inMemory: BrowserConfigRevisions,
  onDisk: BrowserConfigRevisions,
): number {
  return Math.max(inMemory[field], onDisk[field]) + 1;
}

export interface BrowserConfigMergeResult {
  merged: PersistedSettingsBlob;
  /**
   * Fields where the value ON DISK was newer and has been kept. The caller
   * folds these back into memory: the window that lost is now displaying a
   * value that is not what is stored, and a settings pane that shows a
   * permission the gate will not honour is the failure this whole module is
   * about.
   */
  adopted: BrowserConfigField[];
}

/**
 * Combine the blob about to be written with the one already stored, field by
 * field, keeping whichever revision is higher.
 *
 * Everything outside `BROWSER_CONFIG_FIELDS` is taken from `outgoing`
 * unchanged — this is a targeted merge, not a general-purpose one.
 */
export function mergeBrowserConfigForWrite(
  outgoing: PersistedSettingsBlob,
  onDisk: PersistedSettingsBlob | null,
): BrowserConfigMergeResult {
  if (onDisk === null) return { merged: outgoing, adopted: [] };

  const outgoingRevisions = readBrowserConfigRevisions(outgoing.state);
  const diskRevisions = readBrowserConfigRevisions(onDisk.state);
  const mergedState = { ...outgoing.state };
  const mergedRevisions = { ...outgoingRevisions };
  const adopted: BrowserConfigField[] = [];

  for (const field of BROWSER_CONFIG_FIELDS) {
    if (diskRevisions[field] <= outgoingRevisions[field]) continue;
    // A field the other window edited more recently. Note that a field the
    // disk simply HAS and we do not is not adopted on that basis alone: equal
    // revisions mean neither side has newer news, and the writer keeps its own.
    if (!(field in onDisk.state)) continue;
    mergedState[field] = onDisk.state[field];
    mergedRevisions[field] = diskRevisions[field];
    adopted.push(field);
  }

  mergedState.browserConfigRevisions = mergedRevisions;
  return {
    merged: {
      state: mergedState,
      ...(outgoing.version !== undefined ? { version: outgoing.version } : {}),
    },
    adopted,
  };
}

/**
 * Did the write actually land? Compares what is now in storage against what was
 * meant to be written, for the browser fields only.
 *
 * This is the difference between 「已保存」 and a green tick with nothing behind
 * it. The PRD is explicit that an unconfirmed save must not be reported as a
 * confirmed one, and a `setItem` that returns without throwing is not by itself
 * evidence — a quota-exceeded write can be partially applied, and storage the
 * browser has disabled swallows writes entirely in some engines.
 */
export function browserConfigWasStored(
  intended: PersistedSettingsBlob,
  storedRaw: string | null,
): boolean {
  const stored = parsePersistedSettings(storedRaw);
  if (stored === null) return false;
  return BROWSER_CONFIG_FIELDS.every(
    (field) => JSON.stringify(stored.state[field]) === JSON.stringify(intended.state[field]),
  );
}
