import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type {
  Skill,
  SkillMetadata,
  SkillHookEntry,
  SkillSource,
} from '../../../../src/types';
import { joinPath, getParentDir } from '../common/pathUtils';
import type { StorageAdapter } from '../ports/adapters/storage';
import type { PathAdapter } from '../ports/adapters/path';

/**
 * 对比 Abu 原版改动：
 * - 原版 `@tauri-apps/plugin-fs` + `@tauri-apps/api/path` → 改为 StorageAdapter + PathAdapter；
 * - 原版模块级 `export const skillLoader = new SkillLoader()` singleton 移除，
 *   改为 Facade 注入。
 * - `resolve` (针对 workspace-relative 路径) 由 caller 传入绝对路径的 project-skills-dir 替代。
 */

function normalizeToolList(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === 'string');
  if (typeof raw === 'string') {
    const tokens: string[] = [];
    let current = '';
    let parenDepth = 0;
    for (const ch of raw) {
      if (ch === '(') {
        parenDepth++;
        current += ch;
      } else if (ch === ')') {
        parenDepth = Math.max(0, parenDepth - 1);
        current += ch;
      } else if (/\s/.test(ch) && parenDepth === 0) {
        if (current) {
          tokens.push(current);
          current = '';
        }
      } else {
        current += ch;
      }
    }
    if (current) tokens.push(current);
    return tokens.length > 0 ? tokens : undefined;
  }
  return undefined;
}

function parseSkillHooks(
  raw: Record<string, unknown> | undefined
): SkillMetadata['hooks'] | undefined {
  if (!raw) return undefined;
  const result: NonNullable<SkillMetadata['hooks']> = {};
  for (const phase of ['PreToolUse', 'PostToolUse'] as const) {
    const entries = raw[phase];
    if (!Array.isArray(entries)) continue;
    result[phase] = entries
      .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
      .map(
        (entry): SkillHookEntry => ({
          matcher: String(entry.matcher ?? '*'),
          hooks: Array.isArray(entry.hooks)
            ? entry.hooks
                .filter((h): h is Record<string, unknown> => typeof h === 'object' && h !== null)
                .map((h) => ({ type: 'command' as const, command: String(h.command ?? '') }))
            : [],
        })
      );
  }
  return result.PreToolUse || result.PostToolUse ? result : undefined;
}

