import { readTextFile, writeTextFile, exists } from '@tauri-apps/plugin-fs';
import { installedManifestPath , pluginInstallDir } from './paths';

export interface InstalledPlugin {
  key: string;
  marketplace: string;
  name: string;
  version: string;
  sha?: string;
  checksum?: string;
  installedAt: string;
  /**
   * How the bytes were copied in — the `PluginSource['kind']` the installer was
   * handed, not a claim about where the package came from. Enterprise installs
   * verify the artifact first and then stage it on disk, so they all arrive as
   * `'relative'`; the field is only meaningful once an install is known not to
   * be enterprise (see `isEnterpriseInstall`).
   *
   * Optional because records written before this field existed must still
   * load; consumers that need "was this authored locally?" fall back to the
   * absence of `sha` for those (see `authored.ts`).
   */
  sourceKind?: 'relative' | 'url' | 'git-subdir';
  /**
   * What this plugin contributed to the app (skill ids, MCP server names,
   * agent directory names). Uninstall correctness is derived from this record
   * — never by rescanning directories and guessing what belonged to the plugin.
   *
   * `agents` arrived after the first records were written, so it is required
   * here but normalised on read (see {@link withContributedAgents}): every
   * consumer sees a list, and a record written before the field existed reads
   * back as `[]` rather than as `undefined` for each of them to guard.
   */
  contributed: { skills: string[]; mcpServers: string[]; agents: string[] };
}

/**
 * Outcome of reading the manifest, for callers that must tell "nothing is
 * installed" from "the manifest could not be read".
 *
 * {@link readInstalled} collapses both to `[]`, which is right for consumers
 * that only ever *grant* something from a record (skills, display names): a
 * record we cannot read contributes nothing. It is exactly wrong for a caller
 * that *narrows* a security boundary from this list — the MCP approval gate is
 * shrunk by an empty list, so a failed read would silently un-gate every
 * plugin tool. Those callers take this result and do nothing on `ok: false`.
 *
 * A missing file is a success (`plugins: []`) — that is the honest state of a
 * profile with nothing installed, and of one where everything was uninstalled.
 */
export type ReadInstalledResult =
  | { ok: true; plugins: InstalledPlugin[] }
  | { ok: false; error: unknown };

/**
 * Read the installed-plugins manifest for `home`, reporting read failures.
 *
 * Never throws: an unreadable or malformed manifest comes back as
 * `{ ok: false }` rather than as an exception, so the plugin system degrades
 * instead of locking up. Individual records that fail validation are still
 * dropped from an otherwise-successful read (see {@link isInstalledPlugin}) —
 * one bad record is not a bad file.
 */
