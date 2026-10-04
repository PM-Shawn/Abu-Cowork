import { describe, expect, it, vi } from 'vitest';
import type { InstalledPlugin } from '@/core/plugin/installedStore';
import type { PluginActivations } from '@/core/plugin/activationPolicy';
import { isPluginTeam, loadPluginTeams, parsePluginTeamId, pluginTeamId, toTeam } from './pluginTeams';

const plugin: InstalledPlugin = {
  key: 'shop@market', marketplace: 'market', name: 'shop', version: '1.0.0', installedAt: '2026-09-18T00:00:00.000Z',
  contributed: { skills: [], mcpServers: [], agents: ['advisor'], teams: ['store-ops'] },
};
const activation = (enabled: boolean, conflicted = false): PluginActivations => ({
  'shop@market': { enabled, conflicted, root: '/home/u/.abu/plugin-packages/market/shop/1.0.0', skillDirs: [], legacySkills: false, agentFiles: [], mcpServers: [] },
});
const teamFile = JSON.stringify({
  name: { 'zh-CN': '店铺运营小组', 'en-US': 'Shop ops' },
  description: '运营顾问带队',
  leader: 'advisor',
  members: ['advisor', 'builtin:数据分析师'],
  avatar: 'icon:compass/coral',
  expertise: ['选品', { 'en-US': 'Pricing' }],
});
const readText = async (path: string) => {
  if (path === '/home/u/.abu/plugin-packages/market/shop/1.0.0/teams/store-ops.json') return teamFile;
  throw new Error(`unexpected read ${path}`);
};

describe('plugin team ids', () => {
  it('round-trip the plugin key and team id, keys containing slashes included', () => {
    const id = pluginTeamId('@scope/shop@market', 'store-ops');
    expect(isPluginTeam({ id })).toBe(true);
    expect(parsePluginTeamId(id)).toEqual({ pluginKey: '@scope/shop@market', teamId: 'store-ops' });
    expect(parsePluginTeamId('builtin-team:recruiting')).toBeNull();
    expect(parsePluginTeamId('plugin-team:shop@market/')).toBeNull();
  });
});

describe('loadPluginTeams', () => {
  it('reads the recorded team files of enabled plugins and resolves text for the locale', async () => {
    const teams = await loadPluginTeams([plugin], activation(true), 'en-US', readText);
    expect(teams).toEqual([{
      id: 'plugin-team:shop@market/store-ops',
      name: 'Shop ops',
      leaderRoleId: 'plugin:advisor',
      memberRoleIds: ['plugin:advisor', 'builtin:数据分析师'],
      leaderNote: undefined,
      requirePlanApproval: undefined,
      avatar: 'icon:compass/coral',
      description: '运营顾问带队',
      intro: undefined,
      expertise: ['选品', 'Pricing'],
      samplePrompts: undefined,
      createdAt: 0,
    }]);
    expect((await loadPluginTeams([plugin], activation(true), 'zh-CN', readText))[0].name).toBe('店铺运营小组');
  });

  it('skips disabled, conflicted, unpublished and team-less plugins without reading anything', async () => {
    const refuse = async (path: string): Promise<string> => { throw new Error(`must not read ${path}`); };
    expect(await loadPluginTeams([plugin], activation(false), 'zh-CN', refuse)).toEqual([]);
    expect(await loadPluginTeams([plugin], activation(true, true), 'zh-CN', refuse)).toEqual([]);
    expect(await loadPluginTeams([plugin], {}, 'zh-CN', refuse)).toEqual([]);
    expect(await loadPluginTeams([{ ...plugin, contributed: { ...plugin.contributed, teams: [] } }], activation(true), 'zh-CN', refuse)).toEqual([]);
  });

  it('drops only the team file that no longer validates, and reports why', async () => {
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const two = { ...plugin, contributed: { ...plugin.contributed, teams: ['ghost-team', 'store-ops'] } };
      const readOne = async (path: string) => {
        if (path.endsWith('ghost-team.json')) return JSON.stringify({ name: 'x', description: 'y', leader: 'ghost', members: ['ghost', 'builtin:数据分析师'] });
        return readText(path);
      };
      const teams = await loadPluginTeams([two], activation(true), 'zh-CN', readOne);
      expect(teams.map((team) => team.id)).toEqual(['plugin-team:shop@market/store-ops']);
      expect(reported.mock.calls[0]?.[1]).toMatchObject({ field: 'teams.ghost-team.members[0]' });
    } finally { reported.mockRestore(); }
  });

  it('keeps the other plugins\' teams when one package\'s files are gone', async () => {
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const removed: InstalledPlugin = { ...plugin, key: 'gone@market', name: 'gone' };
      const activations: PluginActivations = {
        ...activation(true),
        'gone@market': { enabled: true, conflicted: false, root: '/home/u/.abu/plugin-packages/market/gone/1.0.0', skillDirs: [], legacySkills: false, agentFiles: [], mcpServers: [] },
      };
      const teams = await loadPluginTeams([removed, plugin], activations, 'zh-CN', readText);
      expect(teams.map((team) => team.id)).toEqual(['plugin-team:shop@market/store-ops']);
    } finally { reported.mockRestore(); }
  });

  it('maps empty optional lists to undefined so the card falls back like a user team', () => {
    const team = toTeam({ id: 't', name: 'n', leaderRoleId: 'plugin:a', memberRoleIds: ['plugin:a', 'builtin:b'], requirePlanApproval: true, description: 'd', expertise: [], samplePrompts: [] }, 'p@m', 'zh-CN');
    expect(team.expertise).toBeUndefined();
    expect(team.samplePrompts).toBeUndefined();
    expect(team.requirePlanApproval).toBe(true);
  });
});
