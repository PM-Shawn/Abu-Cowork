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

/**
 * Fields that carry no revision of their own and must travel with one that
 * does (round-2 R2-C-②).
 *
 * `browserSiteGrantViaEmbed` qualifies the `'allowed'` entries in
 * `browserSitePermissions`: a scoped grant is valid inside the embedded
 * regions of the page it was given on and nowhere else. The two are always
 * written in the same `set`, so giving the scope its own counter would only
 * invent a way for them to disagree. What it must NOT do is stay behind when
 * its owner is adopted from disk — that would strip the scope off a grant the
 * other window still holds, silently promoting a one-page region grant into a
 * standing one.
 *
 * A companion the disk copy does not have is REMOVED rather than kept.
 *
 * ## What that choice really costs (round-3 R3-F)
 *
 * Everything else in this module fails CLOSED — an unreadable revision counts
 * as 0, a `setItem` that returns proves nothing, a blob that will not parse is
 * not merged. This one rule fails OPEN: dropping a scope promotes a one-page
 * region grant into a standing one.
 *
 * It is deliberate anyway, and the honest reason is narrower than "its own
 * account": a disk copy with no `browserSiteGrantViaEmbed` key was written by
 * a build that does not KNOW about marks, not by one that examined its grants
 * and declared them unmarked. Keeping this window's marks over it would be
 * just as much of a guess, and would strand a mark on a store that has no way
 * to clear it. So the rule is "the adopted state is taken whole, companions
 * included" — one store wins, not a splice of two.
 *
 * The trigger is another window running an OLDER build (or a downgrade, whose
 * v48 blob comes back through migrate unscoped). v48-v51 are unreleased and
 * shipped builds stop at v45, so in practice this is a development machine.
 * Both halves of the rule are pinned: `mergeBrowserConfigForWrite` below, and
 * `restoreBrowserConfigField` in `settingsStore.ts` — which additionally
 * NORMALIZES what it adopts, because a v50 window writes the pre-scope shape
 * (a bare `true`) and that blob never passes through `migrate`.
 */
export const BROWSER_CONFIG_COMPANION_FIELDS: Readonly<
  Partial<Record<BrowserConfigField, readonly string[]>>
> = {
  browserSitePermissions: ['browserSiteGrantViaEmbed'],
};

/** The companions of one field, or nothing. */
export function browserConfigCompanionsOf(field: BrowserConfigField): readonly string[] {
  return BROWSER_CONFIG_COMPANION_FIELDS[field] ?? [];
}

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
    // …and everything that qualifies it. See `BROWSER_CONFIG_COMPANION_FIELDS`.
    for (const companion of browserConfigCompanionsOf(field)) {
      if (companion in onDisk.state) mergedState[companion] = onDisk.state[companion];
      else delete mergedState[companion];
    }
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
  // Companions are compared too: a grant whose mark did not land is a grant
  // that reads as unmarked, which is wider than what was meant to be saved.
  return BROWSER_CONFIG_FIELDS.every(
    (field) => [field, ...browserConfigCompanionsOf(field)].every(
      (key) => JSON.stringify(stored.state[key]) === JSON.stringify(intended.state[key]),
    ),
  );
}
