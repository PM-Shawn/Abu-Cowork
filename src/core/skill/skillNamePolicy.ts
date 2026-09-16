/**
 * The organization's skill blacklist, as the skill loader asks it.
 *
 * `SkillLoader` filters every listing and lookup through this port, so a
 * blacklisted name never appears or runs however its SKILL.md reached disk
 * (a repository's committed skills, one installed before the policy arrived,
 * a plugin's, one written with the generic file tools).
 *
 * A port rather than a direct import because `loader.ts` is also bundled into
 * the sidecar, and the default below reaches the enterprise store through
 * `getCurrentPolicy()` — which `scripts/build-sidecar.mjs`'s bundle guard
 * keeps out of that bundle. The sidecar build swaps this module for
 * `sidecar/src/shims/skillNamePolicyRun.ts`. Same slot shape as every port in
 * `core/agent/ports/` (see `portSlot.ts`).
 *
 * The default asks the policy on every call; nothing is cached, so a policy
 * change applies to the next lookup.
 */

import { createPortSlot } from '@/core/agent/ports/portSlot';
import { skillPolicyDenial } from './skillPolicy';

/** Whether the organization's policy lets a skill answer to `name`. */
export type SkillNamePolicy = (name: string) => boolean;

const slot = createPortSlot<SkillNamePolicy>(() => (name) => skillPolicyDenial(name) === null);

export function isSkillNameAllowed(name: string): boolean {
  return slot.get()(name);
}

/** Replace the policy — a runtime without the enterprise store, or a test. */
export function setSkillNamePolicy(policy: SkillNamePolicy): void {
  slot.set(policy);
}
