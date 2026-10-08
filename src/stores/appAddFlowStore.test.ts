import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { homeDir } from '@tauri-apps/api/path';
import { copyFile, exists, lstat, mkdir, readDir, readFile, readTextFile, remove, rename, writeFile } from '@tauri-apps/plugin-fs';
import type { InstallDisclosure } from '@/core/plugin/installer';
import { planInstall, releasePreparedInstall } from '@/core/plugin/installer';
import { readAddedApps } from '@/core/app/appRecords';
import type { AppDefinition } from '@/types/app';
import { usePluginStore } from './pluginStore';
import { useAppStore } from './appStore';
import { useAppAddFlowStore } from './appAddFlowStore';

// The plugin installer is its own subject: here it only has to be asked for
// the right plugin and have its prepared snapshots released.
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
vi.mock('@/core/app/appSync', () => ({ refreshAddedApps: vi.fn().mockResolvedValue(undefined) }));

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

/** One app in a market folder; `plugin` makes its scene run a team that plugin brings. */
function writeApp(name: string, options: { plugin?: string; site?: string; minAbuVersion?: string } = {}) {
  mkdirSync(join(market, '.abu-plugin'), { recursive: true });
  writeFileSync(join(market, '.abu-plugin', 'marketplace.json'), JSON.stringify({
    name: 'lawyer-market',
    plugins: options.plugin ? [{ name: options.plugin, version: '1.0.0', source: `./plugins/${options.plugin}` }] : [],
    apps: [{ name, source: `./apps/${name}` }],
  }));
  const dir = join(market, 'apps', name, '.abu-app');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'app.json'), JSON.stringify({
    name, version: '1.0.0', minAbuVersion: options.minAbuVersion ?? '0.51.0',
    interface: { displayName: '合同审阅', shortDescription: '审合同' },
    plugins: options.plugin ? [options.plugin] : [],
    ...(options.site ? { allowedOrigins: [options.site], nav: { items: [{ id: 'chat', target: 'builtin:chat' }, { id: 'p', title: 'P', target: `url:${options.site}/x` }] } } : {}),
    home: { modes: { items: [{ modeId: 'm', title: 'M', scenes: [{ id: 's', title: 'S', run: { team: options.plugin ? `plugin:${options.plugin}/review` : 'builtin-team:reporting' }, templates }] }] } },
  }));
}

function disclosure(name: string): InstallDisclosure {
  return {
    key: `${name}@lawyer-market`, name, marketplace: 'lawyer-market', version: '1.0.0', manifest: { name }, sourceDir: `/m/${name}`,
    skills: [], mcpServers: [], agents: [], teams: [{ id: 'review', name: 'review', leaderRoleId: 'l', memberRoleIds: ['l'], requirePlanApproval: false, description: 'review', expertise: [], samplePrompts: [] }],
    ignoredPayloads: [], preparedToken: `token-${name}`,
  } as InstallDisclosure;
}

