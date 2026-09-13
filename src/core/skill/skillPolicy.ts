/**
 * The organization's skill blacklist, asked the one way every skill writer asks it.
 *
 * `checkSkill` is the enterprise policy hook (a name blacklist; the OSS stub
 * allows everything). It used to be consulted only by the folder installer, so
 * a blocked name could still be created by `skill_manage`, installed from npm or
 * a URL, saved in the skill editor, or accepted from a draft. The rule every
 * writer now applies: no write may leave a SKILL.md that answers to a blocked
 * name. Removing a skill is never refused.
 *
 * This is the writers' half. The loader's half — a skill that reaches disk
 * some other way (a repository's committed skills, one installed before the
 * policy arrived) is never listed or run — asks the same hook through the
 * `skillNamePolicy` port, which the sidecar bundle can swap out.
 */

import { getCurrentPolicy } from '@/core/enterprise/policy/enforcer';
import { checkSkill } from '@/core/enterprise/policy/matcher';

/** The policy's reason when a skill may not answer to `name`, otherwise `null`. */
export function skillPolicyDenial(name: string): string | null {
  const result = checkSkill(getCurrentPolicy(), name);
  return result.decision === 'deny' ? (result.reason ?? `skill '${name}' blocked by policy`) : null;
}

/**
 * Thrown by the writers that report failure by throwing (npm / URL installers,
 * acceptDraft). `message` is developer-facing English; callers that show it to
 * someone branch on this class and render their own localized text from
 * `skillName`.
 */
export class SkillPolicyDeniedError extends Error {
  readonly code = 'POLICY_DENIED' as const;
  readonly skillName: string;

  constructor(skillName: string, reason: string) {
    super(`[policy] ${reason}`);
    this.name = 'SkillPolicyDeniedError';
    this.skillName = skillName;
  }
}

/** Throws {@link SkillPolicyDeniedError} when the policy blocks `name`. */
export function assertSkillNameAllowed(name: string): void {
  const reason = skillPolicyDenial(name);
  if (reason) throw new SkillPolicyDeniedError(name, reason);
}
