import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { homeDir } from '@tauri-apps/api/path';
import { copyFile, exists, lstat, mkdir, readDir, readFile, readTextFile, remove, rename, writeFile } from '@tauri-apps/plugin-fs';
import { useAppStore } from '@/stores/appStore';
import type { AppDefinition } from '@/types/app';
import { saveAddedApp } from './appRecords';
import { initAddedAppsSync, refreshAddedApps, removeApp } from './appSync';

vi.mock('@/utils/atomicFs', () => ({
  atomicWrite: vi.fn(async (path: string, content: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }),
}));

type Shell = { mainSupervisesSidecar?: boolean; appPage?: (action: string, input: object) => Promise<unknown> };
const runtime = globalThis as typeof globalThis & { __ABU_SHELL__?: Shell };

let root: string;
let source: string;
/** What the Electron preload's app page host was asked, in order. */
let pageCalls: Array<[string, object]>;

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

const templates = [{ id: 'a', title: 'A', prompt: 'A' }, { id: 'b', title: 'B', prompt: 'B' }, { id: 'c', title: 'C', prompt: 'C' }];

/** Add an app the way the installer does: its folder copied under `~/.abu/apps/`, its record in `added.json`. */
async function addApp(name: string) {
  const dir = join(source, name, '.abu-app');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'app.json'), JSON.stringify({
    name, version: '1.0.0', minAbuVersion: '0.51.0',
    interface: { displayName: name, shortDescription: name },
    plugins: [],
    home: { modes: { items: [{ modeId: 'm', title: 'M', scenes: [{ id: 's', title: 'S', run: { team: 'builtin-team:reporting' }, templates }] }] } },
  }));
  await saveAddedApp(root, join(source, name), {
    appId: `${name}@lawyer-market`, name, version: '1.0.0', origin: { kind: 'market', market: 'lawyer-market' }, addedAt: '2026-10-07T00:00:00.000Z',
  });
}

const ids = () => useAppStore.getState().addedApps.map((app) => app.appId);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'abu-app-sync-'));
  source = join(root, 'source');
  useRealTree();
  vi.mocked(homeDir).mockResolvedValue(root);
  pageCalls = [];
  runtime.__ABU_SHELL__ = { mainSupervisesSidecar: true, appPage: async (action, input) => { pageCalls.push([action, input]); } };
  useAppStore.setState({ addedApps: [], managedApps: {} });
});

afterEach(() => {
  delete runtime.__ABU_SHELL__;
  rmSync(root, { recursive: true, force: true });
});

describe('appSync', () => {
  it('loads the added apps from ~/.abu/apps into the switcher', async () => {
    await addApp('weekly');
    await addApp('contract-review');
    await refreshAddedApps();
    expect(ids().sort()).toEqual(['contract-review@lawyer-market', 'weekly@lawyer-market']);
    expect(pageCalls).toEqual([]);
  });

  it('removes only the app, and closes its pages with their login state', async () => {
    await addApp('weekly');
    await addApp('contract-review');
    await refreshAddedApps();
    await removeApp('weekly@lawyer-market');
    expect(ids()).toEqual(['contract-review@lawyer-market']);
    expect(pageCalls).toEqual([['destroyForApp', { appId: 'weekly@lawyer-market', clearStorage: true }]]);
    expect(existsSync(join(source, 'weekly', '.abu-app', 'app.json'))).toBe(true);
  });

  it('keeps the later of two overlapping loads', async () => {
    await addApp('weekly');
    const first = refreshAddedApps();
    await addApp('contract-review');
    const second = refreshAddedApps();
    await Promise.all([first, second]);
    expect(ids().sort()).toEqual(['contract-review@lawyer-market', 'weekly@lawyer-market']);
  });

  it('touches no page host outside the Electron desktop host', async () => {
    delete runtime.__ABU_SHELL__;
    await addApp('weekly');
    await refreshAddedApps();
    await removeApp('weekly@lawyer-market');
    expect(ids()).toEqual([]);
    expect(pageCalls).toEqual([]);
  });

  it('hands the page host each organization app\'s pages whenever a sync replaces them', async () => {
    initAddedAppsSync();
    await vi.waitFor(() => expect(useAppStore.getState().addedApps).toEqual([]));
    const app = {
      appId: 'enterprise-app:a1', name: '合同审阅', version: '1', origin: { kind: 'enterprise' }, plugins: [],
      config: {
        home: { modes: { items: [] } },
        nav: { items: [{ id: 'chat', target: 'builtin:chat' }, { id: 'p', title: 'P', target: 'url:https://contracts.example.com/x' }] },
        allowedOrigins: ['https://contracts.example.com'],
      },
    } as unknown as AppDefinition;
    useAppStore.getState().replaceManagedApps('enterprise', [app]);
    await vi.waitFor(() => expect(pageCalls).toContainEqual(['setManagedApps', {
      apps: [{ appId: 'enterprise-app:a1', nav: app.config.nav, allowedOrigins: ['https://contracts.example.com'] }],
    }]));
  });
});
