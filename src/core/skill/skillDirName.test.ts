import { describe, it, expect } from 'vitest';
import { isSafeSkillDirName } from './skillDirName';

describe('isSafeSkillDirName', () => {
  it.each(['my-skill', 'pdf', 'DJ_Data_Agent', 'skill.v2', '中文技能', 'a b'])(
    'accepts %j',
    (name) => {
      expect(isSafeSkillDirName(name)).toBe(true);
    },
  );

  it.each([
    ['..', 'the parent directory itself'],
    ['.', 'the current directory itself'],
    ['../../.ssh', 'resolves to ~/.ssh, which the host scope guard allows'],
    ['a/b', 'a nested path, not a directory name'],
    ['/etc', 'absolute'],
    ['..\\..\\evil', 'the Windows spelling of the same escape'],
    ['evil\0.md', 'a NUL truncates the path at the OS boundary'],
    ['', 'no name at all'],
  ])('rejects %j — %s', (name) => {
    expect(isSafeSkillDirName(name)).toBe(false);
  });
});
