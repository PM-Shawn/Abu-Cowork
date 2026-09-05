/**
 * Turn a plugin package's `agents/` payload into Abu's own agent format.
 *
 * The Claude Code / Codex plugin ecosystem ships an agent as ONE markdown file
 * (`agents/<name>.md`: YAML frontmatter + the system prompt as the body), while
 * Abu stores an agent as a directory (`~/.abu/agents/<name>/AGENT.md`). This
 * module is the pure translation layer between the two, plus the one removal
 * primitive uninstall needs. Nothing here discovers or installs anything —
 * that is the installer's job.
 *
 * Two rules make a stranger's agent safe enough to register:
 *   - **allowlist**, not denylist: only the keys `parseAgentFile` actually
 *     reads survive, so ecosystem-only keys (`color`, `permissionMode`, …)
 *     cannot smuggle behaviour into a file Abu will later parse;
 *   - **`memory: none`**, always. A third-party agent must not default to
 *     reading or writing the user's own memory — the single place a plugin
 *     agent is held stricter than one the user wrote themselves.
 * `tools` / `disallowed-tools` pass through: every tool call still goes through
 * Abu's permission gate and approvals, so declaring them only narrows the
 * default set (spec §4).
 */

import { remove, lstat } from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';
import { parse as parseYaml } from 'yaml';
import { joinPath } from '@/utils/pathUtils';
import { isSafeSkillDirName } from '@/core/skill/skillDirName';
import { serializeAgentMd } from '@/core/agent/registry';
import type { SubagentMetadata } from '@/types';

/**
 * Exactly the frontmatter keys `parseAgentFile` (src/core/agent/registry.ts)
 * reads. Anything else a package declares is dropped: Abu would ignore it on
 * read anyway, and writing it back out would suggest it means something here.
 *
 * Kept as the on-disk spellings (`max-turns`, not `maxTurns`) because that is
 * what both the parser and the serializer speak.
 */
export const AGENT_FRONTMATTER_ALLOWLIST = [
  'name',
  'description',
  'avatar',
  'model',
  'max-turns',
  'tools',
  'disallowed-tools',
  'skills',
  'memory',
  'background',
  'intro',
  'expertise',
  'sample-prompts',
  'category',
  'tags',
] as const;

/** Allowlisted keys whose value is a list, however the author spelled it. */
const LIST_KEYS = ['tools', 'disallowed-tools', 'skills', 'tags'] as const;

export interface ConvertedAgent {
  /** Frontmatter `name`, or the caller's fallback (the file/directory name). */
  name: string;
  /** Frontmatter `description`, or `''` — a missing one is not a rejection. */
  description: string;
  /** Allowlisted frontmatter, list fields normalised, `memory` forced to none. */
  frontmatter: Record<string, unknown>;
  /** The system prompt: everything after the closing fence, verbatim. */
  body: string;
}

/**
 * Frontmatter fence, matched the way `parseAgentFile` matches it: the FIRST
 * `---` line after the opening one closes the block, so a `---` horizontal
 * rule inside the prose stays prose (the Vercel plugin's `deployment-expert.md`
 * uses several).
 *
 * Two deliberate differences from the parser's regex: the trailing body group
 * is optional, so a file that is nothing but frontmatter converts to an empty
 * body instead of being read as one big body; and the run of spaces after a
 * fence is `[^\S\n]*` rather than `\s*`, which cannot swallow the newline that
 * delimits the fence itself. Neither can make this accept something the parser
 * would reject downstream: `renderAgentMd` re-serializes from scratch.
 */
const FRONTMATTER_RE = /^---[^\S\n]*\n([\s\S]*?)\n---[^\S\n]*(?:\n([\s\S]*))?$/;

/**
 * Convert one single-file agent into Abu's shape.
 *
 * `fallbackName` is what the caller would have called this agent without
 * frontmatter — the file's basename. A package that omits `name`, or gives one
 * that is blank or not a string, gets it; nothing is rejected for it.
 */
export function convertSingleFileAgent(raw: string, fallbackName: string): ConvertedAgent {
  const match = raw.match(FRONTMATTER_RE);

  // No frontmatter at all is a legitimate shape: the whole file is the prompt.
  // So is frontmatter that YAML cannot parse — the body is still the prompt,
  // there is simply no metadata to keep. Both land on the fallback name.
  let meta: Record<string, unknown> = {};
  let body: string;
  if (!match) {
    body = raw;
  } else {
    body = match[2] ?? '';
    try {
      const parsed: unknown = parseYaml(match[1]);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        meta = parsed as Record<string, unknown>;
      }
    } catch {
      // Leave `meta` empty — see above.
    }
  }

  const frontmatter: Record<string, unknown> = {};
  for (const key of AGENT_FRONTMATTER_ALLOWLIST) {
    if (!(key in meta)) continue;
    const value = meta[key];
    if (value === undefined || value === null) continue;
    if ((LIST_KEYS as readonly string[]).includes(key)) {
      const list = normalizeList(value);
      if (list.length > 0) frontmatter[key] = list;
      continue;
    }
    frontmatter[key] = value;
  }

  const name = typeof frontmatter.name === 'string' && frontmatter.name.trim().length > 0
    ? frontmatter.name.trim()
    : fallbackName;
  const description = typeof frontmatter.description === 'string' ? frontmatter.description : '';

  frontmatter.name = name;
  if (description === '') {
    delete frontmatter.description;
  } else {
    frontmatter.description = description;
  }
  // Whatever the package asked for. Set even when the package declared
  // nothing, so the written AGENT.md states the restriction rather than
  // relying on a default that could change.
  frontmatter.memory = 'none';

  return { name, description, frontmatter, body };
}

