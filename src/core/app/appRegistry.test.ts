import { describe, expect, it, vi } from 'vitest';
import type { InstalledPlugin } from '@/core/plugin/installedStore';
import type { PluginActivations } from '@/core/plugin/activationPolicy';
import { GENERAL_APP_ID } from '@/types/app';
import { appHomeTitle, generalApp, getApp, listApps, loadInstalledApps, registerAppSource, type PackageFiles } from './appRegistry';

const plugin: InstalledPlugin = {
  key: 'shop@market', marketplace: 'market', name: 'shop', version: '1.0.0', installedAt: '2026-09-18T00:00:00.000Z',
  contributed: { skills: ['product-listing'], mcpServers: ['shop-api'], agents: ['店铺客服顾问'], teams: ['store-ops'] },
};
const root = '/home/u/.abu/plugin-packages/market/shop/1.0.0';
const activation = (enabled: boolean): PluginActivations => ({
  'shop@market': { enabled, conflicted: false, root, skillDirs: [], legacySkills: false, agentFiles: [], mcpServers: [] },
});
const manifest = {
  name: 'shop', version: '1.0.0', minAbuVersion: '0.51.0',
  interface: { displayName: '店铺运营', shortDescription: '一句话', logo: 'assets/logo.png', logoDark: 'assets/logo-dark.png' },
  app: {
    version: 1,
    defaultRun: { team: 'store-ops' },
    requiredConnectors: ['shop-api'],
    home: { header: { title: { 'zh-CN': '店铺运营中心', 'en-US': 'Shop ops' } }, modes: { items: [{ modeId: 'm', title: 'M', scenes: [
      { id: 's', title: 'S', run: { skill: 'product-listing' }, templates: [{ id: 'a', title: 'A', prompt: 'A' }, { id: 'b', title: 'B', prompt: 'B' }, { id: 'c', title: 'C', prompt: 'C' }] },
    ] }] } },
  },
};
function files(entries: Record<string, unknown>): PackageFiles {
  return {
    exists: async (path) => path in entries,
    readText: async (path) => { if (!(path in entries)) throw new Error(`ENOENT ${path}`); return JSON.stringify(entries[path]); },
  };
}

describe('loadInstalledApps', () => {
  it('reads the app of an enabled plugin from its installed manifest and resolves assets against the package', async () => {
    const apps = await loadInstalledApps([plugin], activation(true), files({ [`${root}/.abu-plugin/plugin.json`]: manifest }));
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({
      appId: 'shop@market', name: '店铺运营', description: '一句话', pluginKey: 'shop@market', pluginVersion: '1.0.0',
      logo: `${root}/assets/logo.png`, logoDark: `${root}/assets/logo-dark.png`,
    });
    expect(apps[0].config.defaultRun).toEqual({ team: 'store-ops' });
    expect(appHomeTitle(apps[0], 'en-US')).toBe('Shop ops');
    expect(appHomeTitle({ ...apps[0], config: { ...apps[0].config, home: { modes: apps[0].config.home.modes } } }, 'en-US')).toBe('店铺运营');
  });

  it('skips disabled plugins, plugins without app, and falls through the manifest candidates', async () => {
    expect(await loadInstalledApps([plugin], activation(false), files({ [`${root}/.abu-plugin/plugin.json`]: manifest }))).toEqual([]);
    expect(await loadInstalledApps([plugin], {}, files({ [`${root}/.abu-plugin/plugin.json`]: manifest }))).toEqual([]);
    expect(await loadInstalledApps([plugin], activation(true), files({ [`${root}/.abu-plugin/plugin.json`]: { name: 'shop' } }))).toEqual([]);
    const viaClaude = await loadInstalledApps([plugin], activation(true), files({ [`${root}/.claude-plugin/plugin.json`]: manifest }));
    expect(viaClaude.map((app) => app.appId)).toEqual(['shop@market']);
  });

  it('re-validates the app against what the install record credits the plugin with, and leaves the rest of the list standing', async () => {
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const edited = { ...manifest, app: { ...manifest.app, defaultRun: { team: 'injected-team' } } };
      const other: InstalledPlugin = { ...plugin, key: 'other@market', name: 'other' };
      const otherRoot = '/home/u/.abu/plugin-packages/market/other/1.0.0';
      const activations: PluginActivations = {
        ...activation(true),
        'other@market': { enabled: true, conflicted: false, root: otherRoot, skillDirs: [], legacySkills: false, agentFiles: [], mcpServers: [] },
      };
      const apps = await loadInstalledApps([plugin, other], activations, files({
        [`${root}/.abu-plugin/plugin.json`]: edited,
        [`${otherRoot}/.abu-plugin/plugin.json`]: manifest,
      }));
      // The edited package loses its own entry; the healthy one keeps its place
      // in the switcher, and the refusal is reported rather than hidden.
      expect(apps.map((app) => app.appId)).toEqual(['other@market']);
      expect(String(reported.mock.calls[0]?.[0])).toContain('shop@market');
      expect(reported.mock.calls[0]?.[1]).toMatchObject({ field: 'app.defaultRun.team' });
    } finally { reported.mockRestore(); }
  });

  it('lets requiredConnectors name a connector the install skipped, since the hint is all it drives', async () => {
    // The record credits only the servers the install created: a name the user
    // already had is left out of it so uninstall never deletes the user's own.
    const shared = { ...plugin, contributed: { ...plugin.contributed, mcpServers: [] } };
    const withServer = { ...manifest, mcpServers: { 'shop-api': { url: 'https://shop.example.com/mcp' } } };
    const apps = await loadInstalledApps([shared], activation(true), files({ [`${root}/.abu-plugin/plugin.json`]: withServer }));
    expect(apps[0].config.requiredConnectors).toEqual(['shop-api']);
  });
});

describe('listApps', () => {
  it('puts the general shell first, then installed apps, then registered sources', async () => {
    const [installed] = await loadInstalledApps([plugin], activation(true), files({ [`${root}/.abu-plugin/plugin.json`]: manifest }));
    const extra = { ...installed, appId: 'org-app', pluginKey: 'org@enterprise' };
    const unregister = registerAppSource(() => [extra]);
    try {
      const apps = listApps([installed], 'zh-CN');
      expect(apps.map((app) => app.appId)).toEqual([GENERAL_APP_ID, 'shop@market', 'org-app']);
      expect(apps[0].name).toBe(generalApp('zh-CN').name);
      expect(getApp(apps, 'org-app')).toBe(extra);
    } finally { unregister(); }
    expect(listApps([], 'en-US').map((app) => app.appId)).toEqual([GENERAL_APP_ID]);
    expect(generalApp('en-US').name).toBe('General');
  });
});
