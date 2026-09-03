/**
 * Plugin installation: resolve a marketplace entry to a package directory,
 * describe what installing it would bring in, and put it on disk.
 *
 * ## Source support (deliberate MVP boundary)
 *
 * Only `relative` sources — packages vendored inside a marketplace directory
 * the user already has locally — install today. `url` / `git-subdir` need a
 * git fetch with sha pinning, which is main-process work (network + shell) and
 * is the next batch; they fail with a typed `UnsupportedSourceError` rather
 * than a vague crash, and `resolveSourceDir` is the single seam to widen.
 *
 * This is a real slice, not a toy: Anthropic's official marketplace is a git
 * clone on disk with 55 of its 291 entries vendored as `./plugins/<name>`, so
 * those install end-to-end right now.
 *
 * ## Trust boundary
 *
 * Everything read here comes from a third party. Two guards matter:
 *   - `assertInsideDir` — no path in a manifest may resolve outside its own
 *     package (or, for the source itself, outside the marketplace).
 *   - name agreement — the manifest's `name` must match what the marketplace
 *     advertised, otherwise the disclosure the user approved would describe a
 *     different package than the one installed.
 */

import { readTextFile, exists, readDir } from '@tauri-apps/plugin-fs';
import { joinPath, normalizeSeparators } from '../../utils/pathUtils';
import { MANIFEST_CANDIDATES, parsePluginManifest, type PluginManifest } from './manifest';
import type { MarketplaceEntry, PluginSource } from './marketplace';
import { pluginInstallDir, pluginKey, pluginRoot } from './paths';
import { collectPluginSymlinks } from './fsOps';
import type { InstalledPlugin } from './installedStore';

/** A source kind that exists in the ecosystem but that we cannot fetch yet. */
export class UnsupportedSourceError extends Error {
  readonly kind: PluginSource['kind'];

  constructor(kind: PluginSource['kind']) {
    super(`Plugin source "${kind}" is not supported yet — only marketplace-local packages install today.`);
    this.name = 'UnsupportedSourceError';
    this.kind = kind;
  }
}

/** A third-party package tried to reach outside its own boundary. */
export class PluginSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginSecurityError';
  }
}

/** Collapse `.`/`..` segments without touching the filesystem. */
function normalizeAbsolute(path: string): string {
  const normalized = normalizeSeparators(path);
  const isAbsolute = normalized.startsWith('/');
  const out: string[] = [];
  for (const segment of normalized.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(segment);
  }
  return (isAbsolute ? '/' : '') + out.join('/');
}

/**
 * Throw unless `candidate` resolves inside `base`.
 *
 * Compares on segment boundaries so `/m/pevil` is not accepted as being
 * inside `/m/p`.
 */
export function assertInsideDir(base: string, candidate: string): void {
  const normalizedBase = normalizeAbsolute(base);
  const normalizedCandidate = normalizeAbsolute(candidate);
  if (normalizedCandidate === normalizedBase) return;
  if (!normalizedCandidate.startsWith(`${normalizedBase}/`)) {
    throw new PluginSecurityError(
      `Refusing a path that resolves outside its package: ${candidate}`,
    );
  }
}

/** Absolute directory a marketplace entry's package lives in. */
export function resolveSourceDir(source: PluginSource, marketplaceDir: string): string {
  if (source.kind !== 'relative') throw new UnsupportedSourceError(source.kind);
  const resolved = normalizeAbsolute(joinPath(marketplaceDir, source.path));
  assertInsideDir(marketplaceDir, resolved);
  return resolved;
}

/**
 * Read a package's manifest, trying the {@link MANIFEST_CANDIDATES} in
 * order: `.abu-plugin`, then `.claude-plugin`, then `.codex-plugin`. The
 * first one present wins, even if a later one would also parse.
 */