/**
 * Accept both list spellings and produce one clean list.
 *
 * `tools: Read, Grep` (a comma-separated scalar) is how the ecosystem's
 * single-file agents usually write it; `tools:\n  - Read` is how Abu writes it.
 * Both mean the same thing, so both come out trimmed, empty-filtered and
 * de-duplicated, order preserved. Anything that is neither a string nor an
 * array yields nothing, and the key is dropped.
 */
function normalizeList(value: unknown): string[] {
  const parts = typeof value === 'string'
    ? value.split(',')
    : Array.isArray(value)
      ? value.filter((v): v is string => typeof v === 'string')
      : [];
  const out: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed === '' || out.includes(trimmed)) continue;
    out.push(trimmed);
  }
  return out;
}

/**
 * Render a converted agent as AGENT.md text.
 *
 * Goes through `serializeAgentMd` — the same function `AgentEditor` writes
 * user-authored agents with — so a plugin's agent is byte-compatible with one
 * the user typed, and a change to Abu's format reaches both at once.
 *
 * The body is trimmed because that is what the round trip settles on anyway:
 * `parseAgentFile` trims the prompt on read, and the serializer supplies its
 * own blank line after the closing fence.
 */
export function renderAgentMd(agent: ConvertedAgent): string {
  const fm = agent.frontmatter;
  const metadata: Partial<SubagentMetadata> = {
    name: agent.name,
    description: agent.description,
    avatar: asString(fm.avatar),
    model: asString(fm.model),
    maxTurns: typeof fm['max-turns'] === 'number' ? fm['max-turns'] : undefined,
    tools: asStringArray(fm.tools),
    disallowedTools: asStringArray(fm['disallowed-tools']),
    skills: asStringArray(fm.skills),
    background: fm.background === true,
    intro: asString(fm.intro),
    expertise: asStringArray(fm.expertise),
    samplePrompts: asStringArray(fm['sample-prompts']),
    category: asString(fm.category),
    tags: asStringArray(fm.tags),
  };
  // `SubagentMetadata['memory']` does not spell 'none' — no Abu-authored agent
  // can be created with it — but the ruling (spec §4) is that a plugin agent
  // reads and writes no memory at all, and both the serializer and
  // `parseAgentFile` round-trip the value as written. Widening the union is a
  // product decision beyond this converter, so the value is stated here and the
  // shared type is left alone.
  (metadata as Record<string, unknown>).memory = 'none';
  return serializeAgentMd(metadata, agent.body.trim());
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.filter((v): v is string => typeof v === 'string');
  return list.length > 0 ? list : undefined;
}

export type RemoveContributedAgentResult = {
  removed: boolean;
  reason?: 'not-found' | 'symlink' | 'unsafe-name' | 'error';
};

/**
 * Delete `~/.abu/agents/<name>` — the directory a plugin install contributed.
 *
 * Three gates before anything is removed, because the argument comes out of an
 * install record that is hand-editable JSON on disk:
 *
 *   - **`isSafeSkillDirName`** — the same single-segment predicate the agent
 *     installer applies before it *creates* this directory. `joinPath` does not
 *     collapse `..` and the privileged host only asks whether the RESOLVED path
 *     is under an allowed root (`$HOME` among them), so `../../Documents` would
 *     resolve to a real directory and be removed recursively. Removal must
 *     apply exactly the rule creation applied.
 *   - **`lstat`, not `exists`** — `lstat` is the one fs call routed with
 *     `followFinalSymlink: false` (electron/fsHost.cjs), which is the only way
 *     to ask what the path ITSELF is. Every other call resolves it.
 *   - **a real directory** — a link is refused rather than followed (removing
 *     it would be removing something the plugin never installed, and following
 *     it would delete the target's contents); anything else is reported absent,
 *     which is what it is as far as a contributed agent goes.
 */
export async function removeContributedAgent(name: string): Promise<RemoveContributedAgentResult> {
  if (!isSafeSkillDirName(name)) return { removed: false, reason: 'unsafe-name' };

  try {
    const home = await homeDir();
    // The expression `installAgentFromFolder` builds its target with, so both
    // sides of install/uninstall name the same directory by construction.
    const dir = joinPath(home, '.abu', 'agents', name);

    let info: { isSymlink: boolean; isDirectory: boolean };
    try {
      info = await lstat(dir);
    } catch {
      // Not lstat-able — absent for our purposes; there is nothing to withdraw.
      return { removed: false, reason: 'not-found' };
    }
    if (info.isSymlink) return { removed: false, reason: 'symlink' };
    if (!info.isDirectory) return { removed: false, reason: 'not-found' };

    await remove(dir, { recursive: true });
    return { removed: true };
  } catch {
    return { removed: false, reason: 'error' };
  }
}
