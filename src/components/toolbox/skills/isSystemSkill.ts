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
