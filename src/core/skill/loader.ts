import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { readTextFile, readDir, exists, lstat } from '@tauri-apps/plugin-fs';
import { homeDir, appDataDir, resolve, resolveResource } from '@tauri-apps/api/path';
import type { Skill, SkillMetadata, SkillHookEntry, SkillSource } from '../../types';
import { joinPath, getParentDir, normalizeSeparators } from '../../utils/pathUtils';
import { sanitizePath } from '../memdir/paths';
import { pluginSkillDirs } from '../plugin/skillRoots';
import { isEnterpriseModuleActive } from '../enterprise/entitlement';

/**
 * Normalize tool list: accept both YAML array (Abu format) and
 * space-delimited string (Agent Skills open standard format).
 *   "Bash(git:*) Read" → ["Bash(git:*)", "Read"]
 *   ["read_file", "write_file"] → ["read_file", "write_file"]
 */
function normalizeToolList(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === 'string');
  if (typeof raw === 'string') {
    // Split on whitespace, but preserve parenthesized constraints:
    // "Bash(git:*) Read" → ["Bash(git:*)", "Read"]
    const tokens: string[] = [];
    let current = '';
    let parenDepth = 0;
    for (const ch of raw) {
      if (ch === '(') { parenDepth++; current += ch; }
      else if (ch === ')') { parenDepth = Math.max(0, parenDepth - 1); current += ch; }
      else if (/\s/.test(ch) && parenDepth === 0) {
        if (current) { tokens.push(current); current = ''; }
      } else {
        current += ch;
      }
    }
    if (current) tokens.push(current);
    return tokens.length > 0 ? tokens : undefined;
  }
  return undefined;
}

/**
 * Parse a SKILL.md file: YAML frontmatter (between ---) + Markdown body
 */
function parseSkillFile(raw: string, filePath: string): Skill | null {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return null;

  try {
    const meta = parseYaml(match[1]) as Record<string, unknown>;
    const content = match[2].trim();

    if (!meta.name || typeof meta.name !== 'string') return null;

    // Parse hooks from frontmatter
    const hooks = parseSkillHooks(meta.hooks as Record<string, unknown> | undefined);

    // Parse preloadSkills from 'skills' field (Claude Code naming)
    const preloadSkills = (meta.skills ?? meta['preload-skills']) as string[] | undefined;

    return {
      name: meta.name as string,
      // Guarded like `name` above: `description:` is unchecked third-party
      // YAML, so `description: 42` or a list survives `?? ''` and reaches
      // consumers typed as a string it is not.
      description: typeof meta.description === 'string' ? meta.description : '',
      trigger: meta.trigger as string | undefined,
      doNotTrigger: (meta['do-not-trigger'] ?? meta.doNotTrigger) as string | undefined,
      userInvocable: meta['user-invocable'] !== false,
      disableAutoInvoke: meta['disable-auto-invoke'] === true,
      argumentHint: meta['argument-hint'] as string | undefined,
      allowedTools: normalizeToolList(meta['allowed-tools']),
      blockedTools: normalizeToolList(meta['blocked-tools']),
      requiredTools: normalizeToolList(meta['required-tools']),
      model: meta.model as string | undefined,
      maxTurns: typeof meta['max-turns'] === 'number' ? meta['max-turns'] : undefined,
      context: (meta.context as 'inline' | 'fork') ?? 'inline',
      tags: meta.tags as string[] | undefined,
      chain: meta.chain as string[] | undefined,
      agent: meta.agent as string | undefined,
      preloadSkills: Array.isArray(preloadSkills) ? preloadSkills : undefined,
      hooks,
      // Agent Skills spec compatibility fields
      license: meta.license as string | undefined,
      compatibility: meta.compatibility as string | undefined,
      metadata: meta.metadata as Record<string, string> | undefined,
      content,
      filePath,
      skillDir: getParentDir(filePath),
    };
  } catch {
    return null;
  }
}

/**
 * Parse hooks section from YAML frontmatter.
 */
