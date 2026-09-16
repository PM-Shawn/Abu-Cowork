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
    [' ', 'whitespace only — a directory nobody can type, name in the UI, or pass back to skill_manage'],
    ['\t', 'the same, spelled with a tab'],
    ['  ', 'the same, spelled with two spaces'],
    [' evil ', 'padded: the name printed in the toast is not the name on disk'],
    ['evil\n', 'a newline ends the line the name is printed on'],
    ['evil\r', 'a carriage return rewrites the line the name is printed on'],
    ['ev\til', 'an interior tab is a control character in a displayed name'],
    ['...', 'a segment that is only dots, like the two the predicate already named'],
    ['....', 'the same, one dot longer'],
    ['sa\u202Efe.md', 'RIGHT-TO-LEFT OVERRIDE: the displayed name is not the name on disk'],
    ['pd\u200Bf', 'a zero-width space makes a second skill wearing an existing one\u2019s face'],
    ['\uFEFFpdf', 'a BOM is invisible in every surface that prints the name'],
    ['a\u200Eb', 'LEFT-TO-RIGHT MARK — invisible, and it reorders what is displayed'],
    ['a\u2066b', 'a directional isolate — invisible, and it reorders what is displayed'],
  ])('rejects %j — %s', (name) => {
    expect(isSafeSkillDirName(name)).toBe(false);
  });

  // The predicate this repo already wrote for the identical job:
  // `assertSafeSegment` (src/core/plugin/paths.ts) guards a third-party string
  // turned into a path segment under $HOME against the same host weakness.
  // These are its rules, restated as the cases they reject — a skill name and a
  // plugin name are the same kind of string and must not answer differently.
  it.each([
    ['\u0000', 'NUL'],
    ['\u001f', 'a C0 control character'],
    ['\u007f', 'DEL'],
  ])('rejects a name containing %j (%s), as assertSafeSegment does', (ch) => {
    expect(isSafeSkillDirName(`evil${ch}name`)).toBe(false);
  });

  // C1 controls: `isPlainSegment` (src/utils/itemStorage.ts), the editor's
  // rule for the same folder name, refuses them, so this predicate must too —
  // the two routes must not disagree about which names can become a folder.
  it.each([
    ['\u0080', 'the first C1 control character'],
    ['\u0085', 'NEL, a line break to some readers'],
    ['\u009f', 'the last C1 control character'],
  ])('rejects a name containing %j (%s), as isPlainSegment does', (ch) => {
    expect(isSafeSkillDirName(`evil${ch}name`)).toBe(false);
  });

  // U+00A0 is where C1 ends; the Latin-1 letters after it are real names.
  it.each(['evil\u00a0name', 'café'])('accepts %j, just past the C1 range', (name) => {
    expect(isSafeSkillDirName(name)).toBe(true);
  });

  // Deliberately still accepted. ZWNJ and ZWJ are ordinary characters in
  // Persian, Arabic and Indic orthographies and inside emoji sequences — they
  // are not the spoofing characters above, and rejecting them would refuse
  // real names.
  it.each(['\u200C', '\u200D'])('accepts a name containing %j', (ch) => {
    expect(isSafeSkillDirName(`na${ch}me`)).toBe(true);
  });
});
