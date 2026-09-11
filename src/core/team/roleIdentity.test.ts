import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SubagentDefinition } from '@/types';

// Activation records — the persisted, fail-closed ownership the execution gate
// uses. `owner`: a key = plugin-owned, null = conflicting claims, undefined =
// independent / unknown. `ready`: whether records have been read from disk.
const activation: { owners: Record<string, string | null | undefined>; ready: boolean } = { owners: {}, ready: true };
vi.mock('@/core/plugin/activationPolicy', () => ({
  pluginOwnerForAgent: (agent: { filePath: string }) => activation.owners[agent.filePath],
  pluginActivationRecordsReady: () => activation.ready,
}));

const registry: { agents: SubagentDefinition[] } = { agents: [] };
vi.mock('@/core/agent/registry', () => ({
  agentRegistry: {
    getAgent: (name: string) => registry.agents.find((a) => a.name === name),
    getAvailableAgents: () => registry.agents.map(({ name, description }) => ({ name, description })),
  },
  serializeAgentMd: (meta: Record<string, unknown>, prompt: string) => `---\nrole-id: ${String(meta.roleId)}\n---\n${prompt}`,
}));
// Every write goes through the globally mocked plugin-fs: `saved` is what
// reached the disk, and nothing else (mkdir/rename/remove) may be touched.
import { mkdir, remove, rename, writeTextFile } from '@tauri-apps/plugin-fs';
const saved = {
  get length() { return vi.mocked(writeTextFile).mock.calls.length; },
  at: (i: number) => {
    const [filePath, md, options] = vi.mocked(writeTextFile).mock.calls[i];
    return { filePath: String(filePath), md: String(md), options };
  },
};
function expectNothingElseTouched(): void {
  expect(mkdir).not.toHaveBeenCalled();
  expect(rename).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
}

import { createRoleId, effectiveRoleId, ensureRoleId, isBuiltinAgent, resolveRoleId, roleIdAgentName } from './roleIdentity';

function def(name: string, extra: Partial<SubagentDefinition> = {}): SubagentDefinition {
  return { name, description: `${name} desc`, systemPrompt: 'p', filePath: `/Users/me/.abu/agents/${name}/AGENT.md`, ...extra } as SubagentDefinition;
}