function parseSkillHooks(
  raw: Record<string, unknown> | undefined,
): SkillMetadata['hooks'] | undefined {
  if (!raw) return undefined;

  const result: NonNullable<SkillMetadata['hooks']> = {};

  for (const phase of ['PreToolUse', 'PostToolUse'] as const) {
    const entries = raw[phase];
    if (!Array.isArray(entries)) continue;

    result[phase] = entries
      .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
      .map((entry): SkillHookEntry => ({
        matcher: String(entry.matcher ?? '*'),
        hooks: Array.isArray(entry.hooks)
          ? entry.hooks
              .filter((h): h is Record<string, unknown> => typeof h === 'object' && h !== null)
              .map(h => ({
                type: 'command' as const,
                command: String(h.command ?? ''),
              }))
          : [],
      }));
  }

  return result.PreToolUse || result.PostToolUse ? result : undefined;
}

export class SkillLoader {
  private skills: Map<string, Skill> = new Map();
  /** Last workspace this loader was discovered against (null = global-only). */
  private currentWorkspace: string | null = null;

  /**
   * Scan all skill directories and load SKILL.md files.
   *
   * Scan order (first-win on name collision):
   *
   *   WITH workspacePath:
   *     1. {workspace}/.abu/skills/              (project, git-shareable)
   *     2. {workspace}/.agents/skills/           (project-standard)
   *     3. ~/.abu/projects/<key>/skills/         (workspace-auto, agent-written)
   *     4. ~/.abu/projects/<key>/skills/drafts/ (draft, pending review)
   *
   *   ALWAYS:
   *     5. ~/.abu/skills/                        (user global)
   *     6. ~/.agents/skills/                     (standard cross-client)
   *     7. ~/.abu/plugin-packages/…/skills/      (plugin, below the user's own)
   *     8. <resource>/builtin-skills/            (bundled)
   *
   * With `workspacePath=null`, steps 1-4 are skipped and the loader
   * returns only the global + builtin set.
   */
  async discoverSkills(workspacePath?: string | null): Promise<SkillMetadata[]> {
    this.skills.clear();
    this.currentWorkspace = workspacePath ?? null;

    const home = await homeDir();

    // Bundled resources: resolveResource points to the app bundle's resource dir
    let builtinDir: string | null = null;
    try {
      builtinDir = await resolveResource('builtin-skills');
      // Verify the resolved path is accessible
      if (builtinDir && !(await exists(builtinDir))) {
        builtinDir = null;
      }
    } catch {
      // resolveResource may fail in dev mode
    }
    // Dev mode fallback: try multiple possible paths
    if (!builtinDir) {
      // In dev mode, Tauri CWD is src-tauri/, so try ../builtin-skills first
      const candidates = ['../builtin-skills', 'builtin-skills'];
      for (const candidate of candidates) {
        try {
          const devDir = await resolve(candidate);
          if (await exists(devDir)) {
            builtinDir = devDir;
            console.log('[SkillLoader] dev fallback found:', devDir);
            break;
          }
        } catch { /* try next */ }
      }
    }

    const dirs: Array<{ path: string; source: SkillSource }> = [];

    // Workspace-scoped dirs take priority so project-local skills override globals.
    if (workspacePath) {
      dirs.push(
        { path: joinPath(workspacePath, '.abu/skills'), source: 'project' },
        { path: joinPath(workspacePath, '.agents/skills'), source: 'project-standard' },
      );
      // Agent auto-write + drafts land under ~/.abu/projects/<sanitized>/, aligned
      // with the memdir key-sanitization convention so memory + skills share the
      // same per-workspace namespace on disk.
      //
      // NOTE: drafts dir is "drafts" (visible), not ".drafts" (hidden). Tauri's
      // fs plugin glob scopes ($HOME/**) follow Unix glob rules where **
      // does not traverse dot-prefixed directories — a hidden drafts/ dir
      // would be read-blocked at the capability layer. The visible name lets
      // $HOME/.abu/** cover it without per-path capability entries.
      const key = sanitizePath(normalizeSeparators(workspacePath));
      dirs.push(
        { path: joinPath(home, '.abu/projects', key, 'skills'), source: 'workspace-auto' },
        { path: joinPath(home, '.abu/projects', key, 'skills/drafts'), source: 'draft' },
      );
    }

    // Global + cross-client + bundled, always scanned.
    dirs.push(
      { path: joinPath(home, '.abu/skills'), source: 'user' },
      { path: joinPath(home, '.agents/skills'), source: 'standard' },
    );

    // Skills contributed by installed plugins. Ranked *below* the user's own
    // and the cross-client standard dir on purpose: a skill the user wrote by
    // hand must win a name collision against one a plugin brought in, never
    // the other way round. Roots come from the install record rather than a
    // directory scan, so a plugin is credited with exactly what its
    // disclosure said it would contribute.
    // Defensive, mirroring the enterprise block below: the plugin subsystem is
    // fed by an on-disk file users can edit. `readInstalled` already drops
    // records it cannot vouch for, so this should never fire — but a throw
    // here would cost the user *every* skill, not just the plugin ones, and
    // that is far too much blast radius for an optional subsystem.
    try {
      for (const dir of await pluginSkillDirs(home)) {
        dirs.push({ path: dir, source: 'plugin' });
      }
    } catch (error) {
      console.warn('[SkillLoader] skipping plugin skill roots:', error);
    }

    // Enterprise-installed skills (AppData/skills/enterprise/<name>/SKILL.md).
    // Each sub-directory is a separate skill package written by installer.ts.
    if (isEnterpriseModuleActive('skills')) {
      try {
        const appData = await appDataDir();
        dirs.push({ path: joinPath(appData, 'skills/enterprise'), source: 'enterprise' });
      } catch { /* appDataDir unavailable in non-Tauri/test environments */ }
    }

    if (builtinDir) {
      dirs.push({ path: builtinDir, source: 'builtin' });
    }

    for (const { path, source } of dirs) {
      await this.scanDirectory(path, source);
    }

    return this.getAvailableSkills();
  }

