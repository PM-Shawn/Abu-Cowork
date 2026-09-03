/**
 * `## Preloaded Skills` — renders an agent definition's `skills:` frontmatter
 * field into the prompt that starts that agent's loop.
 *
 * ## What `skills:` means
 *
 * PRELOAD, never RESTRICT. Every name listed in an `AGENT.md`'s `skills:`
 * field is resolved through the skill loader and its full SKILL.md body is
 * injected into the agent's context when the loop starts. Skills that are
 * NOT listed stay available exactly as they are today — the agent discovers
 * them through the available-skills index and reads them on demand. Nothing
 * here removes a skill from any agent.
 *
 * This matches the two agent specs that already ship the field: Claude Code
 * documents it as "array of skill names to preload into the agent context"
 * (and logs `Preloaded skill '…'` at run start), and WorkBuddy's agent spec
 * as "启动时预加载的 Skill". No shipping agent runtime uses the field as a
 * per-agent allowlist, so neither does this.
 *
 * ## Fail loud, never silently ineffective
 *
 * A declared name that resolves to nothing is a configuration error the user
 * must be able to see: it is named inside the section itself (so the model
 * does not act as if those instructions were loaded) and returned in
 * `missing` so each call site can put it on the log channel its run already
 * has. It never throws and never aborts the run — a typo in one name must not
 * cost the user the whole agent.
 *
 * ## Where the resolution happens
 *
 * The skill loader is shell-resident (its in-memory index is only ever filled
 * by shell-side discovery — the sidecar hosts `runSubagentLoop` with an empty
 * loader), so a loop that can run in the sidecar receives an ALREADY-RESOLVED
 * `PreloadedSkillsInjection` rather than resolving one itself. Same discipline
 * as the main loop's shell-precomputed `orchestration` sections.
 */

import type { Skill, SubagentDefinition } from '../../../types';
import { skillLoader } from '../../skill/loader';

/**
 * Total byte budget for the injected skill BODIES (the only unbounded part of
 * the section — the fixed guidance plus each skill's name/description is a few
 * hundred bytes and always survives).
 *
 * 32 KiB ≈ 8k tokens ≈ 4% of the default 200k context window. Sized against
 * the two budgets this repo already spends on prompt-injected files: project
 * rules get 12,000 chars total (`projectRules.ts`) and the available-skills
 * index gets `max(16_000, window × 2%)` chars (`orchestrator.ts`). Preloading
 * is opt-in and its whole value is having the body in context, so it gets
 * more than either — but a run that declares ten 50 KB skills must still leave
 * the user's own task the majority of the window, so it is capped rather than
 * unbounded, and every cut is marked in-band (see `truncated`).
 */
export const PRELOADED_SKILLS_MAX_BYTES = 32_768;

/** The subset of the skill loader this module needs. Injectable for tests. */
export interface PreloadedSkillSource {
  loadSkill(name: string): Promise<Skill | null>;
}

/** Wire-safe plain data: resolved shell-side, injected by the loop. */
export interface PreloadedSkillsInjection {
  /** Rendered section, `## Preloaded Skills` heading included. Never empty. */
  text: string;
  /** Declared names that resolved to a discovered skill, declaration order. */
  resolved: string[];
  /** Declared names no discovered skill matched. Fail-loud payload. */
  missing: string[];
  /** Resolved names whose body was cut by `PRELOADED_SKILLS_MAX_BYTES`. */
  truncated: string[];
}

const textEncoder = new TextEncoder();

function utf8Bytes(text: string): number {
  return textEncoder.encode(text).byteLength;
}

/**
 * Longest prefix of `text` that fits in `maxBytes` UTF-8 bytes, cut on a
 * character boundary (never mid-code-point). Binary search so a 50 KB body
 * costs a handful of encodes rather than one per character.
 *
 * The search runs over UTF-16 code units, so its boundary can land BETWEEN the
 * two halves of an astral-plane character (emoji, rare CJK ext, most
 * pictographs). A lone high surrogate is not a character: `TextEncoder` maps it
 * to U+FFFD, which is 3 bytes — under the 4 the whole pair needed, so the
 * budget check accepts it and the malformed unit is kept and then serialised
 * onto the wire. Dropping that trailing half is the whole reason the last step
 * exists; without it a cut with 3 bytes of headroom left in the budget emits
 * `"\ud83d"`. (BMP characters, CJK included, are single code units and can
 * never straddle the boundary.)
 */
function sliceToBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (utf8Bytes(text) <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (utf8Bytes(text.slice(0, mid)) <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  // Never end on the leading half of a surrogate pair. One step is enough: a
  // high surrogate can only ever be followed by its own low half, so at most a
  // single unit is unpaired at the boundary.
  if (low > 0) {
    const lastUnit = text.charCodeAt(low - 1);
    if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) low -= 1;
  }
  return text.slice(0, low);
}

const HEADING = '## Preloaded Skills';

const GUIDANCE = [
  'The skills below are preloaded because this agent declares them: their full instructions are already in your context, so do not re-read them just to see what is written here.',
  'Supporting files inside a preloaded skill\'s own directory are still read on demand — call skill_view with that skill\'s name and a file_path (read_skill_file does the same job).',
  'Every skill that is NOT listed here remains available on demand exactly as the skills guidance describes. This list preloads knowledge; it does not restrict which skills you may use.',
].join('\n');

function renderTruncationMarker(name: string): string {
  return `\n\n[Preloaded skill "${name}" was truncated here to stay inside the ${PRELOADED_SKILLS_MAX_BYTES}-byte preload budget. Read the rest with skill_view("${name}").]`;
}

function renderMissingNote(missing: string[]): string {
  const names = missing.map((name) => `"${name}"`).join(', ');
  return [
    '### Declared but not found',
    `This agent declares ${names}, but no such skill was found, so nothing was preloaded for ${missing.length === 1 ? 'it' : 'them'}.`,
    'Do not act as if those instructions were loaded. If the task needs them, say so instead of guessing.',
  ].join('\n');
}

/**
 * Resolve an agent definition's `skills:` field into a prompt section.
 *
 * Returns `null` when the agent declares no skills — the caller then appends
 * nothing at all, so an agent without the field keeps a byte-identical prompt.
 */
export async function resolvePreloadedSkills(
  agent: Pick<SubagentDefinition, 'name' | 'skills'>,
  source: PreloadedSkillSource = skillLoader,
): Promise<PreloadedSkillsInjection | null> {
  const declared = agent.skills;
  if (!Array.isArray(declared) || declared.length === 0) return null;

  // Declaration order, first-win on duplicates: injecting the same body twice
  // would pay for it twice.
  const names: string[] = [];
  for (const raw of declared) {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (!names.includes(name)) names.push(name);
  }

  const resolved: string[] = [];
  const missing: string[] = [];
  const truncated: string[] = [];
  const blocks: string[] = [];
  let bodyBytesLeft = PRELOADED_SKILLS_MAX_BYTES;

  for (const name of names) {
    const skill = name ? await source.loadSkill(name) : null;
    if (!skill) {
      missing.push(name);
      continue;
    }
    resolved.push(name);
    const body = skill.content ?? '';
    const kept = sliceToBytes(body, bodyBytesLeft);
    bodyBytesLeft -= utf8Bytes(kept);
    const wasCut = kept.length < body.length;
    if (wasCut) truncated.push(name);
    blocks.push(
      `### ${skill.name}\n${skill.description}\n\n${kept}${wasCut ? renderTruncationMarker(name) : ''}`,
    );
  }

  const parts = [HEADING, GUIDANCE, ...blocks];
  if (missing.length > 0) parts.push(renderMissingNote(missing));

  return { text: parts.join('\n\n'), resolved, missing, truncated };
}

/**
 * Append a resolved section to a system prompt. A missing injection appends
 * nothing — the byte-identical guarantee for agents without `skills:`.
 */
export function appendPreloadedSkills(
  systemPrompt: string,
  injection: PreloadedSkillsInjection | null | undefined,
): string {
  if (!injection) return systemPrompt;
  return `${systemPrompt}\n\n${injection.text}`;
}
