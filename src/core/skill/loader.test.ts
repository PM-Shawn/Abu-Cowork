import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTextFile, readDir, exists, lstat } from '@tauri-apps/plugin-fs';
import { homeDir, resolve } from '@tauri-apps/api/path';
import { SkillLoader } from './loader';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
import type { EnterpriseBinding, EnterpriseConfigSnapshot } from '@/core/enterprise/types';

const mockReadTextFile = vi.mocked(readTextFile);
const mockReadDir = vi.mocked(readDir);
const mockExists = vi.mocked(exists);
const mockLstat = vi.mocked(lstat);
const mockHomeDir = vi.mocked(homeDir);
const mockResolve = vi.mocked(resolve);

const SKILL_TEMPLATE = (name: string) => `---
name: ${name}
description: Test skill ${name}
---

Body content for ${name}.
`;

beforeEach(() => {
  vi.clearAllMocks();
  mockExists.mockResolvedValue(true);
  mockReadDir.mockResolvedValue([]);
  mockReadTextFile.mockRejectedValue(new Error('not found'));
  useEnterpriseStore.setState({ mode: { kind: 'personal' }, initialized: true });
});

const enterpriseBinding: EnterpriseBinding = {
  serverUrl: 'https://enterprise.example', orgId: 'org-1', orgName: 'Org',
  userId: 'user-1', userName: 'User', userEmail: 'user@example.com',
  deptId: null, roleId: null, accessToken: 'token', boundAt: '2026-08-05T00:00:00Z',
  llmEndpoint: null, llmVirtualKey: null, llmKeyExpiresAt: null,
};

const enterpriseConfig: EnterpriseConfigSnapshot = {
  brand: { name: 'Org', logoUrl: null, primaryColor: null }, defaultSoul: null,
  policyDefaults: {}, modules: ['skills', 'mcp', 'kb'], licenseStatus: 'valid',
  licenseExpiresAt: '2099-01-01T00:00:00Z',
  serverTime: '2026-08-05T00:00:00Z', fetchedAt: 1_700_000_000_000, // filler (TESTING.md §3)
};

/**
 * Set up a canned directory listing: when readDir is called with any
 * of the keys, return the given entries. Else return []. Any SKILL.md
 * content is looked up in `fileContents` keyed by absolute path.
 */
function stubFs(
  dirEntries: Record<string, string[]>,
  fileContents: Record<string, string>,
) {
  mockReadDir.mockImplementation(async (dir: string) => {
    const entries = dirEntries[dir] ?? [];
    return entries.map((name) => ({
      name,
      isDirectory: true,
      isFile: false,
      isSymlink: false,
    })) as Awaited<ReturnType<typeof readDir>>;
  });

  mockReadTextFile.mockImplementation(async (path: string) => {
    const content = fileContents[path];
    if (content === undefined) throw new Error('not found');
    return content;
  });

  // exists returns true for any path we've populated OR its parent dirs
  const liveDirs = new Set(Object.keys(dirEntries));
  mockExists.mockImplementation(async (path: string) => {
    return liveDirs.has(path) || Object.keys(fileContents).some((p) => p === path);
  });

  // The scan asks `lstat` whether a manifest is a real file of the skill's own
  // before reading it, so the virtual tree has to answer that too. The global
  // mock in src/test/setup.ts only says `{ isSymlink: false }`, which would
  // make every manifest look like a non-file.
  mockLstat.mockImplementation(async (path: string) => {
    if (path in fileContents) {
      return { isFile: true, isDirectory: false, isSymlink: false } as never;
    }
    if (liveDirs.has(path)) {
      return { isFile: false, isDirectory: true, isSymlink: false } as never;
    }
    throw new Error(`ENOENT: no such file or directory, lstat '${path}'`);
  });
}