  /** Currently-active workspace path (null when discovered without one). */
  getCurrentWorkspace(): string | null {
    return this.currentWorkspace;
  }

  private async scanDirectory(dir: string, source: SkillSource): Promise<void> {
    try {
      if (!(await exists(dir))) return;

      const entries = await readDir(dir);
      for (const entry of entries) {
        // `read_dir`'s flags are lstat-based in the privileged host
        // (`readdirSync(..., { withFileTypes: true })`), so a link to a
        // directory already reports `isDirectory: false` and is dropped here.
        // The `isSymlink` half is written out anyway because that is
        // load-bearing behaviour nobody can see in `!entry.isDirectory`.
        if (!entry.isDirectory || entry.isSymlink) continue;

        // Try both SKILL.md and skill.md (spec accepts both)
        for (const filename of ['SKILL.md', 'skill.md']) {
          const skillPath = joinPath(dir, entry.name, filename);
          // The manifest has to be one the directory OWNS. `readTextFile`
          // resolves the final component in the privileged host, so a LINKED
          // SKILL.md is read straight through and the skill's identity — its
          // name, its `skillDir`, and therefore every supporting file the model
          // is later offered — comes from a file this directory does not own.
          // (Same rule, same reasoning as the folder installer's SKILL.md gate:
          // src/core/skill/installer.ts.)
          if (!(await isOwnedFile(skillPath))) continue;
          try {
            const raw = await readTextFile(skillPath);
            const skill = parseSkillFile(raw, skillPath);
            if (skill) {
              // Earlier directories take priority — don't overwrite
              if (!this.skills.has(skill.name)) {
                skill.source = source;
                this.skills.set(skill.name, skill);
              }
              break; // Found a skill file, skip trying the other filename
            }
          } catch {
            // File doesn't exist or unreadable, try next filename
          }
        }
      }
    } catch {
      // Directory doesn't exist or not accessible
    }
  }

  /** Load full skill content by name */
  async loadSkill(name: string): Promise<Skill | null> {
    const skill = this.skills.get(name);
    return skill && this.isUsable(skill) ? skill : null;
  }

  private isUsable(skill: Skill): boolean {
    return skill.source !== 'enterprise' || isEnterpriseModuleActive('skills');
  }

  /**
   * Get metadata for all discovered skills (without full content).
   *
   * `draft` source skills are excluded by default — drafts are a pending-
   * review staging area and should never appear in the L0 system-prompt
   * index or agent-facing skill list. Pass `{ includeDrafts: true }` to
   * surface them (for the Settings → Skills → Drafts tab).
   */
  getAvailableSkills(options: { includeDrafts?: boolean } = {}): SkillMetadata[] {
    const includeDrafts = options.includeDrafts ?? false;
    return Array.from(this.skills.values())
      .filter((skill) => this.isUsable(skill) && (includeDrafts || skill.source !== 'draft'))
      .map((skill) => {
        // Omit runtime-only fields not part of SkillMetadata
        const { content, filePath, skillDir, ...meta } = skill;
        void content; void filePath; void skillDir;
        return meta;
      });
  }

