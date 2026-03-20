import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { readTextFile, readDir, exists } from '@tauri-apps/plugin-fs';
import { homeDir, resolve, resolveResource } from '@tauri-apps/api/path';
import type { Skill, SkillMetadata, SkillHookEntry } from '../../types';
import { joinPath, getParentDir } from '../../utils/pathUtils';

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
      allowedTools: meta['allowed-tools'] as string[] | undefined,
      blockedTools: meta['blocked-tools'] as string[] | undefined,
      requiredTools: meta['required-tools'] as string[] | undefined,
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

  /** Scan all skill directories and load SKILL.md files */
  async discoverSkills(): Promise<SkillMetadata[]> {
    this.skills.clear();

    const home = await homeDir();
    const projectDir = await resolve('.abu/skills');

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

    const dirs = [
      joinPath(home, '.abu/skills'),   // user-level
      projectDir,                      // project-level
      ...(builtinDir ? [builtinDir] : []),  // bundled builtin-skills
    ];

    for (const dir of dirs) {
      await this.scanDirectory(dir);
    }

    return this.getAvailableSkills();
  }

  private async scanDirectory(dir: string): Promise<void> {
    try {
      if (!(await exists(dir))) return;

      const entries = await readDir(dir);
      for (const entry of entries) {
        if (!entry.isDirectory) continue;

        const skillPath = joinPath(dir, entry.name, 'SKILL.md');
        try {
          const raw = await readTextFile(skillPath);
          const skill = parseSkillFile(raw, skillPath);
          if (skill) {
            this.skills.set(skill.name, skill);
          }
        } catch {
          // Skip unreadable files
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

  /** Get metadata for all discovered skills (without full content) */
  getAvailableSkills(): SkillMetadata[] {
    return Array.from(this.skills.values()).map((skill) => {
      // Omit runtime-only fields not part of SkillMetadata
      const { content, filePath, skillDir, ...meta } = skill;
      void content; void filePath; void skillDir;
      return meta;
    });
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
      if (entry.isDirectory) {
        const nested = await listFilesRecursive(baseDir, relativePath, exclude);
        result.push(...nested);
      } else if (entry.name !== exclude) {
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
