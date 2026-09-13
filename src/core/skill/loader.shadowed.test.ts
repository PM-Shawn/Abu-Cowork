import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readTextFile, readDir, exists, lstat } from '@tauri-apps/plugin-fs';
import { homeDir, resolve } from '@tauri-apps/api/path';
import { SkillLoader } from './loader';
import { setSkillNamePolicy } from './skillNamePolicy';
import { publishPluginActivation } from '../plugin/activationPolicy';

/**
 * First-win on a name collision loses the later copy — but it must not make it
 * VANISH: the 市场 grid still shows the shipped `docx` card, marked as covered
 * by the user's same-name skill, rather than a hole where a built-in used to
 * be. `getShadowedSkills()` is what feeds that, and it answers to the same
 * `isUsable()` gate every other read path uses (so the organization's
 * blacklist is not sidestepped by the losing copy).
 */

const mockReadTextFile = vi.mocked(readTextFile);
const mockReadDir = vi.mocked(readDir);
const mockExists = vi.mocked(exists);
const mockLstat = vi.mocked(lstat);
const mockHomeDir = vi.mocked(homeDir);
const mockResolve = vi.mocked(resolve);

const HOME = '/Users/testuser';
const USER_DIR = `${HOME}/.abu/skills`;
// `resolveResource` is unavailable under the test host, so the loader falls
// back to the first dev candidate it can stat — this is the bundled dir.
const BUILTIN_DIR = '../builtin-skills';

const skillFile = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nBody for ${name}.\n`;

/** Minimal virtual tree: every listed dir holds one same-named sub-directory. */
function stubFs(dirEntries: Record<string, string[]>, fileContents: Record<string, string>) {
  const liveDirs = new Set(Object.keys(dirEntries));
  mockReadDir.mockImplementation(async (dir: string) =>
    (dirEntries[dir] ?? []).map((name) => ({ name, isDirectory: true, isFile: false, isSymlink: false })) as never);
  mockReadTextFile.mockImplementation(async (path: string) => {
    const content = fileContents[path];
    if (content === undefined) throw new Error('not found');
    return content;
  });
  mockExists.mockImplementation(async (path: string) => liveDirs.has(path) || path in fileContents);
  mockLstat.mockImplementation(async (path: string) => {
    if (path in fileContents) return { isFile: true, isDirectory: false, isSymlink: false } as never;
    if (liveDirs.has(path)) return { isFile: false, isDirectory: true, isSymlink: false } as never;
    throw new Error(`ENOENT: no such file or directory, lstat '${path}'`);
  });
}

describe('SkillLoader.getShadowedSkills', () => {
  // The dev-fallback path logs which bundled dir it found; not this test's news.
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    publishPluginActivation({}, [], true);
    setSkillNamePolicy(() => true);
    mockHomeDir.mockResolvedValue(HOME);
    mockResolve.mockImplementation(async (...args: string[]) => args.join('/'));
    stubFs(
      { [USER_DIR]: ['docx'], [BUILTIN_DIR]: ['docx', 'pdf'] },
      {
        [`${USER_DIR}/docx/SKILL.md`]: skillFile('docx', 'The user’s own docx skill'),
        [`${BUILTIN_DIR}/docx/SKILL.md`]: skillFile('docx', 'The bundled docx skill'),
        [`${BUILTIN_DIR}/pdf/SKILL.md`]: skillFile('pdf', 'The bundled pdf skill'),
      },
    );
  });

  afterEach(() => {
    setSkillNamePolicy(() => true);
    logSpy.mockRestore();
  });

  it('reports the built-in copy a same-named user skill covered', async () => {
    const loader = new SkillLoader();
    await loader.discoverSkills();

    expect(loader.getSkill('docx')?.source).toBe('user');
    expect(loader.getShadowedSkills().map((s) => [s.name, s.source])).toEqual([['docx', 'builtin']]);
    // The winner is the only one listed: a shadowed copy is not a second card.
    expect(loader.getAvailableSkills().map((s) => s.name).sort()).toEqual(['docx', 'pdf']);
  });

  it('does not accumulate across rescans', async () => {
    const loader = new SkillLoader();
    await loader.discoverSkills();
    const first = loader.getShadowedSkills().length;
    await loader.discoverSkills();
    expect(loader.getShadowedSkills()).toHaveLength(first);
  });

  it('drops a shadowed skill whose name the organization blacklists', async () => {
    // The losing copy must not put a blocked name and description back on
    // screen after the winning one was filtered out of every other list.
    setSkillNamePolicy((name) => name !== 'docx');
    const loader = new SkillLoader();
    await loader.discoverSkills();

    expect(loader.getSkill('docx')).toBeUndefined();
    expect(loader.getShadowedSkills()).toEqual([]);
    // The scan still SAW both copies — the filter is a read-path gate, not a
    // scan-time drop, so a policy change applies without a rescan.
    expect(loader.getNameClaims().filter((claim) => claim.name === 'docx')).toHaveLength(2);
    setSkillNamePolicy(() => true);
    expect(loader.getShadowedSkills().map((s) => [s.name, s.source])).toEqual([['docx', 'builtin']]);
  });
});