  /** Get full draft entries (includes content) for the review UI. */
  getDraftSkills(): Skill[] {
    return Array.from(this.skills.values()).filter((s) => s.source === 'draft');
  }

  /** Get full skill by name */
  getSkill(name: string): Skill | undefined {
    const skill = this.skills.get(name);
    return skill && this.isUsable(skill) ? skill : undefined;
  }

  /** Re-read a single skill from disk to get latest content */
  async refreshSkill(name: string): Promise<Skill | undefined> {
    const existing = this.skills.get(name);
    if (!existing || !this.isUsable(existing)) return undefined;
    if (!existing.filePath) return existing;
    try {
      const raw = await readTextFile(existing.filePath);
      const skill = parseSkillFile(raw, existing.filePath);
      if (skill) {
        skill.source = existing.source;
        this.skills.set(skill.name, skill);
        return skill;
      }
    } catch { /* file might have been deleted */ }
    return existing;
  }

  /** Check if a skill is registered */
  has(name: string): boolean {
    const skill = this.skills.get(name);
    return skill !== undefined && this.isUsable(skill);
  }

  /** Find skills matching a user query (for searching/filtering) */
  findMatchingSkills(query: string): Skill[] {
    const lower = query.toLowerCase();
    const matched = Array.from(this.skills.values()).filter((s) => {
      if (!this.isUsable(s)) return false;
      if (s.disableAutoInvoke) return false;
      const haystack = `${s.name} ${s.description} ${(s.tags ?? []).join(' ')} ${s.trigger ?? ''}`.toLowerCase();
      const words = lower.split(/\s+/).filter(w => w.length > 0);
      return words.some((word) => haystack.includes(word));
    });
    // Prioritize skills with trigger fields (more specific matching)
    return matched.sort((a, b) => {
      const aHasTrigger = a.trigger ? 1 : 0;
      const bHasTrigger = b.trigger ? 1 : 0;
      return bHasTrigger - aHasTrigger;
    });
  }

  /** List supporting files in a skill's directory (excluding SKILL.md) */
  async listSupportingFiles(skillName: string): Promise<string[]> {
    const skill = this.skills.get(skillName);
    if (!skill) return [];

    try {
      return await listFilesRecursive(skill.skillDir, '', 'SKILL.md');
    } catch {
      return [];
    }
  }

  /**
   * Load a supporting file from a skill's directory.
   *
   * The model picks `relativePath` — the skill's own SKILL.md body tells it
   * which file to open — and `skill_view` is on the read-only allowlist, so
   * this runs unattended and in plan mode with no path policy in front of it.
   * The bytes therefore have to be the skill's own: every segment of the path
   * is checked for ownership, not just the last one. A link anywhere along it
   * is an instruction to read something the skill does not own, and
   * `readTextFile` resolves the final component in the privileged host, so
   * anything let through here is read THROUGH.
   */
  async loadSupportingFile(skillName: string, relativePath: string): Promise<string | null> {
    const skill = this.skills.get(skillName);
    if (!skill) return null;

    // Cheap pre-filter, kept for what it does catch. It is not the rule: it is
    // a string test, and a symlink needs no `..` in the path at all.
    if (relativePath.includes('..')) return null;

    const fullPath = await resolveOwnedFile(skill.skillDir, relativePath);
    if (!fullPath) return null;
    try {
      return await readTextFile(fullPath);
    } catch {
      return null;
    }
  }
}

/**
 * Is `path` a regular file the skill directory OWNS, rather than a link to one
 * (or a FIFO, or a socket, or a directory)?
 *
 * `lstat` is the one fs call routed with `followFinalSymlink: false`
 * (`electron/fsHost.cjs`, `plugin:fs|lstat`), which is exactly what an
 * ownership question needs — every other call resolves the very thing being
 * asked about.
 *
 * `isFile`, not `!isDirectory`: a link reports both `isFile` and `isDirectory`
 * false whichever kind of thing it points at, and so does a FIFO — on which
 * `readTextFile` blocks the privileged host's event loop until a writer
 * appears. Absent is the right answer for all of them.
 *
 * A path that cannot be lstat'd is absent too; the caller's read would fail on
 * it moments later anyway.
 */
async function isOwnedFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isFile && !info.isSymlink;
  } catch {
    return false;
  }
}

