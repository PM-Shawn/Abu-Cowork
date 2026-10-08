import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { copyFile, exists, lstat, mkdir, readDir, readFile, readTextFile, remove, rename, writeFile } from '@tauri-apps/plugin-fs';
import { addedAppId, addedAppsPath, appDir, loadAddedApps, readAddedApps, removeAddedApp, saveAddedApp, type AddedAppRecord } from './appRecords';

vi.mock('@/utils/atomicFs', () => ({
  atomicWrite: vi.fn(async (path: string, content: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }),
}));

let root: string;
let source: string;

/** The plugin-fs calls the module makes, served by the real disk under a temp root. */
function useRealTree() {
  vi.mocked(readTextFile).mockImplementation(async (p) => readFileSync(String(p), 'utf8'));
  vi.mocked(readFile).mockImplementation(async (p) => new Uint8Array(readFileSync(String(p))));
  vi.mocked(writeFile).mockImplementation(async (p, data) => { writeFileSync(String(p), data as Uint8Array); });
  vi.mocked(copyFile).mockImplementation(async (from, to) => { writeFileSync(String(to), readFileSync(String(from))); });
  vi.mocked(readDir).mockImplementation(async (p) => readdirSync(String(p), { withFileTypes: true }).map((d) => ({
    name: d.name, isDirectory: d.isDirectory(), isFile: d.isFile(), isSymlink: d.isSymbolicLink(),
  })) as never);
  vi.mocked(mkdir).mockImplementation(async (p) => { mkdirSync(String(p), { recursive: true }); });
  vi.mocked(exists).mockImplementation(async (p) => existsSync(String(p)));
  vi.mocked(lstat).mockImplementation(async (p) => ({ isSymlink: lstatSync(String(p)).isSymbolicLink(), isDirectory: lstatSync(String(p)).isDirectory(), isFile: lstatSync(String(p)).isFile() }) as never);
  vi.mocked(remove).mockImplementation(async (p) => { rmSync(String(p), { recursive: true, force: true }); });
  vi.mocked(rename).mockImplementation(async (from, to) => { renameSync(String(from), String(to)); });
}

function writeApp(dir: string, overrides: Record<string, unknown> = {}) {
  mkdirSync(join(dir, '.abu-app'), { recursive: true });
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'assets', 'logo.png'), 'png');
  writeFileSync(join(dir, '.abu-app', 'app.json'), JSON.stringify({
    name: 'contract-review',
    version: '1.0.0',
    minAbuVersion: '0.51.0',
    interface: { displayName: '合同审阅', shortDescription: '按律所的做法审合同', logo: 'assets/logo.png' },
    home: { modes: { items: [{ modeId: 'm', title: 'M', scenes: [{ id: 's', title: 'S', run: { team: 'builtin-team:reporting' }, templates: [{ id: 'a', title: 'A', prompt: 'A' }, { id: 'b', title: 'B', prompt: 'B' }, { id: 'c', title: 'C', prompt: 'C' }] }] }] } },
    ...overrides,
  }));
}

function record(overrides: Partial<AddedAppRecord> = {}): AddedAppRecord {
  return { appId: 'contract-review@lawyer-market', name: 'contract-review', version: '1.0.0', origin: { kind: 'market', market: 'lawyer-market' }, addedAt: '2026-09-28T00:00:00.000Z', ...overrides };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'abu-app-records-'));
  source = join(root, 'source');
  writeApp(source);
  useRealTree();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('addedAppId', () => {
  it('names an app by its name and where it came from', () => {
    expect(addedAppId('contract-review', { kind: 'market', market: 'lawyer-market' })).toBe('contract-review@lawyer-market');
    expect(addedAppId('contract-review', { kind: 'folder', dir: '/work/app' })).toBe('contract-review@local');
    expect(addedAppId('weekly', { kind: 'created', authoringId: 'a1' })).toBe('weekly@mine');
  });

  it('refuses an id that would not stay one directory', () => {
    expect(() => appDir(root, '../escape')).toThrow('cannot name a directory');
    expect(() => appDir(root, '..')).toThrow('cannot name a directory');
  });
});

describe('saving, loading and removing', () => {
  it('copies the files, records the app and loads it for the switcher', async () => {
    await saveAddedApp(root, source, record());
    expect(await readAddedApps(root)).toEqual([record()]);
    const [app] = await loadAddedApps(root);
    expect(app).toMatchObject({ appId: 'contract-review@lawyer-market', name: '合同审阅', description: '按律所的做法审合同', version: '1.0.0', origin: { kind: 'market', market: 'lawyer-market' }, plugins: [] });
    expect(app.logo?.replace(/\\/g, '/')).toBe(`${appDir(root, app.appId)}/assets/logo.png`.replace(/\\/g, '/'));
    // What runs is the copy: the source can go away.
    rmSync(source, { recursive: true, force: true });
    expect((await loadAddedApps(root)).map((item) => item.appId)).toEqual(['contract-review@lawyer-market']);
  });

  it('replaces the app when the same app is added again', async () => {
    await saveAddedApp(root, source, record());
    writeApp(source, { version: '1.1.0' });
    await saveAddedApp(root, source, record({ version: '1.1.0' }));
    expect(await readAddedApps(root)).toEqual([record({ version: '1.1.0' })]);
    expect((await loadAddedApps(root))[0].version).toBe('1.1.0');
    expect(readdirSync(join(root, '.abu', 'apps', '.staging'))).toEqual([]);
  });

  it('removes only the app', async () => {
    await saveAddedApp(root, source, record());
    await removeAddedApp(root, 'contract-review@lawyer-market');
    expect(await readAddedApps(root)).toEqual([]);
    expect(existsSync(appDir(root, 'contract-review@lawyer-market'))).toBe(false);
    await expect(removeAddedApp(root, 'contract-review@lawyer-market')).rejects.toThrow('is not added');
  });

  it('keeps other apps when one app no longer reads', async () => {
    await saveAddedApp(root, source, record());
    const other = join(root, 'other');
    writeApp(other, { name: 'weekly' });
    await saveAddedApp(root, other, record({ appId: 'weekly@local', name: 'weekly', origin: { kind: 'folder', dir: other } }));
    writeFileSync(join(appDir(root, 'contract-review@lawyer-market'), '.abu-app', 'app.json'), '{"name":"contract-review"}');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await loadAddedApps(root)).map((app) => app.appId)).toEqual(['weekly@local']);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('contract-review@lawyer-market'), expect.anything());
    errors.mockRestore();
  });

  it('reads a missing file as nothing added and refuses a damaged one', async () => {
    expect(await readAddedApps(root)).toEqual([]);
    mkdirSync(dirname(addedAppsPath(root)), { recursive: true });
    writeFileSync(addedAppsPath(root), '{}');
    await expect(readAddedApps(root)).rejects.toThrow('not a list');
    writeFileSync(addedAppsPath(root), JSON.stringify([{ ...record(), appId: 'other@lawyer-market' }]));
    await expect(readAddedApps(root)).rejects.toThrow('entry 0 is not an app record');
  });
});
