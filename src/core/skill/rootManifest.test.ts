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

  it.each(['./SKILL.md', '/SKILL.md', 'a//../SKILL.md', 'x/../SKILL.md', '.\\SKILL.md'])(
    'counts %s, which the disk resolves to the root SKILL.md',
    (other) => {
      expect(rootManifestCount(['SKILL.md', other])).toBe(2);
    },
  );

  it.each(['SKILL.md.', 'SKILL.md ', 'SKILL.md. .', 'SKILL.md::$DATA'])(
    'counts %s, which NTFS writes onto SKILL.md',
    (other) => {
      expect(rootManifestCount(['SKILL.md', other])).toBe(2);
    },
  );
});