function parseSkillFile(raw: string, filePath: string): Skill | null {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return null;
  try {
    const meta = parseYaml(match[1]) as Record<string, unknown>;
    const content = match[2].trim();
    if (!meta.name || typeof meta.name !== 'string') return null;
    const hooks = parseSkillHooks(meta.hooks as Record<string, unknown> | undefined);
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

export interface SkillLoaderDeps {
  storage: StorageAdapter;
  path: PathAdapter;
  /** 额外扫描目录（绝对路径 + source）——Abu 原版自动探测 workspace/builtin 等，现在由 Facade 组装 */
  extraDirs?: Array<{ path: string; source: SkillSource }>;
}

export class SkillLoader {
  private skills: Map<string, Skill> = new Map();

  constructor(private readonly deps: SkillLoaderDeps) {}

  async discoverSkills(): Promise<SkillMetadata[]> {
    this.skills.clear();
    const { storage, path, extraDirs } = this.deps;
    const home = await path.homeDir();

    const dirs: Array<{ path: string; source: SkillSource }> = [
      { path: joinPath(home, '.abu/skills'), source: 'user' },
      { path: joinPath(home, '.agents/skills'), source: 'standard' },
      ...(extraDirs ?? []),
    ];

    for (const { path: dir, source } of dirs) {
      await this.scanDirectory(storage, dir, source);
    }

    return this.getAvailableSkills();
  }

  private async scanDirectory(
    storage: StorageAdapter,
    dir: string,
    source: SkillSource
  ): Promise<void> {
    try {
      if (!(await storage.exists(dir))) return;
      const entries = await storage.readDir(dir);
      for (const entry of entries) {
        if (!entry.isDirectory) continue;
        for (const filename of ['SKILL.md', 'skill.md']) {
          const skillPath = joinPath(dir, entry.name, filename);
          try {
            const raw = await storage.readTextFile(skillPath);
            const skill = parseSkillFile(raw, skillPath);
            if (skill) {
              if (!this.skills.has(skill.name)) {
                skill.source = source;
                this.skills.set(skill.name, skill);
              }
              break;
            }
          } catch {
            /* next filename */
          }
        }
      }
    } catch {
      /* dir inaccessible */
    }
  }

  async loadSkill(name: string): Promise<Skill | null> {
    return this.skills.get(name) ?? null;
  }

  getAvailableSkills(): SkillMetadata[] {
    return Array.from(this.skills.values()).map((skill) => {
      const { content, filePath, skillDir, ...meta } = skill;
      void content;
      void filePath;
      void skillDir;
      return meta;
    });
  }

  getSkill(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  async refreshSkill(name: string): Promise<Skill | undefined> {
    const existing = this.skills.get(name);
    if (!existing?.filePath) return existing;
    try {
      const raw = await this.deps.storage.readTextFile(existing.filePath);
      const skill = parseSkillFile(raw, existing.filePath);
      if (skill) {
        skill.source = existing.source;
        this.skills.set(skill.name, skill);
        return skill;
      }
    } catch {
      /* file may have been deleted */
    }
    return existing;
  }

  has(name: string): boolean {
    return this.skills.has(name);
  }

  findMatchingSkills(query: string): Skill[] {
    const lower = query.toLowerCase();
    const matched = Array.from(this.skills.values()).filter((s) => {
      if (s.disableAutoInvoke) return false;
      const haystack =
        `${s.name} ${s.description} ${(s.tags ?? []).join(' ')} ${s.trigger ?? ''}`.toLowerCase();
      const words = lower.split(/\s+/).filter((w) => w.length > 0);
      return words.some((word) => haystack.includes(word));
    });
    return matched.sort((a, b) => {
      const aHasTrigger = a.trigger ? 1 : 0;
      const bHasTrigger = b.trigger ? 1 : 0;
      return bHasTrigger - aHasTrigger;
    });
  }

  async listSupportingFiles(skillName: string): Promise<string[]> {
    const skill = this.skills.get(skillName);
    if (!skill) return [];
    try {
      return await listFilesRecursive(this.deps.storage, skill.skillDir, '', 'SKILL.md');
    } catch {
      return [];
    }
  }

  async loadSupportingFile(skillName: string, relativePath: string): Promise<string | null> {
    const skill = this.skills.get(skillName);
    if (!skill) return null;
    if (relativePath.includes('..')) return null;
    const fullPath = joinPath(skill.skillDir, relativePath);
    try {
      return await this.deps.storage.readTextFile(fullPath);
    } catch {
      return null;
    }
  }
}

async function listFilesRecursive(
  storage: StorageAdapter,
  baseDir: string,
  prefix: string,
  exclude: string
): Promise<string[]> {
  const result: string[] = [];
  try {
    const entries = await storage.readDir(joinPath(baseDir, prefix || '.'));
    for (const entry of entries) {
      const relativePath = prefix ? joinPath(prefix, entry.name) : entry.name;
      if (entry.isDirectory) {
        const nested = await listFilesRecursive(storage, baseDir, relativePath, exclude);
        result.push(...nested);
      } else if (entry.name !== exclude) {
        result.push(relativePath);
      }
    }
  } catch {
    /* no access */
  }
  return result;
}

export function serializeSkillMd(metadata: Partial<SkillMetadata>, content: string): string {
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
  set('license', metadata.license);
  set('compatibility', metadata.compatibility);
  if (metadata.metadata) set('metadata', metadata.metadata);

  const yaml = stringifyYaml(meta, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n\n${content}`;
}
