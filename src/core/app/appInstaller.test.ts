import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { copyFile, exists, lstat, mkdir, readDir, readFile, readTextFile, remove, rename, writeFile } from '@tauri-apps/plugin-fs';
import type { InstallDisclosure } from '@/core/plugin/installer';
import { planInstall, releasePreparedInstall } from '@/core/plugin/installer';
import { usePluginStore } from '@/stores/pluginStore';
import { useAppStore } from '@/stores/appStore';
import type { RefCatalog } from './appRefs';
import { AppAddError, confirmAddApp, needsConfirmation, planAddApp } from './appInstaller';
import { readAddedApps } from './appRecords';

// The plugin installer and the plugin store are their own subjects: here they
// only have to be asked for the right plugins, in the right order.
vi.mock('@/core/plugin/installer', async (original) => ({
  ...(await original<typeof import('@/core/plugin/installer')>()),
  planInstall: vi.fn(),
  releasePreparedInstall: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/utils/atomicFs', () => ({
  atomicWrite: vi.fn(async (path: string, content: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }),
}));
vi.mock('./appSync', () => ({ refreshAddedApps: vi.fn().mockResolvedValue(undefined) }));

let root: string;
let market: string;

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

function writeMarket(apps: Array<{ name: string; run: unknown; plugins?: string[]; minAbuVersion?: string; allowedOrigins?: string[] }>, plugins: Array<{ name: string; version: string }>) {
  mkdirSync(join(market, '.abu-plugin'), { recursive: true });
  writeFileSync(join(market, '.abu-plugin', 'marketplace.json'), JSON.stringify({
    name: 'lawyer-market',
    plugins: plugins.map((plugin) => ({ name: plugin.name, version: plugin.version, source: `./plugins/${plugin.name}` })),
    apps: apps.map((app) => ({ name: app.name, source: `./apps/${app.name}` })),
  }));
  for (const app of apps) {
    const dir = join(market, 'apps', app.name, '.abu-app');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'app.json'), JSON.stringify({
      name: app.name, version: '1.0.0', minAbuVersion: app.minAbuVersion ?? '0.51.0',
      interface: { displayName: '合同审阅', shortDescription: '审合同' },
      plugins: app.plugins ?? [],
      ...(app.allowedOrigins ? { allowedOrigins: app.allowedOrigins, nav: { items: [{ id: 'chat', target: 'builtin:chat' }, { id: 'p', title: 'P', target: `url:${app.allowedOrigins[0]}/x` }] } } : {}),
      home: { modes: { items: [{ modeId: 'm', title: 'M', scenes: [{ id: 's', title: 'S', run: app.run, templates }] }] } },
    }));
  }
}

function disclosure(name: string, teams: string[]): InstallDisclosure {
  return {
    key: `${name}@lawyer-market`, name, marketplace: 'lawyer-market', version: '1.0.0', manifest: { name }, sourceDir: `/m/${name}`,
    skills: [], mcpServers: [], agents: [], teams: teams.map((id) => ({ id, name: id, leaderRoleId: 'l', memberRoleIds: ['l'], requirePlanApproval: false, description: id, expertise: [], samplePrompts: [] })),
    ignoredPayloads: [], preparedToken: `token-${name}`,
  } as InstallDisclosure;
}

