import { describe, expect, it } from 'vitest';
import type { AppDefinition, AppRunRef } from '@/types/app';
import type { SubagentDefinition } from '@/types';
import type { Team } from '@/stores/teamStore';
import { DEFAULT_APP_CONFIG } from '@/data/defaultAppConfig';
import { resolveAppRefs, resolveRun, type RefCatalog } from './appRefs';

const agent = (name: string, extra: Partial<SubagentDefinition> = {}): SubagentDefinition => ({
  name, description: name, filePath: `/home/u/.abu/agents/${name}/AGENT.md`, systemPrompt: 'x', ...extra,
} as SubagentDefinition);
const team = (id: string, extra: Partial<Team> = {}): Team => ({ id, name: id, leaderRoleId: 'l', memberRoleIds: ['l'], createdAt: 0, ...extra });

const builtinExpert = agent('产品经理', { filePath: '__builtin__' });
const pluginExpert = agent('店铺客服顾问', { source: { kind: 'plugin', plugin: 'shop-assistant@market' } });
const myExpert = agent('周报助手');
const orgReady = agent('合同审阅员', { roleId: 'enterprise-agent:a1', managed: { source: 'enterprise', id: 'a1', version: '1', readOnly: true, ready: true } } as Partial<SubagentDefinition>);
const orgUnready = agent('条款专家', { roleId: 'enterprise-agent:a2', managed: { source: 'enterprise', id: 'a2', version: '1', readOnly: true, ready: false } } as Partial<SubagentDefinition>);

function catalog(overrides: Partial<RefCatalog> = {}): RefCatalog {
  const agents = new Map([builtinExpert, pluginExpert, myExpert].map((item) => [item.name, item]));
  return {
    plugins: [{ key: 'shop-assistant@market', name: 'shop-assistant', marketplace: 'market', enabled: true, contributed: { skills: ['product-listing'], agents: ['店铺客服顾问'], teams: ['store-ops'], mcpServers: ['shop-api'] } }],
    teams: [
      team('builtin-team:recruiting'),
      team('plugin-team:shop-assistant@market/store-ops'),
      team('team-mine-1'),
      team('t-org-1', { managed: { source: 'enterprise', id: 't-org-1', version: '1', readOnly: true, ready: true }, memberRoleIds: ['enterprise-agent:a1', 'enterprise-agent:a2'] }),
    ],
    getAgent: (name) => agents.get(name),
    findManagedAgent: (roleId) => [orgReady, orgUnready].find((item) => item.roleId === roleId),
    skillNames: new Set(['product-listing', 'clause-check', 'weekly-report']),
    enterpriseSkillNames: new Set(['clause-check']),
    ...overrides,
  };
}

const app = (origin: AppDefinition['origin'] = { kind: 'market', market: 'market' }): AppDefinition => ({
  appId: 'shop-ops@market', name: '店铺运营', config: DEFAULT_APP_CONFIG, version: '1.0.0', origin, plugins: ['shop-assistant'],
});
const run = (ref: AppRunRef, from = app(), cat = catalog()) => resolveRun(from, ref, cat);

