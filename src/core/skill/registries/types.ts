/**
 * Registry adapter interface — the contract any third-party skill
 * source (CLAWhub, DiDi internal SkillsHub, future registries)
 * implements. Adapters are pluggable so adding a new registry is
 * a single new file + one call to `registerAdapter()`.
 *
 * Design choices worth knowing
 * ----------------------------
 * - `install()` returns the `.askill` bytes rather than writing to
 *   disk itself. All install flows converge on `unpackSkill()`
 *   (packager.ts), which handles validation, conflict detection,
 *   and atomic write. An adapter that wrote to disk directly would
 *   bypass that hardened path.
 *
 * - `isAvailable()` is async and non-throwing. Adapters may need to
 *   run a command or check a binary path to decide; they should
 *   swallow errors and return false rather than bubbling up. This
 *   keeps the "which registries can I use right now?" UI snappy
 *   even when some registries are offline / misconfigured.
 *
 * - No global token / auth handling here. If a registry needs a
 *   token, it stores / reads it through the settingsStore using a
 *   key scoped by adapter id (`skillRegistries.<id>.token`). The
 *   adapter interface stays clean.
 *
 * Adapters must not be registered automatically from this file —
 * bootstrap happens in a callsite that the app controls, so the
 * test suite can register mocks without importing the real ones.
 */

/** A single entry returned by `list()` / `find()`. */
export interface SkillListItem {
  /** Registry-scoped identifier (what `install()` takes back). */
  id: string;
  /** Human-readable name shown in the browse UI. */
  name: string;
  description?: string;
  author?: string;
  /** Tags for filtering / display; free-form strings. */
  tags?: string[];
  /** Newer = better, registry-local semantics (semver / date / hash). */
  version?: string;
  /** Optional link back to the registry's own detail page. */
  url?: string;
}

export interface RegistryCapabilities {
  /** Can the adapter list skills? (If false, only `install()` works.) */
  canList: boolean;
  /** Does the adapter support text search via `find()`? */
  canSearch: boolean;
  /** Does the registry require a token / login? */
  requiresAuth: boolean;
}

export interface RegistryAdapter {
  /** Stable identifier — used as settingsStore scope key. */
  readonly id: string;
  /** Shown to users in the registry picker. */
  readonly displayName: string;
  /** One-line description — why you'd browse this registry. */
  readonly description?: string;
  readonly capabilities: RegistryCapabilities;
  /**
   * Is this registry usable right now? Typical checks:
   * - required binary on PATH (for CLI-backed adapters)
   * - token set in settings (for authenticated adapters)
   * - network reachable (for public-HTTP adapters)
   *
   * Must never throw. Return false on any failure so the UI can
   * show an "unavailable" state instead of crashing.
   */
  isAvailable(): Promise<boolean>;
  /** List all skills in the registry (may be paginated in the future). */
  list?(): Promise<SkillListItem[]>;
  /** Keyword search. Falls back to filtered list() if adapter doesn't implement. */
  find?(query: string): Promise<SkillListItem[]>;
  /**
   * Fetch a skill's `.askill` bytes so it can be handed to
   * `unpackSkill()`. Adapters that can't produce a single archive
   * (e.g. git-based ones) assemble the archive in memory here.
   */
  install(id: string): Promise<Uint8Array>;
}