const emptyCatalog: RefCatalog = { plugins: [], teams: [], getAgent: () => undefined, findManagedAgent: () => undefined, skillNames: new Set() };
const marketRef = () => ({ name: 'lawyer-market', dir: market });
const entry = (name: string) => ({ name, source: { kind: 'relative' as const, path: `./apps/${name}` } });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'abu-app-installer-'));
  market = join(root, 'market');
  useRealTree();
  vi.mocked(planInstall).mockReset();
  vi.mocked(releasePreparedInstall).mockClear();
  usePluginStore.setState({ marketplaces: [marketRef()], installed: [] });
  useAppStore.setState({ addedApps: [], managedApps: {} });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('planAddApp', () => {
  it('needs no confirmation when the app uses only what Abu ships and opens no websites', async () => {
    writeMarket([{ name: 'weekly', run: { team: 'builtin-team:reporting' } }], []);
    const plan = await planAddApp({ kind: 'market', market: marketRef(), entry: entry('weekly') }, root, { ...emptyCatalog, teams: [{ id: 'builtin-team:reporting', name: '汇报', leaderRoleId: 'l', memberRoleIds: ['l'], createdAt: 0 }] });
    expect(plan.appId).toBe('weekly@lawyer-market');
    expect(plan.steps).toEqual([]);
    expect(needsConfirmation(plan)).toBe(false);
  });

  it('lists the websites an app opens, which always needs a look first', async () => {
    writeMarket([{ name: 'portal', run: { team: 'builtin-team:reporting' }, allowedOrigins: ['https://portal.example.com'] }], []);
    const plan = await planAddApp({ kind: 'market', market: marketRef(), entry: entry('portal') }, root, emptyCatalog);
    expect(plan.sites).toEqual(['https://portal.example.com']);
    expect(needsConfirmation(plan)).toBe(true);
  });

  it('plans the plugin an app needs from the app\'s own market', async () => {
    writeMarket([{ name: 'contract-review', plugins: ['contract-tools'], run: { team: 'plugin:contract-tools/review' } }], [{ name: 'contract-tools', version: '1.0.0' }]);
    vi.mocked(planInstall).mockResolvedValue(disclosure('contract-tools', ['review']));
    const plan = await planAddApp({ kind: 'market', market: marketRef(), entry: entry('contract-review') }, root, emptyCatalog);
    expect(plan.steps.map((step) => [step.kind, step.entry.name])).toEqual([['install', 'contract-tools']]);
    expect(vi.mocked(planInstall).mock.calls[0][0]).toMatchObject({ prepareSnapshot: true, marketplaceName: 'lawyer-market', home: root });
  });

  it('refuses a plugin that is in no market, and one whose version lacks what the app names', async () => {
    writeMarket([{ name: 'contract-review', plugins: ['contract-tools'], run: { team: 'plugin:contract-tools/review' } }], []);
    await expect(planAddApp({ kind: 'market', market: marketRef(), entry: entry('contract-review') }, root, emptyCatalog)).rejects.toBeInstanceOf(AppAddError);

    writeMarket([{ name: 'contract-review', plugins: ['contract-tools'], run: { team: 'plugin:contract-tools/review' } }], [{ name: 'contract-tools', version: '1.0.0' }]);
    vi.mocked(planInstall).mockResolvedValue(disclosure('contract-tools', ['other']));
    await expect(planAddApp({ kind: 'market', market: marketRef(), entry: entry('contract-review') }, root, emptyCatalog))
      .rejects.toMatchObject({ field: 'home.modes.items[0].scenes[0].run.team' });
    // The snapshot prepared for a plan that was refused is released.
    expect(releasePreparedInstall).toHaveBeenCalledWith('token-contract-tools');
  });

  it('plans an update for an installed plugin whose version does not bring the team, and refuses when the market has nothing newer', async () => {
    writeMarket([{ name: 'contract-review', plugins: ['contract-tools'], run: { team: 'plugin:contract-tools/night' } }], [{ name: 'contract-tools', version: '2.0.0' }]);
    const installedV1 = { key: 'contract-tools@lawyer-market', marketplace: 'lawyer-market', name: 'contract-tools', version: '1.0.0', installedAt: '', contributed: { skills: [], mcpServers: [], agents: [], teams: ['review'] } };
    usePluginStore.setState({ installed: [installedV1] });
    const catalog: RefCatalog = { ...emptyCatalog, plugins: [{ key: installedV1.key, name: 'contract-tools', marketplace: 'lawyer-market', enabled: true, contributed: installedV1.contributed }] };
    vi.mocked(planInstall).mockResolvedValue(disclosure('contract-tools', ['review', 'night']));
    const plan = await planAddApp({ kind: 'market', market: marketRef(), entry: entry('contract-review') }, root, catalog);
    expect(plan.steps.map((step) => [step.kind, step.existingKey])).toEqual([['update', 'contract-tools@lawyer-market']]);

    usePluginStore.setState({ installed: [{ ...installedV1, version: '2.0.0' }] });
    await expect(planAddApp({ kind: 'market', market: marketRef(), entry: entry('contract-review') }, root, catalog)).rejects.toBeInstanceOf(AppAddError);
  });

  it('refuses an app written for a newer Abu', async () => {
    writeMarket([{ name: 'future', run: { team: 'builtin-team:reporting' }, minAbuVersion: '99.0.0' }], []);
    await expect(planAddApp({ kind: 'market', market: marketRef(), entry: entry('future') }, root, emptyCatalog)).rejects.toBeInstanceOf(AppAddError);
  });
});

describe('confirmAddApp', () => {
  it('installs the plugins in order, then adds the app and enters it', async () => {
    writeMarket([{ name: 'contract-review', plugins: ['contract-tools'], run: { team: 'plugin:contract-tools/review' } }], [{ name: 'contract-tools', version: '1.0.0' }]);
    vi.mocked(planInstall).mockResolvedValue(disclosure('contract-tools', ['review']));
    const install = vi.fn().mockResolvedValue(undefined);
    usePluginStore.setState({ install, uninstall: vi.fn() });
    const plan = await planAddApp({ kind: 'market', market: marketRef(), entry: entry('contract-review') }, root, emptyCatalog);
    await confirmAddApp(plan, root, {});
    expect(install).toHaveBeenCalledWith(expect.objectContaining({ preparedToken: 'token-contract-tools', marketplaceName: 'lawyer-market', home: root }));
    expect((await readAddedApps(root)).map((record) => record.appId)).toEqual(['contract-review@lawyer-market']);
    expect(useAppStore.getState().pendingEnterAppId).toBe('contract-review@lawyer-market');
  });

  it('takes back the plugins it installed when a later one fails, and adds nothing', async () => {
    writeMarket(
      [{ name: 'contract-review', plugins: ['contract-tools', 'clause-bank'], run: { team: 'plugin:contract-tools/review' } }],
      [{ name: 'contract-tools', version: '1.0.0' }, { name: 'clause-bank', version: '1.0.0' }],
    );
    // The app names only contract-tools, so only it is planned; a second
    // scene would add clause-bank. Plan both by hand to exercise the order.
    vi.mocked(planInstall).mockResolvedValue(disclosure('contract-tools', ['review']));
    const plan = await planAddApp({ kind: 'market', market: marketRef(), entry: entry('contract-review') }, root, emptyCatalog);
    plan.steps.push({ ...plan.steps[0], entry: { name: 'clause-bank', source: { kind: 'relative', path: './plugins/clause-bank' } }, disclosure: disclosure('clause-bank', []) });
    const install = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('disk full'));
    const uninstall = vi.fn().mockResolvedValue(undefined);
    usePluginStore.setState({ install, uninstall });
    await expect(confirmAddApp(plan, root, {})).rejects.toThrow('disk full');
    expect(uninstall).toHaveBeenCalledWith(root, 'contract-tools@lawyer-market');
    expect(await readAddedApps(root)).toEqual([]);
    expect(releasePreparedInstall).toHaveBeenCalledWith('token-clause-bank');
  });
});