describe('SkillLoader.discoverSkills · workspace awareness', () => {
  it('loads enterprise skills only while a live session authorizes the skills module', async () => {
    const enterpriseDir = '/Users/testuser/.abu/skills/enterprise';
    stubFs(
      { [enterpriseDir]: ['org-skill'] },
      { [`${enterpriseDir}/org-skill/SKILL.md`]: SKILL_TEMPLATE('org-skill') },
    );
    const loader = new SkillLoader();

    await loader.discoverSkills(null);
    expect(loader.has('org-skill')).toBe(false);

    useEnterpriseStore.setState({ mode: { kind: 'enterprise', binding: enterpriseBinding, config: enterpriseConfig } });
    await loader.discoverSkills(null);
    expect(loader.has('org-skill')).toBe(__ENTERPRISE_BUILD__);
    expect(loader.getSkill('org-skill')?.source).toBe(__ENTERPRISE_BUILD__ ? 'enterprise' : undefined);

    useEnterpriseStore.setState({
      mode: { kind: 'offline', binding: enterpriseBinding, lastConfig: enterpriseConfig, reason: 'license rejected' },
    });
    expect(loader.has('org-skill')).toBe(false);
    expect(loader.getSkill('org-skill')).toBeUndefined();
    expect(loader.getAvailableSkills().some(skill => skill.name === 'org-skill')).toBe(false);
    expect(loader.findMatchingSkills('org-skill')).toEqual([]);
  });

  it('scans global dirs only when workspacePath is null', async () => {
    stubFs(
      {
        '/Users/testuser/.abu/skills': ['global-skill'],
      },
      {
        '/Users/testuser/.abu/skills/global-skill/SKILL.md': SKILL_TEMPLATE('global-skill'),
      },
    );

    const loader = new SkillLoader();
    const skills = await loader.discoverSkills(null);

    expect(skills.map((s) => s.name)).toContain('global-skill');
    expect(loader.getCurrentWorkspace()).toBeNull();
  });

  it('scans workspace + global dirs when workspacePath provided', async () => {
    const workspace = '/Users/testuser/projects/myapp';
    stubFs(
      {
        [`${workspace}/.abu/skills`]: ['project-skill'],
        '/Users/testuser/.abu/skills': ['global-skill'],
      },
      {
        [`${workspace}/.abu/skills/project-skill/SKILL.md`]: SKILL_TEMPLATE('project-skill'),
        '/Users/testuser/.abu/skills/global-skill/SKILL.md': SKILL_TEMPLATE('global-skill'),
      },
    );

    const loader = new SkillLoader();
    const skills = await loader.discoverSkills(workspace);
    const names = skills.map((s) => s.name);

    expect(names).toContain('project-skill');
    expect(names).toContain('global-skill');
    expect(loader.getCurrentWorkspace()).toBe(workspace);
  });

  it('workspace-auto skills are discovered under ~/.abu/projects/<key>/skills', async () => {
    const workspace = '/Users/testuser/projects/myapp';
    // sanitizePath('/Users/testuser/projects/myapp') → '-Users-testuser-projects-myapp'
    const autoDir = '/Users/testuser/.abu/projects/-Users-testuser-projects-myapp/skills';
    stubFs(
      {
        [autoDir]: ['auto-skill'],
      },
      {
        [`${autoDir}/auto-skill/SKILL.md`]: SKILL_TEMPLATE('auto-skill'),
      },
    );

    const loader = new SkillLoader();
    await loader.discoverSkills(workspace);

    const all = loader.getAvailableSkills();
    const auto = all.find((s) => s.name === 'auto-skill');
    expect(auto).toBeDefined();
    expect(auto!.source).toBe('workspace-auto');
  });

  it('drafts are NOT in getAvailableSkills() by default (excluded from L0 index)', async () => {
    const workspace = '/Users/testuser/projects/myapp';
    const draftDir = '/Users/testuser/.abu/projects/-Users-testuser-projects-myapp/skills/drafts';
    stubFs(
      {
        [draftDir]: ['pending-skill'],
      },
      {
        [`${draftDir}/pending-skill/SKILL.md`]: SKILL_TEMPLATE('pending-skill'),
      },
    );

    const loader = new SkillLoader();
    await loader.discoverSkills(workspace);

    // Default: drafts hidden
    const defaultList = loader.getAvailableSkills();
    expect(defaultList.find((s) => s.name === 'pending-skill')).toBeUndefined();

    // Opt-in: drafts visible (for Settings UI)
    const withDrafts = loader.getAvailableSkills({ includeDrafts: true });
    expect(withDrafts.find((s) => s.name === 'pending-skill')).toBeDefined();

    // Full draft objects available for review UI
    const drafts = loader.getDraftSkills();
    expect(drafts).toHaveLength(1);
    expect(drafts[0].source).toBe('draft');
    expect(drafts[0].content).toContain('Body content for pending-skill');
  });

  it('first-win: workspace skill beats global with same name', async () => {
    const workspace = '/Users/testuser/projects/myapp';
    stubFs(
      {
        [`${workspace}/.abu/skills`]: ['shared-name'],
        '/Users/testuser/.abu/skills': ['shared-name'],
      },
      {
        [`${workspace}/.abu/skills/shared-name/SKILL.md`]:
          SKILL_TEMPLATE('shared-name').replace('Body content', 'WORKSPACE'),
        '/Users/testuser/.abu/skills/shared-name/SKILL.md':
          SKILL_TEMPLATE('shared-name').replace('Body content', 'GLOBAL'),
      },
    );

    const loader = new SkillLoader();
    await loader.discoverSkills(workspace);

    const shared = loader.getSkill('shared-name');
    expect(shared).toBeDefined();
    // Workspace version should win (project source, priority 1)
    expect(shared!.content).toContain('WORKSPACE');
    expect(shared!.source).toBe('project');
  });

  it('switching workspace causes full re-scan', async () => {
    stubFs(
      {
        '/ws/a/.abu/skills': ['a-only'],
        '/ws/b/.abu/skills': ['b-only'],
      },
      {
        '/ws/a/.abu/skills/a-only/SKILL.md': SKILL_TEMPLATE('a-only'),
        '/ws/b/.abu/skills/b-only/SKILL.md': SKILL_TEMPLATE('b-only'),
      },
    );

    const loader = new SkillLoader();

    await loader.discoverSkills('/ws/a');
    expect(loader.has('a-only')).toBe(true);
    expect(loader.has('b-only')).toBe(false);

    await loader.discoverSkills('/ws/b');
    expect(loader.has('a-only')).toBe(false);
    expect(loader.has('b-only')).toBe(true);
    expect(loader.getCurrentWorkspace()).toBe('/ws/b');
  });
});

