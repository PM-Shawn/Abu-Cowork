import { describe, it, expect } from 'vitest';
import { rootManifestCount } from './rootManifest';

describe('rootManifestCount', () => {
  it('counts one root SKILL.md among other files, nested manifests excluded', () => {
    expect(rootManifestCount(['SKILL.md', 'references/SKILL.md', 'scripts/run.sh'])).toBe(1);
  });

  it('counts a repeated SKILL.md path twice', () => {
    expect(rootManifestCount(['SKILL.md', 'README.md', 'SKILL.md'])).toBe(2);
  });

  it.each(['skill.md', 'Skill.MD', 'ſkill.md', 'SKILL.md'])(
    'counts %s as the same file as SKILL.md, as a case-insensitive disk does',
    (other) => {
      expect(rootManifestCount(['SKILL.md', other])).toBe(2);
    },
  );
});
