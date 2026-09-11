/**
 * "Ships with Abu" — true for the bundled builtin-skills directory and for any
 * skill whose name matches a builtin marketplace template. Both 「我的」 and
 * 「市场」 ask this before offering to edit or delete, so it lives apart from
 * either component rather than being duplicated in each.
 */

import { skillTemplates } from '@/data/marketplace/skills';
import type { Skill } from '@/types';

const systemSkillNames = new Set(
  skillTemplates.filter((t) => t.isBuiltin).map((t) => t.name),
);

export function isSystemSkill(skill: Skill): boolean {
  return skill.filePath.includes('builtin-skills') || systemSkillNames.has(skill.name);
}

/**
 * "The user can edit or delete this." Ships-with-Abu is only half the answer:
 * a plugin's or the organization's skill is someone else's file too. Inlining
 * the source checks at each call site silently dropped the template-name half
 * of isSystemSkill, which made a user-directory skill sharing a builtin
 * template's name editable and deletable — so both halves live here now.
 */
export function isUserOwnedSkill(skill: Skill): boolean {
  return skill.source !== 'builtin'
    && skill.source !== 'plugin'
    && skill.source !== 'enterprise'
    && !isSystemSkill(skill);
}
