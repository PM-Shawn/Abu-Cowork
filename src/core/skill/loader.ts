import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { readTextFile, readDir, exists } from '@tauri-apps/plugin-fs';
import { homeDir, appDataDir, resolve, resolveResource } from '@tauri-apps/api/path';
import type { Skill, SkillMetadata, SkillHookEntry, SkillSource } from '../../types';
import { joinPath, getParentDir, normalizeSeparators } from '../../utils/pathUtils';
import { sanitizePath } from '../memdir/paths';

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
      description: (meta.description as string) ?? '',
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
   *     7. <resource>/builtin-skills/            (bundled)
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

    // Enterprise-installed skills (AppData/skills/enterprise/<name>/SKILL.md).
    // Each sub-directory is a separate skill package written by installer.ts.
    try {
      const appData = await appDataDir();
      dirs.push({ path: joinPath(appData, 'skills/enterprise'), source: 'enterprise' });
    } catch { /* appDataDir unavailable in non-Tauri/test environments */ }

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
        if (!entry.isDirectory) continue;

        // Try both SKILL.md and skill.md (spec accepts both)
        for (const filename of ['SKILL.md', 'skill.md']) {
          const skillPath = joinPath(dir, entry.name, filename);
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
    return this.skills.get(name) ?? null;
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
      .filter((skill) => includeDrafts || skill.source !== 'draft')
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
    return this.skills.get(name);
  }

  /** Re-read a single skill from disk to get latest content */
  async refreshSkill(name: string): Promise<Skill | undefined> {
    const existing = this.skills.get(name);
    if (!existing?.filePath) return existing;
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
    return this.skills.has(name);
  }

  /** Find skills matching a user query (for searching/filtering) */
  findMatchingSkills(query: string): Skill[] {
    const lower = query.toLowerCase();
    const matched = Array.from(this.skills.values()).filter((s) => {
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

  /** Load a supporting file from a skill's directory */
  async loadSupportingFile(skillName: string, relativePath: string): Promise<string | null> {
    const skill = this.skills.get(skillName);
    if (!skill) return null;

    // Security: prevent path traversal
    if (relativePath.includes('..')) return null;

    const fullPath = joinPath(skill.skillDir, relativePath);
    try {
      return await readTextFile(fullPath);
    } catch {
      return null;
    }
  }
}

/** Recursively list files in a directory, returning relative paths */
async function listFilesRecursive(
  baseDir: string,
  prefix: string,
  exclude: string,
): Promise<string[]> {
  const result: string[] = [];
  try {
    const entries = await readDir(joinPath(baseDir, prefix || '.'));
    for (const entry of entries) {
      const relativePath = prefix ? joinPath(prefix, entry.name) : entry.name;
      if (entry.isDirectory && !entry.name.startsWith('.')) {
        const nested = await listFilesRecursive(baseDir, relativePath, exclude);
        result.push(...nested);
      } else if (!entry.isDirectory && entry.name !== exclude && !entry.name.startsWith('.')) {
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
