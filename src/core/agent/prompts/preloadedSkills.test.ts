import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTextFile, readDir, exists, lstat } from '@tauri-apps/plugin-fs';
import { homeDir, resolve } from '@tauri-apps/api/path';
import { SkillLoader } from '../../skill/loader';
import {
  PRELOADED_SKILLS_MAX_BYTES,
  appendPreloadedSkills,
  resolvePreloadedSkills,
} from './preloadedSkills';

const mockReadTextFile = vi.mocked(readTextFile);
const mockReadDir = vi.mocked(readDir);
const mockExists = vi.mocked(exists);
const mockLstat = vi.mocked(lstat);
const mockHomeDir = vi.mocked(homeDir);
const mockResolve = vi.mocked(resolve);

/** Route the globally-mocked Tauri fs at the real filesystem (mirrors
 *  loader.test.ts's own `useRealFs`, so the loader under test is the real
 *  one reading a real skill tree). */
function useRealFs(): void {
  mockReadDir.mockImplementation(async (p: string | URL) =>
    readdirSync(String(p), { withFileTypes: true }).map((d) => ({
      name: d.name,
      isDirectory: d.isDirectory(),
      isFile: d.isFile(),
      isSymlink: d.isSymbolicLink(),
    })) as never,
  );
  mockReadTextFile.mockImplementation(async (p: string | URL) => readFileSync(String(p), 'utf8'));
  mockExists.mockImplementation(async (p: string | URL) => existsSync(String(p)));
  mockLstat.mockImplementation(async (p: string | URL) => {
    const info = lstatSync(String(p));
    return {
      isFile: info.isFile(),
      isDirectory: info.isDirectory(),
      isSymlink: info.isSymbolicLink(),
    } as never;
  });
}

function writeSkill(skillsDir: string, name: string, body: string): void {
  const dir = join(skillsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Description of ${name}\n---\n\n${body}\n`,
  );
}

describe('resolvePreloadedSkills', () => {
  let root: string;
  let workspace: string;
  let skillsDir: string;
  let loader: SkillLoader;

  beforeEach(async () => {
    vi.clearAllMocks();
    root = mkdtempSync(join(tmpdir(), 'abu-preloaded-skills-'));
    workspace = join(root, 'workspace');
    skillsDir = join(workspace, '.abu', 'skills');
    mkdirSync(join(root, 'home'), { recursive: true });
    mkdirSync(skillsDir, { recursive: true });
    useRealFs();
    // $HOME inside the fixture so global scan roots cannot reach the real ~.
    mockHomeDir.mockResolvedValue(join(root, 'home'));
    // No bundled-resource dir: keeps the repo's own builtin-skills out of the scan.
    mockResolve.mockRejectedValue(new Error('no resource dir in this test'));
    loader = new SkillLoader();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns null for an agent that declares no skills', async () => {
    writeSkill(skillsDir, 'weekly-report', 'Weekly report instructions.');
    await loader.discoverSkills(workspace);

    expect(await resolvePreloadedSkills({ name: 'a1' }, loader)).toBeNull();
    expect(await resolvePreloadedSkills({ name: 'a1', skills: [] }, loader)).toBeNull();
  });

  it('appends nothing, byte-identical, when there is no injection', () => {
    const base = 'You are an agent.\n\n## Current Time\n2026-09-03';
    expect(appendPreloadedSkills(base, null)).toBe(base);
    expect(appendPreloadedSkills(base, undefined)).toBe(base);
  });

  it('injects a listed skill body and leaves unlisted skills out', async () => {
    writeSkill(skillsDir, 'weekly-report', 'Step 1: collect the numbers.');
    writeSkill(skillsDir, 'unlisted-skill', 'Never preload this body.');
    await loader.discoverSkills(workspace);

    const injection = await resolvePreloadedSkills(
      { name: 'reporter', skills: ['weekly-report'] },
      loader,
    );

    expect(injection).not.toBeNull();
    expect(injection?.text).toContain('## Preloaded Skills');
    expect(injection?.text).toContain('### weekly-report');
    expect(injection?.text).toContain('Description of weekly-report');
    expect(injection?.text).toContain('Step 1: collect the numbers.');
    expect(injection?.text).not.toContain('Never preload this body.');
    expect(injection?.text).not.toContain('unlisted-skill');
    expect(injection?.resolved).toEqual(['weekly-report']);
    expect(injection?.missing).toEqual([]);
    // Names the tools that actually exist for on-demand reads.
    expect(injection?.text).toContain('skill_view');
  });

  it('reports an unresolvable name instead of throwing', async () => {
    writeSkill(skillsDir, 'weekly-report', 'Step 1: collect the numbers.');
    await loader.discoverSkills(workspace);

    const injection = await resolvePreloadedSkills(
      { name: 'reporter', skills: ['weekly-report', 'no-such-skill'] },
      loader,
    );

    expect(injection?.missing).toEqual(['no-such-skill']);
    expect(injection?.text).toContain('no-such-skill');
    expect(injection?.text).toContain('not found');
    // The resolvable one still preloads.
    expect(injection?.text).toContain('Step 1: collect the numbers.');
  });

  it('keeps declaration order and drops duplicate names', async () => {
    writeSkill(skillsDir, 'alpha', 'Alpha body.');
    writeSkill(skillsDir, 'beta', 'Beta body.');
    await loader.discoverSkills(workspace);

    const injection = await resolvePreloadedSkills(
      { name: 'reporter', skills: ['beta', 'alpha', 'beta'] },
      loader,
    );

    expect(injection?.resolved).toEqual(['beta', 'alpha']);
    expect(injection?.text.indexOf('### beta')).toBeLessThan(injection?.text.indexOf('### alpha') ?? -1);
  });

  it('truncates at the byte cap with a marker naming the skill', async () => {
    const bigBody = 'A'.repeat(PRELOADED_SKILLS_MAX_BYTES - 100);
    writeSkill(skillsDir, 'first-big', bigBody);
    writeSkill(skillsDir, 'second-big', `SECOND-BODY-MARKER ${bigBody}`);
    await loader.discoverSkills(workspace);

    const injection = await resolvePreloadedSkills(
      { name: 'reporter', skills: ['first-big', 'second-big'] },
      loader,
    );

    expect(injection?.truncated).toEqual(['second-big']);
    expect(injection?.text).toContain('Preloaded skill "second-big" was truncated');
    // Ten 50 KB skills must not silently eat the context: the whole section
    // stays within the body cap plus its small fixed guidance/marker overhead.
    const sectionBytes = new TextEncoder().encode(injection?.text ?? '').byteLength;
    expect(sectionBytes).toBeLessThan(PRELOADED_SKILLS_MAX_BYTES + 2000);
    // The first, in-budget skill is still preloaded whole.
    expect(injection?.text).toContain(bigBody);
  });

  it('gives a skill past the spent budget no body at all, and names it', async () => {
    const bigBody = 'B'.repeat(PRELOADED_SKILLS_MAX_BYTES);
    writeSkill(skillsDir, 'fills-budget', bigBody);
    writeSkill(skillsDir, 'gets-nothing', 'body that never fits');
    await loader.discoverSkills(workspace);

    const injection = await resolvePreloadedSkills(
      { name: 'reporter', skills: ['fills-budget', 'gets-nothing'] },
      loader,
    );

    expect(injection?.truncated).toEqual(['gets-nothing']);
    expect(injection?.text).toContain('Preloaded skill "gets-nothing" was truncated');
    expect(injection?.text).not.toContain('body that never fits');
  });
});
