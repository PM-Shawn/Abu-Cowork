import { describe, expect, it } from 'vitest';
import type { AppDefinition } from '@/types/app';
import type { SubagentDefinition } from '@/types';
import type { Team } from '@/stores/teamStore';
import { appMembers, appsUsing } from './appScope';
import type { RefCatalog } from './appRefs';

const team = (id: string): Team => ({ id, name: id, leaderRoleId: 'l', memberRoleIds: ['l'], createdAt: 0 });
const agent = (name: string, extra: Partial<SubagentDefinition> = {}) => ({ name, description: name, filePath: `/a/${name}/AGENT.md`, systemPrompt: 'x', ...extra }) as SubagentDefinition;

const catalog: RefCatalog = {
  plugins: [{ key: 'shop-assistant@market', name: 'shop-assistant', marketplace: 'market', enabled: true, contributed: { skills: ['product-listing'], agents: ['店铺客服顾问'], teams: ['store-ops', 'night-shift'], mcpServers: [] } }],
  teams: [team('builtin-team:recruiting'), team('builtin-team:software-rd'), team('plugin-team:shop-assistant@market/store-ops'), team('plugin-team:shop-assistant@market/night-shift'), team('team-mine')],
  getAgent: (name) => ({ 数据分析师: agent('数据分析师', { filePath: '__builtin__' }), 店铺客服顾问: agent('店铺客服顾问', { source: { kind: 'plugin', plugin: 'shop-assistant@market' } }), 周报助手: agent('周报助手') } as Record<string, SubagentDefinition>)[name],
  findManagedAgent: () => undefined,
  skillNames: new Set(['product-listing']),
};

const app: AppDefinition = {
  appId: 'shop-ops@market', name: '店铺运营', version: '1.0.0', origin: { kind: 'market', market: 'market' }, plugins: ['shop-assistant'],
  config: {
    version: 1,
    defaultRun: { team: 'plugin:shop-assistant/store-ops' },
    home: { modes: { items: [{ modeId: 'm', title: 'M', scenes: [
      { id: 'a', title: 'A', run: { team: 'builtin-team:recruiting' }, templates: [] },
      { id: 'b', title: 'B', run: { expert: 'builtin:数据分析师' }, templates: [] },
      { id: 'c', title: 'C', run: { skill: 'plugin:shop-assistant/product-listing' }, templates: [] },
    ] }] } },
  },
};

describe('appMembers', () => {
  it('holds exactly the teams and experts the app names', () => {
    const members = appMembers(app, catalog);
    expect([...members.teamIds]).toEqual(['plugin-team:shop-assistant@market/store-ops', 'builtin-team:recruiting']);
    expect([...members.agentNames]).toEqual(['数据分析师']);
    // A team the plugin ships but no scene names is not the app's.
    expect(members.teamIds.has('plugin-team:shop-assistant@market/night-shift')).toBe(false);
  });
});

describe('appsUsing', () => {
  const weekly: AppDefinition = {
    ...app, appId: 'weekly@mine', origin: { kind: 'created', authoringId: 'a' }, plugins: [],
    config: { ...app.config, defaultRun: { expert: 'mine:周报助手' }, home: { modes: { items: [{ modeId: 'm', title: 'M', scenes: [{ id: 's', title: 'S', run: { team: 'mine:team-mine' }, templates: [] }] }] } } },
  };

  it('finds the apps that name a plugin, or the user\'s own expert or team', () => {
    expect(appsUsing([app, weekly], { kind: 'plugin', name: 'shop-assistant' }).map((item) => item.appId)).toEqual(['shop-ops@market']);
    expect(appsUsing([app, weekly], { kind: 'expert', name: '周报助手' }).map((item) => item.appId)).toEqual(['weekly@mine']);
    expect(appsUsing([app, weekly], { kind: 'team', id: 'team-mine' }).map((item) => item.appId)).toEqual(['weekly@mine']);
    // A built-in of the same name is not the user's own.
    expect(appsUsing([app, weekly], { kind: 'expert', name: '数据分析师' })).toEqual([]);
  });
});