describe('roleIdentity', () => {
  beforeEach(() => { registry.agents = []; activation.owners = {}; activation.ready = true; vi.clearAllMocks(); });

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

  it('roleIdAgentName spells the name of name-keyed ids only, even when the agent is gone', () => {
    expect(roleIdAgentName('builtin:产品经理')).toBe('产品经理');
    expect(roleIdAgentName('plugin:reviewer')).toBe('reviewer');
    expect(roleIdAgentName('role-abc123')).toBeUndefined();
    expect(roleIdAgentName('builtin:')).toBeUndefined();
    expect(roleIdAgentName('plugin:')).toBeUndefined();
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
    expect(saved.length).toBe(1);
    expect(saved.at(0).md).toContain(`role-id: ${fresh.roleId}`);
    expect(saved.at(0).filePath).toBe('/Users/me/.abu/agents/b/AGENT.md');
    expectNothingElseTouched();
  });

  it('writes the role-id into the file the registry read, even when its folder is not named after the agent', async () => {
    // Folder `old-writer/`, frontmatter `name: writer`; an unrelated agent may
    // live in `writer/`. Re-deriving the path from the name would overwrite
    // that agent and then delete `old-writer/`.
    const renamedByHand = def('writer', { filePath: '/Users/me/.abu/agents/old-writer/AGENT.md' });
    const ensured = await ensureRoleId(renamedByHand);
    expect(ensured.wrote).toBe(true);
    expect(saved.length).toBe(1);
    expect(saved.at(0).filePath).toBe('/Users/me/.abu/agents/old-writer/AGENT.md');
    expect(saved.at(0).md).toContain(`role-id: ${ensured.roleId}`);
    // A file deleted since the registry read it is not recreated.
    expect(saved.at(0).options).toEqual({ create: false });
    expectNothingElseTouched();
  });

  it('writes a project-level agent in place — never a copy into ~/.abu', async () => {
    const projectAgent = def('qa', { filePath: '/work/repo/.abu/agents/qa/AGENT.md' });
    await ensureRoleId(projectAgent);
    expect(saved.length).toBe(1);
    expect(saved.at(0).filePath).toBe('/work/repo/.abu/agents/qa/AGENT.md');
    expectNothingElseTouched();
  });

  it('an activation-record owner makes an agent plugin-owned even when its frontmatter has no source: key', async () => {
    // `source:` in AGENT.md is only a cache — an agent installed before the key
    // existed has none. Ownership follows the persisted activation records, or
    // ensureRoleId would write a role-id into the plugin's file.
    const noSource = def('y');
    registry.agents = [noSource];
    activation.owners[noSource.filePath] = 'x@official';
    expect(effectiveRoleId(noSource)).toBe('plugin:y');
    expect(resolveRoleId('plugin:y')?.name).toBe('y');
    const ensured = await ensureRoleId(noSource);
    expect(ensured).toEqual({ roleId: 'plugin:y', wrote: false });
    expect(saved.length).toBe(0);
  });

  it('conflicting ownership claims (owner null) fail closed: plugin-managed, never written', async () => {
    const contested = def('c');
    registry.agents = [contested];
    activation.owners[contested.filePath] = null;
    expect(effectiveRoleId(contested)).toBe('plugin:c');
    const ensured = await ensureRoleId(contested);
    expect(ensured).toEqual({ roleId: 'plugin:c', wrote: false });
    expect(saved.length).toBe(0);
  });

  it('an orphaned frontmatter source: (records ready, no plugin claims the file) is a user agent', async () => {
    // Plugin uninstalled, AGENT.md left behind in ~/.abu/agents with a stale
    // `source:` key — no activation record claims it, so it is the user's now.
    const orphan = def('z', { roleId: 'role-z', source: { kind: 'plugin', plugin: 'gone@official' } });
    registry.agents = [orphan];
    expect(effectiveRoleId(orphan)).toBe('role-z');
    expect(resolveRoleId('plugin:z')).toBeNull();
    // Deliberate: the file is user-owned now, so joining a team pins a role-id in it.
    const bare = def('w', { source: { kind: 'plugin', plugin: 'gone@official' } });
    const ensured = await ensureRoleId(bare);
    expect(ensured.wrote).toBe(true);
    expect(ensured.roleId).toMatch(/^role-/);
    expect(saved.length).toBe(1);
    expect(saved.at(0).filePath).toBe('/Users/me/.abu/agents/w/AGENT.md');
  });

  it('before activation records are ready (cold start), the frontmatter source: decides', async () => {
    activation.ready = false;
    const fromPlugin = def('reviewer', { source: { kind: 'plugin', plugin: 'weather@official' } });
    registry.agents = [fromPlugin, def('reviewer-copy')];
    expect(effectiveRoleId(fromPlugin)).toBe('plugin:reviewer');
    expect(resolveRoleId('plugin:reviewer')?.name).toBe('reviewer');
    // A user agent of the same name is NOT the plugin's agent.
    registry.agents = [def('reviewer')];
    expect(resolveRoleId('plugin:reviewer')).toBeNull();
    const ensured = await ensureRoleId(fromPlugin);
    expect(ensured).toEqual({ roleId: 'plugin:reviewer', wrote: false });
    expect(saved.length).toBe(0);
  });

  it('regression: a recorded owner is enough on its own — ensureRoleId never writes into a plugin file', async () => {
    // The discovery-based check lost this when a failed installed.json read
    // stripped every source; activation records survive such a read.
    const owned = def('p');
    registry.agents = [owned];
    activation.owners[owned.filePath] = 'x@official';
    for (const ready of [true, false]) {
      activation.ready = ready;
      expect(await ensureRoleId(owned)).toEqual({ roleId: 'plugin:p', wrote: false });
    }
    expect(saved.length).toBe(0);
  });

  it('createRoleId yields distinct role- ids', () => {
    const a = createRoleId(); const b = createRoleId();
    expect(a).toMatch(/^role-/);
    expect(a).not.toBe(b);
  });
});
