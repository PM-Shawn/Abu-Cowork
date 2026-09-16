import { describe, it, expect } from 'vitest';
import { isSkillNameAllowed, setSkillNamePolicy } from './skillNamePolicyRun';

describe('skillNamePolicyRun (sidecar)', () => {
  it('refuses every skill name until a real policy is injected', () => {
    expect(isSkillNameAllowed('pdf')).toBe(false);
    expect(isSkillNameAllowed('')).toBe(false);
  });

  it('answers with the injected policy', () => {
    setSkillNamePolicy((name) => name !== 'blocked');
    expect(isSkillNameAllowed('pdf')).toBe(true);
    expect(isSkillNameAllowed('blocked')).toBe(false);
  });
});
