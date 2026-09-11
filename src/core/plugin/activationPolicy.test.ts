import { beforeEach, describe, expect, it } from 'vitest';
import {
  publishPluginActivation, reconcilePluginActivation, pluginOwnerForAgent,
  isPluginSkillAllowed, isPluginAgentAllowed, isPluginMcpAllowed, assertPluginEnabled,
  type PluginActivation,
} from './activationPolicy';
import type { InstalledPlugin } from './installedStore';

const home = '/home/tester';
const root = `${home}/.abu/plugin-packages/market/demo/1`;
const plugin: InstalledPlugin = {
  key: 'demo@market', name: 'demo', marketplace: 'market', version: '1', installedAt: '2026-09-09T00:00:00Z',
  componentLayoutVersion: 1, skillPaths: ['skills/hello'],
  contributed: { skills: ['hello'], agents: ['reviewer'], mcpServers: ['docs'] },
};
const prefs = { skills: [{ name: 'hello', skillDir: `${root}/skills/hello` }], agents: [{ name: 'reviewer', filePath: `${home}/.abu/agents/reviewer/AGENT.md` }], disabledSkills: [] as string[], disabledAgents: [] as string[], servers: {} as Record<string, { config: { enabled?: boolean } }> };
function snapshot(enabled = false): Record<string, PluginActivation> {
  const state = reconcilePluginActivation({}, [plugin], home, prefs);
  state[plugin.key].enabled = enabled;
  return state;
}
beforeEach(() => publishPluginActivation({}, [], true));
describe('plugin activation policy', () => {
  it('preserves explicit master intent when child preferences change or a version refreshes', () => {
    const previous = snapshot(false);
    const next = reconcilePluginActivation(previous, [{ ...plugin, version: '2' }], home, prefs);
    expect(next[plugin.key].enabled).toBe(false);
    expect(next[plugin.key].root).toContain('/demo/2');
  });
  it('initializes a legacy master switch from existing child preferences', () => {
    const next = reconcilePluginActivation({}, [plugin], home, { ...prefs, disabledSkills: ['hello'], disabledAgents: ['reviewer'] });
    expect(next[plugin.key].enabled).toBe(false);
    expect(reconcilePluginActivation({}, [plugin], home, prefs)[plugin.key].enabled).toBe(true);
  });
  it('migrates legacy directory names using the actual skill name and ownership', () => {
    const legacy = { ...plugin, skillPaths: undefined, componentLayoutVersion: undefined, contributed: { skills: ['folder'], agents: [], mcpServers: [] } };
    const state = reconcilePluginActivation({}, [legacy], home, { ...prefs, skills: [{ name: 'weather', skillDir: `${root}/skills/folder` }], disabledSkills: ['weather'] });
    expect(state[plugin.key].enabled).toBe(false);
    const independent = reconcilePluginActivation({}, [legacy], home, { ...prefs, skills: [{ name: 'weather', skillDir: `${home}/.abu/skills/folder` }], disabledSkills: [] });
    expect(independent[plugin.key].enabled).toBe(false);
  });
  it('retains all deny ownership for duplicate installation keys', () => {
    const other = { ...plugin, contributed: { ...plugin.contributed, agents: ['other-agent'] } };
    const state = reconcilePluginActivation(snapshot(false), [plugin, other], home, prefs);
    publishPluginActivation(state, [], true);
    expect(state[plugin.key].enabled).toBe(false);
    expect(isPluginAgentAllowed({ filePath: `${home}/.abu/agents/reviewer/AGENT.md` })).toBe(false);
    expect(isPluginAgentAllowed({ filePath: `${home}/.abu/agents/other-agent/AGENT.md` })).toBe(false);
  });
  it('blocks only skills inside the disabled plugin package', () => {
    publishPluginActivation(snapshot(), [], true);
    expect(isPluginSkillAllowed({ skillDir: `${root}/skills/hello` })).toBe(false);
    expect(isPluginSkillAllowed({ skillDir: `${home}/.abu/skills/hello` })).toBe(true);
    expect(isPluginSkillAllowed({ skillDir: `${root}-other/skills/hello` })).toBe(false);
  });
  it('never grants an unregistered skill in a package even when its master is on', () => {
    publishPluginActivation(snapshot(true), [], true);
    expect(isPluginSkillAllowed({ skillDir: `${root}/skills/hello` })).toBe(true);
    expect(isPluginSkillAllowed({ skillDir: `${root}/skills/new-sibling` })).toBe(false);
  });
  it('uses the actual agent file, not its name or untrusted source', () => {
    publishPluginActivation(snapshot(), [], true);
    const owned = { name: 'reviewer', filePath: `${home}/.abu/agents/reviewer/AGENT.md` };
    expect(pluginOwnerForAgent(owned)).toBe(plugin.key);
    expect(isPluginAgentAllowed(owned)).toBe(false);
    expect(isPluginAgentAllowed({ ...owned, filePath: '/project/.abu/agents/reviewer/AGENT.md', source: { plugin: plugin.key } })).toBe(true);
    expect(isPluginAgentAllowed({ name: 'reviewer', filePath: '__builtin__' })).toBe(true);
  });
  it('rejects ambiguous ownership regardless of both switches being enabled', () => {
    const a = snapshot(true);
    const b = { ...a[plugin.key], root: '/another', enabled: true };
    publishPluginActivation({ ...a, 'other@market': b }, [], true);
    expect(isPluginMcpAllowed('docs')).toBe(false);
    expect(isPluginAgentAllowed({ name: 'reviewer', filePath: `${home}/.abu/agents/reviewer/AGENT.md` })).toBe(false);
  });
  it('protects legacy known MCP names until installation records can be read', () => {
    publishPluginActivation({}, ['docs'], false);
    expect(isPluginMcpAllowed('docs')).toBe(false);
    expect(isPluginMcpAllowed('user-server')).toBe(true);
  });
  it('retains ownership for a delegated object across uninstall and replacement', () => {
    const held = { filePath: `${home}/.abu/agents/reviewer/AGENT.md` };
    publishPluginActivation(snapshot(true), [], true);
    expect(isPluginAgentAllowed(held)).toBe(true);
    const other = snapshot(true)[plugin.key];
    publishPluginActivation({ ...snapshot(true), 'other@market': { ...other, root: '/other' } }, [], true);
    expect(isPluginAgentAllowed(held)).toBe(false);
    publishPluginActivation({}, [], true);
    expect(isPluginAgentAllowed(held)).toBe(false);
    // A newly discovered independent file is a different object, even at the old path.
    expect(isPluginAgentAllowed({ ...held })).toBe(true);
    const replacement = snapshot(true);
    replacement[plugin.key].root += '-new-version';
    publishPluginActivation(replacement, [], true);
    expect(isPluginAgentAllowed(held)).toBe(false);
    expect(isPluginAgentAllowed({ ...held })).toBe(true);
  });
  it('checks the live master switch for retained identities and rejects removed installations', () => {
    const a = snapshot(true);
    publishPluginActivation(a, [], true);
    expect(() => assertPluginEnabled(plugin.key)).not.toThrow();
    publishPluginActivation(snapshot(false), [], true);
    expect(() => assertPluginEnabled(plugin.key)).toThrow();
    publishPluginActivation({}, [], true);
    expect(() => assertPluginEnabled(plugin.key)).toThrow();
  });
});