/**
 * These run against REAL temporary trees carrying REAL symlinks and a REAL
 * FIFO, driving the mocked `@tauri-apps/plugin-fs` surface through node's fs
 * exactly the way `electron/fsHost.cjs` does.
 *
 * Deliberately not the virtual tree above. Every hand-written entry in it says
 * `isSymlink: false`, which is precisely the blind spot that let this ship: a
 * dirent for a link reports `isDirectory: false` / `isFile: false` /
 * `isSymlink: true` whichever kind of thing it points at, and a FIFO reports
 * `isDirectory: false` / `isFile: false` / `isSymlink: false`. Only a real
 * dirent produces those combinations by itself.
 */

/** Point the mocked plugin-fs surface at the real filesystem. */
/** What the non-blocking read hands back where the real host would block. */
const BYTES_FROM_A_PIPE = 'BYTES-FROM-A-PIPE';

/** Every path `useRealFs`'s readTextFile was asked for, in call order. */
let readTextTargets: string[] = [];

function useRealFs() {
  readTextTargets = [];
  mockReadDir.mockImplementation(async (p: string | URL) =>
    readdirSync(String(p), { withFileTypes: true }).map((d) => ({
      name: d.name,
      isDirectory: d.isDirectory(),
      isFile: d.isFile(),
      isSymlink: d.isSymbolicLink(),
    })) as never,
  );
  // Both of these FOLLOW a symlink — what the privileged host does, and the
  // whole reason a link may not be treated as an ordinary entry.
  //
  // EXCEPT on a non-regular file: a faithful read of a writer-less pipe never
  // returns, so a regression would HANG this run rather than fail it (vitest's
  // own timeout cannot fire either — the blocked `readFileSync` stalls the
  // worker's event loop). Handing back recognisable bytes instead turns the
  // defect into an assertion, exactly as `useNonBlockingReads` does in
  // installer.test.ts and the `0xde 0xad` mock does in plugin/fsOps.test.ts.
  mockReadTextFile.mockImplementation(async (p: string | URL) => {
    readTextTargets.push(String(p));
    if (!lstatSync(String(p)).isFile()) return BYTES_FROM_A_PIPE as never;
    return readFileSync(String(p), 'utf8');
  });
  mockExists.mockImplementation(async (p: string | URL) => existsSync(String(p)));
  // `lstat` is the one call routed with `followFinalSymlink: false`, which is
  // exactly what an ownership question needs.
  mockLstat.mockImplementation(async (p: string | URL) => {
    const info = lstatSync(String(p));
    return {
      isFile: info.isFile(),
      isDirectory: info.isDirectory(),
      isSymlink: info.isSymbolicLink(),
    } as never;
  });
}

