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
 *   - link refusal — a link in a third-party package is an instruction to read
 *     something the package does not own, so `copyPluginDir` never follows one.
 *     Every scan here goes through `scanPluginPackage`, which hides exactly
 *     what the copy refuses and which refuses a package root that is itself a
 *     link before it lists anything. Without that the disclosure would
 *     describe a tree that never lands.
 */

import { readTextFile, writeTextFile, mkdir, exists } from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';
import { joinPath, normalizeSeparators } from '../../utils/pathUtils';
import { MANIFEST_CANDIDATES, parsePluginManifest, type PluginManifest } from './manifest';
import type { MarketplaceEntry, PluginSource } from './marketplace';
import { pluginInstallDir, pluginKey, pluginRoot } from './paths';
import { collectPluginSymlinks, scanPluginPackage, type PackageScan } from './fsOps';
import { findInstalled, type InstalledPlugin } from './installedStore';
import { convertSingleFileAgent, renderAgentMd } from './agentPayload';
import { installAgentFromFolder } from '../agent/installer';
import { isSafeSkillDirName } from '../skill/skillDirName';

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
  return readManifestWith(packageDir, scanPluginPackage(packageDir));
}

/**
 * The scanning half of {@link readManifestFrom}, so `planInstall` can share one
 * {@link PackageScan} across every scan it does.
 */
