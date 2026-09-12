import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseSkillFile } from './loader';

/**
 * `name:` frontmatter is one plain path segment. The loader scans the opened
 * workspace's skill folders too — content a cloned repository ships — and a
 * skill's name is the folder it lives in under `~/.abu/skills/`, where
 * `joinPath` does not collapse `..`. A name that is not one segment is refused
 * at parse time, loudly enough that the author can find the file.
 */
describe('parseSkillFile — name: must be one plain path segment', () => {
  const filePath = '/repo/.abu/skills/x/SKILL.md';
  function skillFile(nameLine: string): string {
    return `---\n${nameLine}\ndescription: A skill\n---\n\nDo the thing.\n`;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['', 'empty'],
    [' ', 'blank'],
    ['.', 'the current directory'],
    ['..', 'the parent directory'],
    ['...', 'only dots'],
    ['../../evil', 'climbs out of ~/.abu/skills'],
    ['a/b', 'a nested path'],
    ['/etc', 'absolute'],
    ['..\\..\\evil', 'the Windows spelling of the same escape'],
    ['C:\\x', 'a Windows absolute path'],
    ['evil\u0000name', 'NUL'],
    ['evil\u0001name', 'a C0 control character'],
    ['evil\u0085name', 'NEL, a C1 control character'],
    ['a\nb', 'an interior newline'],
    [' evil', 'leading whitespace'],
    ['evil ', 'trailing whitespace'],
    ['evil\t', 'a trailing tab'],
  ])('refuses %j (%s) and warns naming the file', (name) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseSkillFile(skillFile(`name: ${JSON.stringify(name)}`), filePath)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    const text = warn.mock.calls[0].join(' ');
    expect(text).toContain(filePath);
    expect(text).toContain(JSON.stringify(name));
  });

  it.each(['产品经理', 'HR 招聘官', '数据分析师', 'code-reviewer', 'QA_bot', 'skill.v2', 'abu'])(
    'accepts %j without a warning',
    (name) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(parseSkillFile(skillFile(`name: ${JSON.stringify(name)}`), filePath)?.name).toBe(name);
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['description: only', 'no name key'],
    ['name:', 'a null name'],
    ['name: 42', 'a number'],
    ['name: [a, b]', 'a list'],
  ])('returns null without a warning for %j (%s)', (nameLine) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseSkillFile(skillFile(nameLine), filePath)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});
