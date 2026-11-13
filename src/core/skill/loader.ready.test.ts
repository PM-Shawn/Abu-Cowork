import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readTextFile, readDir, exists, lstat } from '@tauri-apps/plugin-fs';
import { homeDir, resolve } from '@tauri-apps/api/path';
import { SkillLoader } from './loader';
import { setSkillNamePolicy } from './skillNamePolicy';
import { publishPluginActivation } from '../plugin/activationPolicy';

/**
 * A scan reads the skill folders one after another. A reader that comes while
 * it runs (the first request of a run, after a boot or a workspace switch)
 * must not get a catalog that holds only the folders read so far: the catalog
 * is published when the scan is complete, and `ready()` waits for a running
 * scan.
 */

const mockReadTextFile = vi.mocked(readTextFile);
const mockReadDir = vi.mocked(readDir);
const mockExists = vi.mocked(exists);
const mockLstat = vi.mocked(lstat);
const mockHomeDir = vi.mocked(homeDir);
const mockResolve = vi.mocked(resolve);

const HOME = '/Users/testuser';
const USER_DIR = `${HOME}/.abu/skills`;
const BUILTIN_DIR = '../builtin-skills';

const skillFile = (name: string) => `---\nname: ${name}\ndescription: ${name} skill\n---\n\nBody for ${name}.\n`;