async function readManifestWith(packageDir: string, scan: PackageScan): Promise<PluginManifest> {
  for (const candidate of MANIFEST_CANDIDATES) {
    // A candidate reached through a link is not the package's own file: the
    // copy will skip it, so approving name / version / `mcpServers` read from
    // it would approve a package that installs with no manifest at all.
    if (!(await scan.find(candidate))) continue;
    const path = joinPath(packageDir, candidate);
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
async function discoverSkills(scan: PackageScan): Promise<string[]> {
  const entries = await scan.children('skills');
  return entries
    .filter((e) => e.isDirectory)
    .map((e) => e.name)
    .sort();
}

/**
 * One agent an install would add, as the disclosure screen lists it.
 *
 * `conflict` says why an agent shown here will NOT be installed: `'exists'`
 * when `~/.abu/agents/<name>` is already taken by something this plugin did not
 * put there (it is never overwritten), `'unsafe-name'` when the declared name
 * is not a single safe directory segment, `'empty-prompt'` when the file
 * carries frontmatter but no system prompt. Absent means it will install.
 */
export interface PluginAgentDisclosure {
  name: string;
  description: string;
  conflict?: 'exists' | 'unsafe-name' | 'empty-prompt';
}

/**
 * One agent read out of a package's `agents/` payload, before any conflict
 * test — the same data the disclosure is derived from and the install writes.
 */
interface PayloadAgent {
  /** Frontmatter `name`, or the file/directory name it fell back to. */
  name: string;
  description: string;
  /** Package-relative path of the markdown it was read from. */
  relPath: string;
  /** An agent with no system prompt is a packaging mistake (spec §4). */
  emptyPrompt: boolean;
  /** `AGENT.md` text in Abu's own format, ready to write. */
  rendered: string;
}

/** Both payload shapes, converted, sorted by name, one entry per name. */
async function readPayloadAgents(scan: PackageScan, packageDir: string): Promise<PayloadAgent[]> {
  const found: PayloadAgent[] = [];
  for (const entry of await scan.children('agents')) {
    let relPath: string;
    let fallbackName: string;
    if (entry.isDirectory) {
      // Abu's own shape: `agents/<dir>/AGENT.md`. Through the scan, so a linked
      // AGENT.md inside a real directory is absent exactly as a linked
      // `plugin.json` is.
      const agentMd = await scan.find(`agents/${entry.name}/AGENT.md`);
      if (!agentMd || agentMd.isDirectory) continue;
      relPath = `agents/${entry.name}/AGENT.md`;
      fallbackName = entry.name;
    } else {
      // The ecosystem shape: `agents/<name>.md`. Anything else in the directory
      // (a README, a JSON index) is not an agent.
      if (!/\.md$/i.test(entry.name)) continue;
      relPath = `agents/${entry.name}`;
      fallbackName = entry.name.replace(/\.md$/i, '');
    }
    // The folder shape goes through the same converter as the single file: it
    // normalises the list keys and drops `memory` for both, so the two shapes
    // cannot install subtly different agents.
    const converted = convertSingleFileAgent(await readTextFile(joinPath(packageDir, relPath)), fallbackName);
    found.push({
      name: converted.name,
      description: converted.description,
      relPath,
      emptyPrompt: converted.body.trim() === '',
      rendered: renderAgentMd(converted),
    });
  }

  const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  found.sort((a, b) => order(a.name, b.name) || order(a.relPath, b.relPath));
  // Only one directory can carry a name, so two files claiming the same one
  // cannot both land. Resolving it on the SORTED list rather than on `readDir`
  // order is what makes the same package install the same file every time.
  const byName = new Map<string, PayloadAgent>();
  for (const agent of found) if (!byName.has(agent.name)) byName.set(agent.name, agent);
  return [...byName.values()];
}

/**
 * Mark the agents that will be skipped, in the order the screen lists them.
 *
 * `previouslyContributed` are the names THIS plugin's install record already
 * claims: an update is planned while the old version is still installed, so its
 * own agent directories are sitting there and reading them as "already taken"
 * would tell the user their update drops every agent it ships.
 */
async function discloseAgents(
  agents: PayloadAgent[],
  previouslyContributed: ReadonlySet<string>,
): Promise<PluginAgentDisclosure[]> {
  if (agents.length === 0) return [];
  // The expression `installAgentFromFolder` builds its target with, so the
  // conflict this reports is the one that install would actually hit.
  const agentsRoot = joinPath(await homeDir(), '.abu', 'agents');

  const out: PluginAgentDisclosure[] = [];
  for (const agent of agents) {
    const disclosure: PluginAgentDisclosure = { name: agent.name, description: agent.description };
    if (!isSafeSkillDirName(agent.name)) {
      // First, because an unsafe name must not be turned into a path at all.
      disclosure.conflict = 'unsafe-name';
    } else if (agent.emptyPrompt) {
      disclosure.conflict = 'empty-prompt';
    } else if (!previouslyContributed.has(agent.name) && (await exists(joinPath(agentsRoot, agent.name)))) {
      disclosure.conflict = 'exists';
    }
    out.push(disclosure);
  }
  return out;
}

/**
 * Materialise every disclosed agent that has no conflict, and return the names
 * that actually landed.
 *
 * Read back out of the INSTALLED copy, not the source: those are the bytes the
 * user's approval covered, and the copy already refused everything the package
 * does not own.
 *
 * Partial failure follows the policy MCP registration already sets in
 * `pluginStore.install`: an item that did not land is simply not credited to
 * the plugin, and nothing is rolled back. The record's `contributed.agents`
 * list IS the report — crediting a name that is not on disk would make
 * uninstall delete something this plugin never installed.
 */
async function installPayloadAgents(
  installDir: string,
  disclosed: PluginAgentDisclosure[],
): Promise<string[]> {
  const wanted = new Set(disclosed.filter((a) => !a.conflict).map((a) => a.name));
  if (wanted.size === 0) return [];

  const installed: string[] = [];
  for (const agent of await readPayloadAgents(scanPluginPackage(installDir), installDir)) {
    if (!wanted.has(agent.name)) continue;
    // Membership in `wanted` already implies this, but the predicate is applied
    // wherever a stranger's name becomes a directory — not wherever it happens
    // to have been checked before.
    if (!isSafeSkillDirName(agent.name)) continue;
    try {
      const dir = joinPath(installDir, 'agents', agent.name);
      await mkdir(dir, { recursive: true });
      // Overwrites the copied AGENT.md for the folder shape on purpose: both
      // shapes hand the agent installer the same normalised file.
      await writeTextFile(joinPath(dir, 'AGENT.md'), agent.rendered);
      const result = await installAgentFromFolder(dir, { overwrite: false });
      // `ALREADY_EXISTS` here is a user agent created between the plan and now:
      // it wins, and this plugin is not credited with a directory it did not
      // write. Every other code is a failure that must not be credited either.
      if (result.ok) installed.push(agent.name);
    } catch {
      // Same policy as above: one agent's failure narrows what the plugin is
      // credited with, it does not undo an install the user already approved.
    }
  }
  return installed;
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
  /**
   * Agents the package ships, with the ones that will be skipped marked. Always
   * present (empty when the package ships none) so the disclosure screen never
   * has to tell "no agents" apart from "this surface did not look".
   */
  agents: PluginAgentDisclosure[];
  capabilities?: string[];
  /**
   * Top-level payload dirs Abu does NOT consume (commands / hooks — the
   * Claude/Codex ecosystem ships these and Abu does not run them). Surfaced so
   * the user is not surprised when part of a plugin silently does nothing
   * here. `agents/` left this list when the payload route landed.
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
const IGNORED_PAYLOAD_DIRS = ['commands', 'hooks'] as const;

/** Which of the ignored payload dirs this package actually ships. */
async function discoverIgnoredPayloads(scan: PackageScan): Promise<string[]> {
  const present: string[] = [];
  for (const dir of IGNORED_PAYLOAD_DIRS) {
    if (await scan.find(dir)) present.push(dir);
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
  // One view of the package, shared by every scan below. It hides exactly what
  // the copy refuses — same traversal, same rule — so the disclosure and the
  // installed tree agree by construction rather than by lists kept in step by
  // hand. Both this and `collectPluginSymlinks` refuse a package root that is
  // itself a link, so their order here is presentation, not a guard.
  const scan = scanPluginPackage(sourceDir);
  // The skip list comes off the walk the copy performs, so what the user
  // approves is what the copy will actually leave out.
  const skippedSymlinks = await collectPluginSymlinks(sourceDir);
  const manifest = await readManifestWith(sourceDir, scan);

  if (manifest.name !== opts.entry.name) {
    throw new PluginSecurityError(
      `Marketplace advertises "${opts.entry.name}" but the package identifies as "${manifest.name}"`,
    );
  }

  const skills = await discoverSkills(scan);
  const key = pluginKey(manifest.name, opts.marketplaceName);
  const payloadAgents = await readPayloadAgents(scan, sourceDir);
  // Without a home there is no install record to read, so every taken name
  // counts as a conflict — the conservative direction: an agent is skipped
  // rather than a user's own one silently replaced.
  const previouslyContributed = new Set(
    opts.home && payloadAgents.length > 0
      ? (await findInstalled(opts.home, key))?.contributed.agents ?? []
      : [],
  );
  const agents = await discloseAgents(payloadAgents, previouslyContributed);
  const ignoredPayloads = await discoverIgnoredPayloads(scan);
  const mcpServers = Object.entries(manifest.mcpServers ?? {}).map(([name, spec]) => ({
    name,
    command: spec.command,
    args: spec.args,
    url: spec.url,
  }));

  return {
    key,
    name: manifest.name,
    marketplace: opts.marketplaceName,
    version: manifest.version,
    manifest,
    sourceDir,
    skills,
    mcpServers,
    agents,
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

  // After the copy: the agents are materialised from the installed tree, so
  // nothing the copy refused can reach ~/.abu/agents.
  const agents = await installPayloadAgents(targetDir, disclosure.agents);

  return {
    record: {
      key: disclosure.key,
      marketplace: opts.marketplaceName,
      name: disclosure.name,
      version,
      // Pin the record to the verified sha for remote sources, so "what is
      // installed" is answerable down to the commit.
      sha: 'sha' in opts.entry.source ? opts.entry.source.sha : undefined,
      // Recorded at install time because it is the only moment the source is
      // known: the marketplace entry can be edited or removed afterwards, and
      // inferring "local vs remote" from the presence of a sha only works by
      // accident.
      sourceKind: opts.entry.source.kind,
      checksum: opts.checksum,
      installedAt: (opts.now?.() ?? new Date()).toISOString(),
      contributed: {
        skills: disclosure.skills,
        mcpServers: disclosure.mcpServers.map((s) => s.name),
        // Only the agents this install actually materialised: uninstall deletes
        // every name listed here, so a name that is not on disk (or is someone
        // else's) must never appear.
        agents,
      },
    },
    mcpServers: disclosure.mcpServers,
  };
}