/**
 * Absolute path of `relativePath` under `skillDir`, or null unless the skill
 * owns EVERY segment of it.
 *
 * Checking only the final component would be checking nothing: the privileged
 * host's `lstat` resolves every PARENT component before it looks at the last
 * one, so `references -> ~/.ssh` with a real `id_rsa` inside it answers
 * "ordinary file" for `references/id_rsa`. Each segment is therefore asked
 * about on its own, exactly as `scanPluginPackage.find` walks a plugin package
 * (src/core/plugin/fsOps.ts).
 */
async function resolveOwnedFile(skillDir: string, relativePath: string): Promise<string | null> {
  // A `.` segment names the directory it is already in, so it cannot leave
  // the skill; drop it with the empty segments. Models routinely write
  // `./references/api.md` on `skill_view`, and refusing that only teaches
  // them the file does not exist. `..` is the segment that can escape, and
  // it stays refused below.
  const segments = normalizeSeparators(relativePath)
    .split('/')
    .filter((s) => s !== '' && s !== '.');
  if (segments.length === 0) return null;

  let current = skillDir;
  for (const [index, segment] of segments.entries()) {
    if (segment === '..') return null;
    current = joinPath(current, segment);
    if (index === segments.length - 1) return (await isOwnedFile(current)) ? current : null;
    if (!(await isOwnedDirectory(current))) return null;
  }
  return null;
}

/** Is `path` a real directory the skill owns, rather than a link to one? */
async function isOwnedDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isDirectory && !info.isSymlink;
  } catch {
    return false;
  }
}

/**
 * Recursively list files in a directory, returning relative paths.
 *
 * This list is handed to the model as the skill's supporting files, and
 * whatever is on it can then be asked for by name. So it holds only entries
 * the skill OWNS: a link is skipped rather than advertised (following it would
 * offer the model a file from outside the skill under an innocuous name, and
 * descending into one would enumerate a directory that is not this skill's),
 * and only regular files are listed — a FIFO would otherwise be offered as a
 * readable file and block the privileged host's event loop when read.
 */
async function listFilesRecursive(
  baseDir: string,
  prefix: string,
  exclude: string,
): Promise<string[]> {
  const result: string[] = [];
  try {
    const entries = await readDir(joinPath(baseDir, prefix || '.'));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      // BEFORE the isDirectory branch: a link to a directory reports
      // `isDirectory: false`, so testing it afterwards would be testing nothing.
      if (entry.isSymlink) continue;

      const relativePath = prefix ? joinPath(prefix, entry.name) : entry.name;
      if (entry.isDirectory) {
        const nested = await listFilesRecursive(baseDir, relativePath, exclude);
        result.push(...nested);
      } else if (entry.isFile && entry.name !== exclude) {
        result.push(relativePath);
      }
    }
  } catch {
    // Directory not accessible
  }
  return result;
}

export const skillLoader = new SkillLoader();

/**
 * Serialize skill metadata + content back to SKILL.md format (YAML frontmatter + Markdown body)
 */
export function serializeSkillMd(metadata: Partial<SkillMetadata>, content: string): string {
  // Build a clean metadata object with kebab-case keys, omitting empty/undefined values
  const meta: Record<string, unknown> = {};
  const set = (key: string, value: unknown) => {
    if (value === undefined || value === null || value === '') return;
    if (Array.isArray(value) && value.length === 0) return;
    meta[key] = value;
  };

  set('name', metadata.name);
  set('description', metadata.description);
  set('trigger', metadata.trigger);
  set('do-not-trigger', metadata.doNotTrigger);
  set('user-invocable', metadata.userInvocable);
  if (metadata.disableAutoInvoke) set('disable-auto-invoke', true);
  set('argument-hint', metadata.argumentHint);
  set('context', metadata.context);
  set('model', metadata.model);
  set('max-turns', metadata.maxTurns);
  set('allowed-tools', metadata.allowedTools);
  set('required-tools', metadata.requiredTools);
  set('tags', metadata.tags);
  set('agent', metadata.agent);
  set('skills', metadata.preloadSkills);
  if (metadata.hooks) set('hooks', metadata.hooks);
  // Agent Skills spec compatibility fields
  set('license', metadata.license);
  set('compatibility', metadata.compatibility);
  if (metadata.metadata) set('metadata', metadata.metadata);

  const yaml = stringifyYaml(meta, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n\n${content}`;
}