describe('SkillLoader scan publication', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  /** Holds the bundled folder's listing until the test lets the scan go on. */
  let releaseBuiltin: () => void;
  let builtinGate: Promise<void>;

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    publishPluginActivation({}, [], true);
    setSkillNamePolicy(() => true);
    mockHomeDir.mockResolvedValue(HOME);
    mockResolve.mockImplementation(async (...args: string[]) => args.join('/'));
    builtinGate = new Promise<void>((done) => { releaseBuiltin = done; });
    const tree: Record<string, string[]> = { [USER_DIR]: ['mine'], [BUILTIN_DIR]: ['docx', 'mermaid-diagram'] };
    const files = new Set([
      `${USER_DIR}/mine/SKILL.md`,
      `${BUILTIN_DIR}/docx/SKILL.md`,
      `${BUILTIN_DIR}/mermaid-diagram/SKILL.md`,
    ]);
    mockReadDir.mockImplementation(async (dir: string) => {
      if (dir === BUILTIN_DIR) await builtinGate;
      return (tree[dir] ?? []).map((name) => ({ name, isDirectory: true, isFile: false, isSymlink: false })) as never;
    });
    mockReadTextFile.mockImplementation(async (path: string) => {
      if (!files.has(path)) throw new Error('not found');
      return skillFile(path.split('/').at(-2) ?? '');
    });
    mockExists.mockImplementation(async (path: string) => path in tree || files.has(path));
    mockLstat.mockImplementation(async (path: string) => {
      if (files.has(path)) return { isFile: true, isDirectory: false, isSymlink: false } as never;
      if (path in tree) return { isFile: false, isDirectory: true, isSymlink: false } as never;
      throw new Error(`ENOENT: ${path}`);
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  async function untilBuiltinScanStarted(): Promise<void> {
    await vi.waitFor(() => expect(mockReadDir).toHaveBeenCalledWith(BUILTIN_DIR));
  }

  it('ready() waits for a running scan, and the catalog it then reads is complete', async () => {
    const loader = new SkillLoader();
    const scan = loader.discoverSkills(null);
    await untilBuiltinScanStarted();

    let ready = false;
    const readyPromise = loader.ready().then(() => { ready = true; });
    await new Promise((r) => setTimeout(r, 0));
    expect(ready).toBe(false);
    // The folder read before the bundled one is not served as the catalog.
    expect(loader.getSkill('mine')).toBeUndefined();

    releaseBuiltin();
    await readyPromise;
    await scan;
    expect(loader.getSkill('mermaid-diagram')).toBeDefined();
    expect(loader.getSkill('mine')).toBeDefined();
  });

  it('ready() resolves at once when no scan is running', async () => {
    await expect(new SkillLoader().ready()).resolves.toBeUndefined();
  });

  it('a rescan keeps serving the previous complete catalog until it is finished', async () => {
    const loader = new SkillLoader();
    releaseBuiltin();
    await loader.discoverSkills(null);
    builtinGate = new Promise<void>((done) => { releaseBuiltin = done; });
    mockReadDir.mockClear();

    const rescan = loader.discoverSkills('/work/project');
    await untilBuiltinScanStarted();
    expect(loader.getSkill('mermaid-diagram')).toBeDefined();
    expect(loader.getAvailableSkills().map((s) => s.name).sort()).toEqual(['docx', 'mermaid-diagram', 'mine']);

    releaseBuiltin();
    await rescan;
    expect(loader.getCurrentWorkspace()).toBe('/work/project');
  });

  it('an older scan that ends after a newer one does not replace its catalog', async () => {
    const loader = new SkillLoader();
    const older = loader.discoverSkills('/work/old');
    await untilBuiltinScanStarted();
    mockReadDir.mockClear();
    const newer = loader.discoverSkills('/work/new');
    await untilBuiltinScanStarted();
    releaseBuiltin();
    await Promise.all([older, newer]);
    expect(loader.getCurrentWorkspace()).toBe('/work/new');
  });

  describe('ready() with a bound', () => {
    afterEach(() => { vi.useRealTimers(); });

    async function loaderWithCompleteCatalog(): Promise<SkillLoader> {
      const loader = new SkillLoader();
      releaseBuiltin();
      await loader.discoverSkills(null);
      builtinGate = new Promise<void>((done) => { releaseBuiltin = done; });
      mockReadDir.mockClear();
      return loader;
    }

    it('resolves after timeoutMs when a scan never settles, and the catalog is the previous complete one', async () => {
      const loader = await loaderWithCompleteCatalog();
      vi.useFakeTimers();
      void loader.discoverSkills('/work/hung');
      await vi.waitFor(() => expect(mockReadDir).toHaveBeenCalledWith(BUILTIN_DIR));

      let ready = false;
      const waiting = loader.ready({ timeoutMs: 5000 }).then(() => { ready = true; });
      await vi.advanceTimersByTimeAsync(4999);
      expect(ready).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await waiting;
      expect(ready).toBe(true);
      expect(loader.getAvailableSkills().map((s) => s.name).sort()).toEqual(['docx', 'mermaid-diagram', 'mine']);
      expect(loader.getCurrentWorkspace()).toBeNull();
    });

    it('resolves when the signal aborts, and at once when it is already aborted', async () => {
      const loader = new SkillLoader();
      void loader.discoverSkills(null);
      await untilBuiltinScanStarted();

      const controller = new AbortController();
      let ready = false;
      const waiting = loader.ready({ signal: controller.signal }).then(() => { ready = true; });
      await new Promise((r) => setTimeout(r, 0));
      expect(ready).toBe(false);
      controller.abort();
      await waiting;
      expect(ready).toBe(true);

      await expect(loader.ready({ signal: controller.signal })).resolves.toBeUndefined();
    });

    it('removes its abort listener and timer once it settles', async () => {
      vi.useFakeTimers();
      const loader = new SkillLoader();
      const controller = new AbortController();
      const remove = vi.spyOn(controller.signal, 'removeEventListener');
      void loader.discoverSkills(null);
      await untilBuiltinScanStarted();
      const waiting = loader.ready({ signal: controller.signal, timeoutMs: 60_000 });
      releaseBuiltin();
      await waiting;
      expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
      expect(vi.getTimerCount()).toBe(0);
    });

    it('resolves when a scan rejects, and the previous catalog stays published', async () => {
      const loader = await loaderWithCompleteCatalog();
      mockHomeDir.mockRejectedValueOnce(new Error('ipc down'));
      const failing = loader.discoverSkills('/work/broken');
      const failure = failing.then(() => undefined, (e: unknown) => e);
      await expect(loader.ready()).resolves.toBeUndefined();
      await failure;
      expect(loader.getAvailableSkills().map((s) => s.name).sort()).toEqual(['docx', 'mermaid-diagram', 'mine']);
    });
  });
});
