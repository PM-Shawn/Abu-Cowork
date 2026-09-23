import { describe, it, expect, vi, beforeEach } from 'vitest';

const POLICY = { skillBlacklist: ['blocked-skill'] };

vi.mock('@/core/enterprise/policy/enforcer', () => ({
  getCurrentPolicy: vi.fn(() => POLICY),
}));
vi.mock('@/core/enterprise/policy/matcher', () => ({
  checkSkill: vi.fn(),
}));

import { checkSkill } from '@/core/enterprise/policy/matcher';
import { skillPolicyDenial, assertSkillNameAllowed, SkillPolicyDeniedError } from './skillPolicy';

const mockCheckSkill = vi.mocked(checkSkill);

describe('skillPolicy', () => {
  beforeEach(() => {
    mockCheckSkill.mockReset();
  });

  it('asks the policy hook with the current policy and the exact name', () => {
    mockCheckSkill.mockReturnValue({ decision: 'allow' });
    skillPolicyDenial('my-skill');
    expect(mockCheckSkill).toHaveBeenCalledWith(POLICY, 'my-skill');
  });

  it('allows a name the policy allows', () => {
    mockCheckSkill.mockReturnValue({ decision: 'allow' });
    expect(skillPolicyDenial('my-skill')).toBeNull();
    expect(() => assertSkillNameAllowed('my-skill')).not.toThrow();
  });

  it("returns the policy's reason for a denied name", () => {
    mockCheckSkill.mockReturnValue({ decision: 'deny', reason: "skill 'blocked-skill' blocked by policy" });
    expect(skillPolicyDenial('blocked-skill')).toBe("skill 'blocked-skill' blocked by policy");
  });

  it('still refuses a denial that carries no reason', () => {
    mockCheckSkill.mockReturnValue({ decision: 'deny' });
    expect(skillPolicyDenial('blocked-skill')).toBe("skill 'blocked-skill' blocked by policy");
  });

  it('throws a SkillPolicyDeniedError naming the skill', () => {
    mockCheckSkill.mockReturnValue({ decision: 'deny', reason: 'no' });
    let caught: unknown;
    try {
      assertSkillNameAllowed('blocked-skill');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SkillPolicyDeniedError);
    expect((caught as SkillPolicyDeniedError).skillName).toBe('blocked-skill');
    expect((caught as SkillPolicyDeniedError).code).toBe('POLICY_DENIED');
  });
});