export async function readManifestFrom(packageDir: string): Promise<PluginManifest> {
  for (const candidate of MANIFEST_CANDIDATES) {
    const path = joinPath(packageDir, candidate);
    if (!(await exists(path))) continue;
    const raw = await readTextFile(path);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Plugin manifest is not valid JSON: ${path}`);
    }
    return parsePluginManifest(parsed);
  }
  throw new Error(
    `No plugin manifest found in ${packageDir} (looked for ${MANIFEST_CANDIDATES.join(', ')})`,
  );
}

/** Skill directory names the package ships under `skills/`. */
async function discoverSkills(packageDir: string): Promise<string[]> {
  const skillsDir = joinPath(packageDir, 'skills');
  if (!(await exists(skillsDir))) return [];
  const entries = await readDir(skillsDir);
  return entries
    .filter((e) => e.isDirectory)
    .map((e) => e.name)
    .sort();
}

export interface InstallDisclosure {
  key: string;
  name: string;
  marketplace: string;
  version?: string;
  manifest: PluginManifest;
  sourceDir: string;
  /** Skill directory names this plugin will register. */
  skills: string[];
  /** MCP servers it will register — the command is the part users must see. */
  mcpServers: { name: string; command?: string; args?: string[]; url?: string }[];
  capabilities?: string[];
  /**
   * Top-level payload dirs Abu does NOT consume (commands / agents / hooks —
   * the Claude/Codex ecosystem ships these; Abu routes agents to the Team view
   * and does not run the others). Surfaced so the user is not surprised when
   * part of a plugin silently does nothing here.
   */
  ignoredPayloads: string[];
  /**
   * Package-relative paths of symlinks the copy will REFUSE to bring in
   * (`copyPluginDir` neither follows nor recreates a link — see its doc).
   * Disclosed so a package that ships one does not install silently
   * incomplete.
   *
   * Optional because a disclosure can legitimately be produced by a surface
   * whose artifact format cannot express a symlink at all (the organization
   * installer inflates a zip with fflate, which only ever yields real files),
   * and such a surface has nothing to report. `planInstall` always sets it.
   */
  skippedSymlinks?: string[];
}

/** Payload dirs the ecosystem uses that Abu deliberately does not consume. */
const IGNORED_PAYLOAD_DIRS = ['commands', 'agents', 'hooks'] as const;

/** Which of the ignored payload dirs this package actually ships. */
async function discoverIgnoredPayloads(packageDir: string): Promise<string[]> {
  const present: string[] = [];
  for (const dir of IGNORED_PAYLOAD_DIRS) {
    if (await exists(joinPath(packageDir, dir))) present.push(dir);
  }
  return present;
}

export interface PlanInstallOptions {
  marketplaceName: string;
  marketplaceDir: string;
  entry: Pick<MarketplaceEntry, 'name' | 'source'>;
  /** Required for remote (`url`/`git-subdir`) sources; unused for relative. */
  home?: string;
  /**
   * Privileged fetcher (the `plugin_git_fetch` IPC). When absent, remote
   * sources keep failing with `UnsupportedSourceError` — callers that cannot
   * fetch (tests, headless surfaces) degrade exactly as before.
   */
  fetchRemote?: (source: PluginSource, destDir: string) => Promise<{ destDir: string; sha: string }>;
}

/**
 * Where a remote source is fetched before the user confirms: a sha-scoped
 * staging area *inside* the packages root (the only root the privileged side
 * accepts), separate from the versioned install dirs. Downloading is not
 * granting — nothing is recorded or registered until the user confirms; this
 * directory is just verified bytes waiting for a decision.
 */
function remoteStagingDir(home: string, marketplace: string, name: string, sha: string): string {
  return joinPath(pluginRoot(home), marketplace, name, '_remote', sha);
}

/**
 * Describe what installing this entry would bring in, without writing anything.
 * This is the data behind the install disclosure screen — in particular the
 * MCP server commands, which are arbitrary executables.
 */
export async function planInstall(opts: PlanInstallOptions): Promise<InstallDisclosure> {
  const source = opts.entry.source;
  let sourceDir: string;
  if (source.kind === 'relative') {
    sourceDir = resolveSourceDir(source, opts.marketplaceDir);
  } else if (opts.fetchRemote && opts.home) {
    // Refuse unpinned entries before any network work; the privileged side
    // enforces this too, but failing here keeps the error close to the data.
    if (!('sha' in source) || !source.sha) {
      throw new PluginSecurityError('remote plugin source must declare a sha');
    }
    const staging = remoteStagingDir(opts.home, opts.marketplaceName, opts.entry.name, source.sha);
    const fetched = await opts.fetchRemote(source, staging);
    // Disclose from the fetched, sha-verified package — what the user reads is
    // what will actually install, not what the marketplace claims.
    sourceDir = fetched.destDir;
  } else {
    throw new UnsupportedSourceError(source.kind);
  }
  const manifest = await readManifestFrom(sourceDir);

  if (manifest.name !== opts.entry.name) {
    throw new PluginSecurityError(
      `Marketplace advertises "${opts.entry.name}" but the package identifies as "${manifest.name}"`,
    );
  }

  const skills = await discoverSkills(sourceDir);
  const ignoredPayloads = await discoverIgnoredPayloads(sourceDir);
  // Scanned from the same tree the copy will walk, so what the user approves
  // is what the copy will actually leave out.
  const skippedSymlinks = await collectPluginSymlinks(sourceDir);
  const mcpServers = Object.entries(manifest.mcpServers ?? {}).map(([name, spec]) => ({
    name,
    command: spec.command,
    args: spec.args,
    url: spec.url,
  }));

  return {
    key: pluginKey(manifest.name, opts.marketplaceName),
    name: manifest.name,
    marketplace: opts.marketplaceName,
    version: manifest.version,
    manifest,
    sourceDir,
    skills,
    mcpServers,
    capabilities: manifest.interface?.capabilities,
    ignoredPayloads,
    skippedSymlinks,
  };
}

export interface InstallPluginOptions extends PlanInstallOptions {
  home: string;
  /**
   * Copy the package into its final location. Injected so the orchestration
   * here stays testable and so the atomic-install primitive can be swapped in
   * without touching this module's logic.
   */
  copyDir: (from: string, to: string) => Promise<void>;
  /** Injectable for deterministic tests. */
  now?: () => Date;
  /**
   * Content hash of the verified artifact (hex sha256), recorded so update
   * detection has an identity for sources that carry no git sha (enterprise
   * catalog). The installer does not compute it — whoever verified the bytes
   * passes it in.
   */
  checksum?: string;
}

/** Version segment used on disk when a manifest omits `version`. */
const UNVERSIONED = '0.0.0';

export interface InstallOutcome {
  record: InstalledPlugin;
  /**
   * The MCP server specs this install brought in, carried out of the single
   * `planInstall` already done here. Callers register these without re-planning
   * — a second `planInstall` would re-read the package and, worse, is a
   * distinct call some callers mock statefully.
   */
  mcpServers: InstallDisclosure['mcpServers'];
}

export async function installPlugin(opts: InstallPluginOptions): Promise<InstallOutcome> {
  const disclosure = await planInstall(opts);
  const version = disclosure.version ?? UNVERSIONED;
  const targetDir = pluginInstallDir(opts.home, opts.marketplaceName, disclosure.name, version);

  await opts.copyDir(disclosure.sourceDir, targetDir);

  return {
    record: {
      key: disclosure.key,
      marketplace: opts.marketplaceName,
      name: disclosure.name,
      version,
      // Pin the record to the verified sha for remote sources, so "what is
      // installed" is answerable down to the commit.
      sha: 'sha' in opts.entry.source ? opts.entry.source.sha : undefined,
      checksum: opts.checksum,
      installedAt: (opts.now?.() ?? new Date()).toISOString(),
      contributed: {
        skills: disclosure.skills,
        mcpServers: disclosure.mcpServers.map((s) => s.name),
      },
    },
    mcpServers: disclosure.mcpServers,
  };
}