const OWNED_SKILL_MD = '---\nname: helper\ndescription: a skill\n---\n# body';
const OUTSIDE_SKILL_MD = '---\nname: stolen\ndescription: from outside\n---\n# body';

describe('SkillLoader over a real tree with real symlinks', () => {
  let root: string;
  let workspace: string;
  let skillsDir: string;
  let helperDir: string;
  let secret: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'abu-skill-loader-'));
    workspace = join(root, 'cloned-repo');
    skillsDir = join(workspace, '.abu', 'skills');
    helperDir = join(skillsDir, 'helper');
    secret = join(root, 'id_rsa');

    mkdirSync(join(helperDir, 'references'), { recursive: true });
    writeFileSync(secret, 'PRIVATE-KEY-BYTES');
    writeFileSync(join(helperDir, 'SKILL.md'), OWNED_SKILL_MD);
    writeFileSync(join(helperDir, 'references', 'api.md'), 'real reference');

    useRealFs();
    // $HOME lives inside the fixture so the global scan roots cannot reach the
    // developer's real ~/.abu/skills.
    mockHomeDir.mockResolvedValue(join(root, 'home'));
    // No bundled-resource dir: the dev fallback would otherwise resolve the
    // repo's own ./builtin-skills relative to the cwd and scan all of it.
    mockResolve.mockRejectedValue(new Error('no resource dir in this test'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('does not adopt a skill whose SKILL.md is a symlink', async () => {
    // The manifest names the skill and therefore its identity. A linked one is
    // a manifest the directory does not own — the skill would be adopted from
    // outside the directory the loader was asked to scan.
    mkdirSync(join(root, 'elsewhere'), { recursive: true });
    writeFileSync(join(root, 'elsewhere', 'SKILL.md'), OUTSIDE_SKILL_MD);
    rmSync(join(helperDir, 'SKILL.md'));
    symlinkSync(join(root, 'elsewhere', 'SKILL.md'), join(helperDir, 'SKILL.md'));

    const loader = new SkillLoader();
    const skills = await loader.discoverSkills(workspace);

    expect(skills.map((s) => s.name)).not.toContain('stolen');
    expect(loader.has('stolen')).toBe(false);
    expect(loader.has('helper')).toBe(false);
  });

  it('does not scan a skill directory that is itself a symlink', async () => {
    // Load-bearing and invisible: `read_dir`'s flags are lstat-based, so a link
    // to a directory already reports `isDirectory: false`. Pinned so a later
    // "surely this should follow directories" edit has to argue with a test.
    const outside = join(root, 'outside-skill');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'SKILL.md'), OUTSIDE_SKILL_MD);
    symlinkSync(outside, join(skillsDir, 'linked'), 'dir');

    const loader = new SkillLoader();
    await loader.discoverSkills(workspace);

    expect(loader.has('stolen')).toBe(false);
    expect(loader.has('helper')).toBe(true);
  });

  it('never advertises a symlink as a supporting file', async () => {
    symlinkSync(secret, join(helperDir, 'notes.md'));
    symlinkSync(join(root, 'elsewhere-dir'), join(helperDir, 'linkdir'), 'dir');
    mkdirSync(join(root, 'elsewhere-dir'), { recursive: true });
    writeFileSync(join(root, 'elsewhere-dir', 'other.md'), 'not this skill');

    const loader = new SkillLoader();
    await loader.discoverSkills(workspace);
    const files = await loader.listSupportingFiles('helper');

    expect(files).toEqual(['references/api.md']);
  });

  it('never reads a symlinked supporting file', async () => {
    symlinkSync(secret, join(helperDir, 'notes.md'));

    const loader = new SkillLoader();
    await loader.discoverSkills(workspace);

    expect(await loader.loadSupportingFile('helper', 'notes.md')).toBeNull();
    // The real neighbour still loads — this is an ownership rule, not a ban on
    // supporting files.
    expect(await loader.loadSupportingFile('helper', 'references/api.md')).toBe('real reference');
  });

  it('accepts a leading "./" — the form a model writes — while still refusing ".."', async () => {
    const loader = new SkillLoader();
    await loader.discoverSkills(workspace);

    // `skill_view` hands the model's string straight through, and models
    // routinely spell a relative path `./references/api.md`. A `.` segment
    // names the directory it is already in, so it cannot escape anything —
    // refusing it would only teach the model that the file does not exist.
    expect(await loader.loadSupportingFile('helper', './references/api.md')).toBe('real reference');
    expect(await loader.loadSupportingFile('helper', 'references/./api.md')).toBe('real reference');
    // `..` is the segment that can leave the skill; it stays refused.
    expect(await loader.loadSupportingFile('helper', '../helper/references/api.md')).toBeNull();
    expect(await loader.loadSupportingFile('helper', 'references/../references/api.md')).toBeNull();
  });

  it('never reads through a symlinked INTERMEDIATE directory', async () => {
    // `relativePath.includes('..')` is a string test; a link needs no `..` at
    // all. Every segment has to be owned, not just the last one.
    const outside = join(root, 'outside-refs');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'api.md'), 'SECRET-FROM-OUTSIDE');
    symlinkSync(outside, join(helperDir, 'refs'), 'dir');

    const loader = new SkillLoader();
    await loader.discoverSkills(workspace);

    expect(await loader.loadSupportingFile('helper', 'refs/api.md')).toBeNull();
  });

  it('treats a FIFO as absent rather than reading it', async () => {
    // A FIFO's dirent is `{ isDirectory: false, isFile: false, isSymlink: false }`
    // — the one non-regular shape a symlink test does not catch. `readFileSync`
    // on one blocks the privileged host's event loop until a writer appears, so
    // "not a directory" is not a good enough reason to read something.
    //
    // Pre-loading the pipe would NOT make a regression fail instead of hang: a
    // FIFO keeps no buffer once its last descriptor closes, so the next `open`
    // for read blocks all the same. `useRealFs` is what keeps this test honest
    // — it refuses to issue a blocking read and hands back BYTES_FROM_A_PIPE,
    // so a regression fails on the assertions below.
    const fifo = join(helperDir, 'pipe.md');
    execFileSync('mkfifo', [fifo]);

    const loader = new SkillLoader();
    await loader.discoverSkills(workspace);

    expect(await loader.listSupportingFiles('helper')).toEqual(['references/api.md']);
    expect(await loader.loadSupportingFile('helper', 'pipe.md')).toBeNull();
    // The read that would have frozen the main process was never issued.
    expect(readTextTargets).not.toContain(fifo);
  });
});