const source = (name: string) => ({ kind: 'market' as const, market: { name: 'lawyer-market', dir: market }, entry: { name, source: { kind: 'relative' as const, path: `./apps/${name}` } } });
const flow = () => useAppAddFlowStore.getState().flow;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'abu-app-add-flow-'));
  market = join(root, 'market');
  useRealTree();
  vi.mocked(homeDir).mockResolvedValue(root);
  vi.mocked(planInstall).mockReset();
  vi.mocked(releasePreparedInstall).mockClear();
  usePluginStore.setState({ marketplaces: [{ name: 'lawyer-market', dir: market }], installed: [], install: vi.fn().mockResolvedValue(undefined), uninstall: vi.fn().mockResolvedValue(undefined) });
  useAppStore.setState({ addedApps: [], managedApps: {}, pendingEnterAppId: null });
  useAppAddFlowStore.setState({ flow: { kind: 'closed' }, running: false });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('appAddFlowStore', () => {
  describe('start', () => {
    it('adds an app that needs nothing installed and opens no websites without asking', async () => {
      writeApp('weekly');
      await useAppAddFlowStore.getState().start(source('weekly'), '周报', 'add');
      expect(flow()).toEqual({ kind: 'closed' });
      expect((await readAddedApps(root)).map((record) => record.appId)).toEqual(['weekly@lawyer-market']);
      expect(useAppStore.getState().pendingEnterAppId).toBe('weekly@lawyer-market');
    });

    it('waits for 确认 when the app opens a website, then adds it', async () => {
      writeApp('portal', { site: 'https://portal.example.com' });
      await useAppAddFlowStore.getState().start(source('portal'), '门户', 'add');
      const current = flow();
      expect(current.kind).toBe('ready');
      expect(current.kind === 'ready' && current.plan.sites).toEqual(['https://portal.example.com']);
      expect(await readAddedApps(root)).toEqual([]);

      await useAppAddFlowStore.getState().confirm({});
      expect(flow()).toEqual({ kind: 'closed' });
      expect((await readAddedApps(root)).map((record) => record.appId)).toEqual(['portal@lawyer-market']);
      expect(useAppAddFlowStore.getState().running).toBe(false);
    });

    it('always shows a preview first when adding from a folder', async () => {
      writeApp('weekly');
      await useAppAddFlowStore.getState().start(source('weekly'), '周报', 'preview');
      expect(flow()).toMatchObject({ kind: 'ready', purpose: 'preview' });
      expect(await readAddedApps(root)).toEqual([]);
    });

    it('shows why an app cannot be added', async () => {
      writeApp('future', { minAbuVersion: '99.0.0' });
      await useAppAddFlowStore.getState().start(source('future'), '未来', 'add');
      const current = flow();
      expect(current).toMatchObject({ kind: 'error', name: '未来' });
      expect(current.kind === 'error' ? current.message : '').toMatch(/99\.0\.0/);
    });

    it('releases what it prepared when the user cancelled while planning', async () => {
      writeApp('contract-review', { plugin: 'contract-tools' });
      vi.mocked(planInstall).mockImplementation(async () => {
        await useAppAddFlowStore.getState().cancel();
        return disclosure('contract-tools');
      });
      await useAppAddFlowStore.getState().start(source('contract-review'), '合同审阅', 'add');
      expect(flow()).toEqual({ kind: 'closed' });
      expect(releasePreparedInstall).toHaveBeenCalledWith('token-contract-tools');
      expect(usePluginStore.getState().install).not.toHaveBeenCalled();
    });
  });

  describe('confirm and cancel', () => {
    it('installs the plugin the app needs, adds the app, and ignores a second click while running', async () => {
      writeApp('contract-review', { plugin: 'contract-tools' });
      vi.mocked(planInstall).mockResolvedValue(disclosure('contract-tools'));
      await useAppAddFlowStore.getState().start(source('contract-review'), '合同审阅', 'add');
      expect(flow()).toMatchObject({ kind: 'ready' });

      const first = useAppAddFlowStore.getState().confirm({});
      const second = useAppAddFlowStore.getState().confirm({});
      await Promise.all([first, second]);
      expect(usePluginStore.getState().install).toHaveBeenCalledTimes(1);
      expect((await readAddedApps(root)).map((record) => record.appId)).toEqual(['contract-review@lawyer-market']);
    });

    it('names the app when installing its plugin fails, and adds nothing', async () => {
      writeApp('contract-review', { plugin: 'contract-tools' });
      vi.mocked(planInstall).mockResolvedValue(disclosure('contract-tools'));
      usePluginStore.setState({ install: vi.fn().mockRejectedValue(new Error('disk full')) });
      await useAppAddFlowStore.getState().start(source('contract-review'), '合同审阅', 'add');
      await useAppAddFlowStore.getState().confirm({});
      expect(flow()).toEqual({ kind: 'error', name: '合同审阅', message: 'disk full' });
      expect(await readAddedApps(root)).toEqual([]);
    });

    it('cancelling releases the prepared plugin and writes nothing', async () => {
      writeApp('contract-review', { plugin: 'contract-tools' });
      vi.mocked(planInstall).mockResolvedValue(disclosure('contract-tools'));
      await useAppAddFlowStore.getState().start(source('contract-review'), '合同审阅', 'add');
      await useAppAddFlowStore.getState().cancel();
      expect(flow()).toEqual({ kind: 'closed' });
      expect(releasePreparedInstall).toHaveBeenCalledWith('token-contract-tools');
      expect(await readAddedApps(root)).toEqual([]);
    });
  });

  describe('repair', () => {
    const app = (plugin?: string): AppDefinition => ({
      appId: 'contract-review@lawyer-market', name: '合同审阅', version: '1.0.0', origin: { kind: 'market', market: 'lawyer-market' },
      plugins: plugin ? [plugin] : [],
      config: { home: { modes: { items: [{ modeId: 'm', title: 'M', scenes: [{ id: 's', title: 'S', run: { team: plugin ? `plugin:${plugin}/review` : 'builtin-team:reporting' }, templates }] }] } } },
    } as AppDefinition);

    it('starts what the user clicked right away when nothing is missing', async () => {
      const resume = vi.fn();
      await useAppAddFlowStore.getState().repair(app(), resume);
      expect(resume).toHaveBeenCalledTimes(1);
      expect(flow()).toEqual({ kind: 'closed' });
    });

    it('reinstalls the plugin a scene needs, then starts what the user clicked', async () => {
      writeApp('contract-review', { plugin: 'contract-tools' });
      vi.mocked(planInstall).mockResolvedValue(disclosure('contract-tools'));
      const resume = vi.fn();
      await useAppAddFlowStore.getState().repair(app('contract-tools'), resume);
      expect(flow()).toMatchObject({ kind: 'repair' });
      expect(resume).not.toHaveBeenCalled();

      await useAppAddFlowStore.getState().confirm({});
      expect(usePluginStore.getState().install).toHaveBeenCalledWith(expect.objectContaining({ preparedToken: 'token-contract-tools' }));
      expect(resume).toHaveBeenCalledTimes(1);
      expect(flow()).toEqual({ kind: 'closed' });
    });

    it('shows why the plugin cannot be found, and starts nothing', async () => {
      const resume = vi.fn();
      await useAppAddFlowStore.getState().repair(app('missing-tools'), resume);
      expect(flow()).toMatchObject({ kind: 'error', name: '合同审阅' });
      expect(resume).not.toHaveBeenCalled();
    });

    it('cancelling a repair releases the prepared plugin and starts nothing', async () => {
      writeApp('contract-review', { plugin: 'contract-tools' });
      vi.mocked(planInstall).mockResolvedValue(disclosure('contract-tools'));
      const resume = vi.fn();
      await useAppAddFlowStore.getState().repair(app('contract-tools'), resume);
      await useAppAddFlowStore.getState().cancel();
      expect(releasePreparedInstall).toHaveBeenCalledWith('token-contract-tools');
      expect(resume).not.toHaveBeenCalled();
    });
  });
});
