import { describe, it, expect, vi, beforeEach } from 'vitest';

const hook = vi.hoisted(() => ({
  policy: { id: 'first' } as unknown,
  checkSkill: vi.fn((_policy: unknown, name: string) =>
    name === 'blocked' ? { decision: 'deny' as const, reason: 'no' } : { decision: 'allow' as const }),
}));

vi.mock('@/core/enterprise/policy/enforcer', () => ({ getCurrentPolicy: () => hook.policy }));
vi.mock('@/core/enterprise/policy/matcher', () => ({ checkSkill: hook.checkSkill }));

import { isSkillNameAllowed, setSkillNamePolicy } from './skillNamePolicy';

describe('skillNamePolicy', () => {
  beforeEach(() => {
    hook.checkSkill.mockClear();
    hook.policy = { id: 'first' };
  });

  it('asks the enterprise checkSkill hook by default', () => {
    expect(isSkillNameAllowed('blocked')).toBe(false);
    expect(isSkillNameAllowed('ok')).toBe(true);
    expect(hook.checkSkill).toHaveBeenCalledWith({ id: 'first' }, 'blocked');
  });

  it('reads the current policy on every call, so a policy change applies at once', () => {
    isSkillNameAllowed('ok');
    hook.policy = { id: 'second' };
    isSkillNameAllowed('ok');
    expect(hook.checkSkill).toHaveBeenLastCalledWith({ id: 'second' }, 'ok');
  });

  it('lets a runtime inject its own policy', () => {
    setSkillNamePolicy(() => true);
    expect(isSkillNameAllowed('blocked')).toBe(true);
    expect(hook.checkSkill).not.toHaveBeenCalled();
  });
});