describe('resolveRun', () => {
  it('finds built-in, plugin and the user\'s own teams and experts', () => {
    expect(run({ team: 'builtin-team:recruiting' }).owner).toMatchObject({ status: 'ok', kind: 'team', team: { id: 'builtin-team:recruiting' } });
    expect(run({ expert: 'builtin:产品经理' }).owner).toMatchObject({ status: 'ok', kind: 'expert', agent: { name: '产品经理' } });
    expect(run({ team: 'plugin:shop-assistant/store-ops' }).owner).toMatchObject({ status: 'ok', team: { id: 'plugin-team:shop-assistant@market/store-ops' } });
    expect(run({ expert: 'plugin:shop-assistant/店铺客服顾问' }).owner).toMatchObject({ status: 'ok', agent: { name: '店铺客服顾问' } });
    expect(run({ skill: 'plugin:shop-assistant/product-listing' }).skill).toEqual({ status: 'ok', kind: 'skill', name: 'product-listing' });
    const created = app({ kind: 'created', authoringId: 'a' });
    expect(run({ expert: 'mine:周报助手' }, created).owner).toMatchObject({ status: 'ok', agent: { name: '周报助手' } });
    expect(run({ team: 'mine:team-mine-1' }, created).owner).toMatchObject({ status: 'ok', team: { id: 'team-mine-1' } });
  });

  it('resolves a team or expert together with the skill it starts with', () => {
    const resolved = run({ team: 'plugin:shop-assistant/store-ops', skill: 'plugin:shop-assistant/product-listing' });
    expect(resolved.owner).toMatchObject({ status: 'ok', kind: 'team' });
    expect(resolved.skill).toMatchObject({ status: 'ok', name: 'product-listing' });
  });

  it('asks for the plugin when it is not installed, or its version does not bring the reference', () => {
    expect(run({ team: 'plugin:shop-assistant/store-ops' }, app(), catalog({ plugins: [] })).owner).toEqual({ status: 'needs-plugin', plugin: 'shop-assistant', reason: 'missing' });
    expect(run({ team: 'plugin:shop-assistant/night-shift' }).owner).toEqual({ status: 'needs-plugin', plugin: 'shop-assistant', reason: 'outdated' });
  });

  it('calls a reference unavailable when nothing can bring it back', () => {
    const disabled = catalog({ plugins: catalog().plugins.map((plugin) => ({ ...plugin, enabled: false })) });
    expect(run({ team: 'plugin:shop-assistant/store-ops' }, app(), disabled).owner).toEqual({ status: 'unavailable', label: 'store-ops' });
    const created = app({ kind: 'created', authoringId: 'a' });
    expect(run({ expert: 'mine:已删除的专家' }, created).owner).toEqual({ status: 'unavailable', label: '已删除的专家' });
    // `mine:` names the user's own; a built-in of the same name is not it.
    expect(run({ expert: 'mine:产品经理' }, created).owner).toEqual({ status: 'unavailable', label: '产品经理' });
    expect(run({ team: 'mine:builtin-team:recruiting' }, created).owner).toMatchObject({ status: 'unavailable' });
  });

  it('prefers the plugin from the app\'s own market when two markets have one of that name', () => {
    const two = catalog({
      plugins: [
        { key: 'shop-assistant@other', name: 'shop-assistant', marketplace: 'other', enabled: true, contributed: { skills: [], agents: [], teams: ['store-ops'], mcpServers: [] } },
        ...catalog().plugins,
      ],
      teams: [team('plugin-team:shop-assistant@other/store-ops'), team('plugin-team:shop-assistant@market/store-ops')],
    });
    expect(run({ team: 'plugin:shop-assistant/store-ops' }, app(), two).owner).toMatchObject({ team: { id: 'plugin-team:shop-assistant@market/store-ops' } });
  });

  it('asks to prepare organization experts that are not set up yet', () => {
    const org = app({ kind: 'enterprise' });
    expect(run({ expert: 'enterprise-agent:a1' }, org).owner).toMatchObject({ status: 'ok', agent: { name: '合同审阅员' } });
    expect(run({ expert: 'enterprise-agent:a2' }, org).owner).toEqual({ status: 'needs-preparation', roleIds: ['enterprise-agent:a2'], label: '条款专家' });
    expect(run({ team: 'enterprise-team:t-org-1' }, org).owner).toEqual({ status: 'needs-preparation', roleIds: ['enterprise-agent:a2'], label: 't-org-1' });
    expect(run({ expert: 'enterprise-agent:gone' }, org).owner).toEqual({ status: 'unavailable', label: 'gone' });
    expect(run({ skill: 'enterprise:clause-check' }, org).skill).toMatchObject({ status: 'ok', name: 'clause-check' });
  });

  it('finds an organization skill only among the organization\'s skills, never a same-named one of the user', () => {
    const org = app({ kind: 'enterprise' });
    expect(run({ skill: 'enterprise:weekly-report' }, org).skill).toEqual({ status: 'unavailable', label: 'weekly-report' });
  });
});

describe('resolveAppRefs', () => {
  it('lists every run and the plugins to install or update', () => {
    const withRuns: AppDefinition = {
      ...app(),
      config: {
        ...DEFAULT_APP_CONFIG,
        defaultRun: { team: 'plugin:shop-assistant/night-shift' },
        home: { modes: { items: [{ modeId: 'm', title: 'M', scenes: [
          { id: 'a', title: 'A', run: { expert: 'plugin:tools/helper' }, templates: [] },
          { id: 'b', title: 'B', run: { team: 'builtin-team:recruiting' }, templates: [] },
        ] }] } },
      },
    };
    const report = resolveAppRefs(withRuns, catalog());
    expect(report.runs.map((entry) => entry.field)).toEqual(['defaultRun', 'home.modes.items[0].scenes[0].run', 'home.modes.items[0].scenes[1].run']);
    expect(report.missingPlugins).toEqual(['tools']);
    expect(report.outdatedPlugins).toEqual(['shop-assistant']);
  });
});
