import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SubagentDefinition, SubagentMetadata } from '@/types';

// Discovery metadata — the installed.json-backed authority on plugin ownership.
const discovery: { agents: SubagentMetadata[] } = { agents: [] };
vi.mock('@/stores/discoveryStore', () => ({
  useDiscoveryStore: { getState: () => discovery },
}));

const registry: { agents: SubagentDefinition[] } = { agents: [] };
vi.mock('@/core/agent/registry', () => ({
  agentRegistry: {
    getAgent: (name: string) => registry.agents.find((a) => a.name === name),
    getAvailableAgents: () => registry.agents.map(({ name, description }) => ({ name, description })),
  },
  serializeAgentMd: (meta: Record<string, unknown>, prompt: string) => `---\nrole-id: ${String(meta.roleId)}\n---\n${prompt}`,
}));
const saved: Array<{ name: string; md: string; filePath?: string }> = [];
vi.mock('@/utils/itemStorage', () => ({
  saveItemToAbuDir: async (_dir: string, _file: string, name: string, md: string, filePath?: string) => { saved.push({ name, md, filePath }); return '/saved'; },
}));

import { createRoleId, effectiveRoleId, ensureRoleId, isBuiltinAgent, resolveRoleId } from './roleIdentity';

function def(name: string, extra: Partial<SubagentDefinition> = {}): SubagentDefinition {
  return { name, description: `${name} desc`, systemPrompt: 'p', filePath: `/Users/me/.abu/agents/${name}/AGENT.md`, ...extra } as SubagentDefinition;
}

describe('roleIdentity', () => {
  beforeEach(() => { registry.agents = []; discovery.agents = []; saved.length = 0; });

  it('recognises builtin agents by the in-memory marker or the bundled resource dir', () => {
    expect(isBuiltinAgent({ filePath: '__builtin__' })).toBe(true);
    expect(isBuiltinAgent({ filePath: '/app/Resources/builtin-agents/x/AGENT.md' })).toBe(true);
    expect(isBuiltinAgent({ filePath: '/Users/me/.abu/agents/x/AGENT.md' })).toBe(false);
  });

  it('effectiveRoleId is builtin:<name> for builtins and the stored roleId otherwise', () => {
    expect(effectiveRoleId(def('产品经理', { filePath: '__builtin__' }))).toBe('builtin:产品经理');
    expect(effectiveRoleId(def('a', { roleId: 'role-1' }))).toBe('role-1');
    expect(effectiveRoleId(def('b'))).toBeUndefined();
  });

  it('resolveRoleId finds builtins by name and user agents by roleId', () => {
    registry.agents = [def('产品经理', { filePath: '__builtin__' }), def('a', { roleId: 'role-1' }), def('b')];
    expect(resolveRoleId('builtin:产品经理')?.name).toBe('产品经理');
    expect(resolveRoleId('builtin:a')).toBeNull(); // not a builtin
    expect(resolveRoleId('role-1')?.name).toBe('a');
    expect(resolveRoleId('role-missing')).toBeNull();
  });

  it('ensureRoleId writes a role-id into AGENT.md once and never for builtins', async () => {
    const builtin = await ensureRoleId(def('产品经理', { filePath: '__builtin__' }));
    expect(builtin).toEqual({ roleId: 'builtin:产品经理', wrote: false });
    const existing = await ensureRoleId(def('a', { roleId: 'role-1' }));
    expect(existing).toEqual({ roleId: 'role-1', wrote: false });
    const fresh = await ensureRoleId(def('b'));
    expect(fresh.wrote).toBe(true);
    expect(fresh.roleId).toMatch(/^role-/);
    expect(saved).toHaveLength(1);
    expect(saved[0].md).toContain(`role-id: ${fresh.roleId}`);
    expect(saved[0].filePath).toBe('/Users/me/.abu/agents/b/AGENT.md');
  });

  it('before discovery lists the agent (cold start), the frontmatter source: decides: plugin agents get a name-keyed plugin: id and never a role-id written', async () => {
    // discovery.agents is empty here — nothing has been scanned yet.
    const fromPlugin = def('reviewer', { source: { kind: 'plugin', plugin: 'weather@official' } });
    registry.agents = [fromPlugin, def('reviewer-copy')];
    expect(effectiveRoleId(fromPlugin)).toBe('plugin:reviewer');
    expect(resolveRoleId('plugin:reviewer')?.name).toBe('reviewer');
    // A user agent of the same name is NOT the plugin's agent.
    registry.agents = [def('reviewer')];
    expect(resolveRoleId('plugin:reviewer')).toBeNull();
    const ensured = await ensureRoleId(fromPlugin);
    expect(ensured).toEqual({ roleId: 'plugin:reviewer', wrote: false });
    expect(saved).toHaveLength(0);
  });

  it('discovery metadata makes an agent plugin-owned even when its frontmatter has no source: key', async () => {
    // `source:` in AGENT.md is only a cache — an agent installed before the key
    // existed has none. Discovery backfills it from installed.json; ownership
    // must follow that, or ensureRoleId would write a role-id into the plugin's file.
    const noSource = def('y');
    registry.agents = [noSource];
    discovery.agents = [{ name: 'y', description: 'y desc', source: { kind: 'plugin', plugin: 'x@official' } }];
    expect(effectiveRoleId(noSource)).toBe('plugin:y');
    expect(resolveRoleId('plugin:y')?.name).toBe('y');
    const ensured = await ensureRoleId(noSource);
    expect(ensured).toEqual({ roleId: 'plugin:y', wrote: false });
    expect(saved).toHaveLength(0);
  });

  it('an orphaned frontmatter source: (discovery says no plugin claims it) is a user agent', () => {
    // Plugin uninstalled, AGENT.md left behind in ~/.abu/agents with a stale
    // `source:` key — discovery strips the source, so it is the user's now.
    const orphan = def('z', { roleId: 'role-z', source: { kind: 'plugin', plugin: 'gone@official' } });
    registry.agents = [orphan];
    discovery.agents = [{ name: 'z', description: 'z desc', roleId: 'role-z' }];
    expect(effectiveRoleId(orphan)).toBe('role-z');
    expect(resolveRoleId('plugin:z')).toBeNull();
  });

  it('createRoleId yields distinct role- ids', () => {
    const a = createRoleId(); const b = createRoleId();
    expect(a).toMatch(/^role-/);
    expect(a).not.toBe(b);
  });
});