export async function readInstalledResult(home: string): Promise<ReadInstalledResult> {
  const path = installedManifestPath(home);

  let fileExists: boolean;
  try {
    fileExists = await exists(path);
  } catch (error) {
    return { ok: false, error };
  }
  if (!fileExists) return { ok: true, plugins: [] };

  let raw: string;
  try {
    raw = await readTextFile(path);
  } catch (error) {
    return { ok: false, error };
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    // Valid JSON that is not an array is a corrupted manifest (hand-edited, or
    // a half-written file caught mid-flight), not an empty one.
    if (!Array.isArray(parsed)) return { ok: false, error: new Error('installed.json is not an array') };
    return {
      ok: true,
      plugins: parsed.filter(isInstalledPlugin).map(withValidSourceKind).map(withContributedAgents),
    };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Read the installed-plugins manifest for `home`.
 *
 * Degrades to `[]` (never throws) both when the file is missing and when its
 * contents are not valid JSON — a single corrupted manifest must not lock up
 * the whole plugin system. A caller that would *remove* a permission from this
 * list must use {@link readInstalledResult} instead, so a failed read cannot
 * read as "nothing is installed".
 */
export async function readInstalled(home: string): Promise<InstalledPlugin[]> {
  const result = await readInstalledResult(home);
  return result.ok ? result.plugins : [];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/**
 * Validate one record before anyone builds a path or a policy decision on it.
 *
 * `installed.json` is not a trusted document — it is hand-editable, synced
 * between machines, and truncatable by a crash — and every consumer sits on
 * the skill-loading path, where `loader.ts` has no guard. One malformed record
 * must not be able to take every skill down with it.
 *
 * This got sharper once `pluginInstallDir` began rejecting unsafe segments: a
 * record carrying a traversal now *throws* instead of quietly yielding a bad
 * path, so a bad record becomes a fatal one unless it is dropped right here.
 * Dropping (rather than repairing) is deliberate: a record we cannot vouch for
 * should not contribute skills or, more importantly, MCP servers.
 */
function isInstalledPlugin(value: unknown): value is InstalledPlugin {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  if (!isNonEmptyString(p.key)) return false;
  if (!isNonEmptyString(p.marketplace)) return false;
  if (!isNonEmptyString(p.name)) return false;
  if (!isNonEmptyString(p.version)) return false;

  const contributed = p.contributed as Record<string, unknown> | undefined;
  if (typeof contributed !== 'object' || contributed === null) return false;
  if (!isStringArray(contributed.skills)) return false;
  if (!isStringArray(contributed.mcpServers)) return false;

  // The segments must also survive path construction. Doing it here keeps the
  // throw contained to this one record instead of the whole read.
  try {
    pluginInstallDir('/', p.marketplace, p.name, p.version);
  } catch {
    return false;
  }
  return true;
}

/**
 * Drop a `sourceKind` that is not one of the known kinds, keeping the record.
 *
 * Unlike the identity fields above, this one is advisory: it only feeds the
 * "did I author this?" split in the UI, so a nonsense value is not worth
 * discarding an otherwise-valid install over. Dropping the field puts the
 * record back on the legacy fallback path instead of letting an unvalidated
 * string leak out typed as the union. The copy is shallow so any *other*
 * unknown key still round-trips untouched.
 */
function withValidSourceKind(p: InstalledPlugin): InstalledPlugin {
  // Typed as the union by the interface, but it came straight out of JSON and
  // nothing has checked it yet — widen before comparing.
  const raw = p.sourceKind as unknown;
  if (raw === undefined) return p;
  if (raw === 'relative' || raw === 'url' || raw === 'git-subdir') return p;
  const copy = { ...p };
  delete copy.sourceKind;
  return copy;
}

/**
 * Give a record read from disk a `contributed.agents` list.
 *
 * Records written before plugins could contribute agents have no such field,
 * and they must keep loading: an install predating the feature contributed no
 * agents, so `[]` is not a repair but the true answer. Normalising here — the
 * one place records enter the app — is what lets the interface declare the
 * field required, so uninstall and the UI can iterate it without each of them
 * inventing its own fallback. A value of the wrong shape is replaced for the
 * same reason `isInstalledPlugin` drops a bad record: nothing downstream
 * should have to ask whether this is really a list of strings.
 */
function withContributedAgents(p: InstalledPlugin): InstalledPlugin {
  // Typed as `string[]` by the interface, but it came straight out of JSON.
  const raw = (p.contributed as { agents?: unknown }).agents;
  if (isStringArray(raw)) return p;
  return { ...p, contributed: { ...p.contributed, agents: [] } };
}

async function writeInstalled(home: string, plugins: InstalledPlugin[]): Promise<void> {
  const path = installedManifestPath(home);
  await writeTextFile(path, JSON.stringify(plugins, null, 2));
}

/**
 * The manifest could not be read, so it must not be written either.
 *
 * 🔴 Every write here is read-modify-write. {@link readInstalled} collapses a
 * failed read to `[]`, which is right for a consumer that only ever *grants*
 * something — and catastrophic for a writer: an unreadable manifest would come
 * back empty, and the write would replace the user's whole install record with
 * a single entry (or, on uninstall, silently drop every other plugin). The
 * records are the only account of what is on disk, so losing them orphans
 * every installed package. Refuse instead: an install/uninstall that fails
 * loudly is recoverable, a manifest rewritten from a failed read is not.
 */
export class InstalledManifestUnreadableError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super(
      'Could not read the installed-plugins manifest (installed.json); '
      + 'refusing to rewrite it. Fix or remove the file and try again.',
    );
    this.name = 'InstalledManifestUnreadableError';
    this.cause = cause;
  }
}

/**
 * Read the records for a caller that is about to write them back.
 *
 * @throws {InstalledManifestUnreadableError} when the manifest exists but
 * cannot be read or parsed. A MISSING manifest is not a failure — that is the
 * honest empty state, and the first install must be able to create the file.
 */
export async function readInstalledForWrite(home: string): Promise<InstalledPlugin[]> {
  const result = await readInstalledResult(home);
  if (!result.ok) throw new InstalledManifestUnreadableError(result.error);
  return result.plugins;
}

/**
 * Insert `p`, or replace the existing entry with the same key.
 *
 * @throws {InstalledManifestUnreadableError} — see {@link readInstalledForWrite}.
 */
export async function upsertInstalled(home: string, p: InstalledPlugin): Promise<void> {
  const plugins = await readInstalledForWrite(home);
  const idx = plugins.findIndex((x) => x.key === p.key);
  if (idx >= 0) {
    plugins[idx] = p;
  } else {
    plugins.push(p);
  }
  await writeInstalled(home, plugins);
}

/**
 * Remove the entry with `key`. No-op (no throw, no write) if it isn't present.
 *
 * @throws {InstalledManifestUnreadableError} — see {@link readInstalledForWrite}.
 */
export async function removeInstalled(home: string, key: string): Promise<void> {
  const plugins = await readInstalledForWrite(home);
  const next = plugins.filter((x) => x.key !== key);
  if (next.length === plugins.length) return;
  await writeInstalled(home, next);
}

/** Find the entry with `key`, or `null` if not installed. */
export async function findInstalled(home: string, key: string): Promise<InstalledPlugin | null> {
  const plugins = await readInstalled(home);
  return plugins.find((x) => x.key === key) ?? null;
}

/**
 * What to call the plugin behind a `plugin:<key>` provenance label.
 *
 * The key is `${name}@${marketplace}` — accurate but not what a user calls the
 * thing, so the record's own `name` wins when the plugin is installed. An
 * unknown key falls back to the key itself: the label must still say something
 * true when a record is missing (uninstalled between a scan and a render, or a
 * hand-edited manifest).
 */
export function pluginDisplayName(installed: readonly InstalledPlugin[], key: string): string {
  return installed.find((p) => p.key === key)?.name ?? key;
}
