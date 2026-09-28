import { describe, expect, it } from 'vitest';
import type { AppDefinition } from '@/types/app';
import { agentBelongsToApp, appTeamIds, teamBelongsToApp } from './appScope';

const app: AppDefinition = {
  appId: 'shop@market', name: '店铺运营', pluginKey: 'shop@market', pluginVersion: '1.0.0',
  config: {
    version: 1,
    defaultRun: { team: 'store-ops' },
    home: { modes: { items: [{ modeId: 'm', title: 'M', scenes: [
      { id: 'a', title: 'A', run: { team: 'builtin-team:recruiting' }, templates: [] },
      { id: 'b', title: 'B', run: { expert: 'builtin:数据分析师' }, templates: [] },
      { id: 'c', title: 'C', run: { skill: 'product-listing' }, templates: [] },
    ] }] } },
  },
};

describe('app scope', () => {
  it('collects the teams the app hands work to', () => {
    expect([...appTeamIds(app)]).toEqual(['plugin-team:shop@market/store-ops', 'builtin-team:recruiting']);
  });

  it('keeps the plugin\'s own teams and the referenced built-in ones, nothing else', () => {
    expect(teamBelongsToApp(app, 'plugin-team:shop@market/store-ops')).toBe(true);
    expect(teamBelongsToApp(app, 'plugin-team:shop@market/other')).toBe(true);
    expect(teamBelongsToApp(app, 'builtin-team:recruiting')).toBe(true);
    expect(teamBelongsToApp(app, 'builtin-team:software-rd')).toBe(false);
    expect(teamBelongsToApp(app, 'plugin-team:else@market/store-ops')).toBe(false);
    expect(teamBelongsToApp(app, 'team-user')).toBe(false);
  });

  it('keeps the plugin\'s own experts and the referenced built-in ones', () => {
    expect(agentBelongsToApp(app, { name: '店铺客服顾问', source: { kind: 'plugin', plugin: 'shop@market' } })).toBe(true);
    expect(agentBelongsToApp(app, { name: '数据分析师' })).toBe(true);
    expect(agentBelongsToApp(app, { name: '产品经理' })).toBe(false);
    expect(agentBelongsToApp(app, { name: 'reviewer', source: { kind: 'plugin', plugin: 'else@market' } })).toBe(false);
  });
});
