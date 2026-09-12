import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SubagentDefinition } from '@/types';

const { agents, disabled, refresh, serialize } = vi.hoisted(() => ({
  agents: {} as Record<string, SubagentDefinition>, disabled: [] as string[],
  refresh: vi.fn(async () => {}),
  serialize: vi.fn((_metadata: unknown, _systemPrompt: string) => 'agent markdown'),
}));
vi.mock('@/core/agent/registry', () => ({
  agentRegistry: { getAvailableAgents: () => Object.values(agents).map(({ filePath: _path, systemPrompt: _prompt, ...meta }) => meta), getAgent: (name: string) => agents[name] },
  serializeAgentMd: serialize,
}));
vi.mock('@/stores/discoveryStore', () => ({ useDiscoveryStore: { getState: () => ({ refresh }) } }));
vi.mock('@/stores/settingsStore', () => ({ useSettingsStore: { getState: () => ({ disabledAgents: disabled }) } }));

// Identity writes go through the globally mocked plugin-fs (roleIdentity.ts).
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { useTeamStore } from '@/stores/teamStore';
import { saveTeamTool } from './teamTools';
import { buildScheduledRunPermissionCeiling, buildIMRunPermissionCeiling } from '@/core/permissions/runPermissionCeiling';

const input = { name: 'Data team', leader: 'Analyst', members: ['Fetcher'] };

describe('save_team', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTeamStore.setState({ teams: [] });
    for (const key of Object.keys(agents)) delete agents[key];
    disabled.length = 0;
    agents.Analyst = { name: 'Analyst', description: 'Analyze', filePath: '__builtin__', systemPrompt: '' };
    agents.Fetcher = { name: 'Fetcher', description: 'Fetch', roleId: 'role-fetch', filePath: '/agents/fetch/AGENT.md', systemPrompt: '' };
  });

  it('resolves full agent identities and includes the leader once', async () => {
    await saveTeamTool.execute({ ...input, members: ['Fetcher', 'Analyst', 'Fetcher'] }, {});
    expect(useTeamStore.getState().teams[0]).toMatchObject({ name: input.name, leaderRoleId: 'builtin:Analyst', memberRoleIds: ['builtin:Analyst', 'role-fetch'] });
    expect(writeTextFile).not.toHaveBeenCalled();
  });

  it('overwrites the same name while retaining its id and saved plan', async () => {
    await saveTeamTool.execute({ ...input, members: [] }, {});
    const before = useTeamStore.getState().teams[0];
    const lastPlan = { request: 'Review', steps: ['Read'], savedAt: 1 };
    useTeamStore.getState().updateTeam(before.id, { lastPlan });
    const display = { description: 'Data insights', intro: 'We investigate', expertise: ['Queries'], samplePrompts: ['Review sales'], avatar: 'icon:chart-bar/blue', leaderNote: 'Check sources', requirePlanApproval: true };
    const out = await saveTeamTool.execute({ ...input, name: ' Data team ', ...display }, {});
    expect(useTeamStore.getState().teams).toHaveLength(1);
    expect(useTeamStore.getState().teams[0]).toMatchObject({ ...display, id: before.id, createdAt: before.createdAt, lastPlan, memberRoleIds: ['builtin:Analyst', 'role-fetch'] });
    expect(String(out)).toContain('Data insights');
    expect(String(out)).toContain('Review sales');
  });

  it('preserves omitted display and approval fields when replacing a roster', async () => {
    const display = { description: 'Data insights', intro: 'We investigate', expertise: ['Queries'], samplePrompts: ['Review sales'], avatar: 'icon:chart-bar/blue', leaderNote: 'Check sources', requirePlanApproval: true };
    await saveTeamTool.execute({ ...input, members: [], ...display }, {});
    const out = await saveTeamTool.execute(input, {});
    expect(useTeamStore.getState().teams[0]).toMatchObject({ ...display, memberRoleIds: ['builtin:Analyst', 'role-fetch'] });
    expect(String(out)).toContain('Review sales');
    expect(String(out)).toContain('"requirePlanApproval":true');
  });

  // The UI writes the profile straight into the store, so "omitted means keep"
  // has to hold for values this tool never saw — not just for its own writes.
  it('keeps user-entered profile fields when the model omits them', async () => {
    useTeamStore.getState().createTeam({ name: 'Data team', leaderRoleId: 'builtin:Analyst', memberRoleIds: ['builtin:Analyst'], description: 'keep me', expertise: ['keep this too'] });
    await saveTeamTool.execute(input, {});
    expect(useTeamStore.getState().teams).toHaveLength(1);
    expect(useTeamStore.getState().teams.find((team) => team.name === 'Data team')).toMatchObject({ description: 'keep me', expertise: ['keep this too'], memberRoleIds: ['builtin:Analyst', 'role-fetch'] });
  });

  it('clears optional fields only when explicitly requested', async () => {
    await saveTeamTool.execute({ ...input, description: 'Before', intro: 'Before', expertise: ['Before'], samplePrompts: ['Before'], avatar: '📊', leaderNote: 'Before', requirePlanApproval: true }, {});
    await saveTeamTool.execute({ ...input, description: '', intro: ' ', expertise: [], samplePrompts: [' '], avatar: '', leaderNote: '', requirePlanApproval: false }, {});
    expect(useTeamStore.getState().teams[0]).toMatchObject({ description: undefined, intro: undefined, expertise: undefined, samplePrompts: undefined, avatar: undefined, leaderNote: undefined, requirePlanApproval: false });
  });

  it.each(['chart-bar', '一个数据小队的图标', 'icon:unknown/blue', '📊📊', '👩‍'.repeat(40) + '💻'])('rejects malformed newly authored avatars before writing: %s', async (avatar) => {
    delete agents.Fetcher.roleId;
    const out = await saveTeamTool.execute({ ...input, avatar }, {});
    expect(String(out)).toContain('Error:');
    expect(useTeamStore.getState().teams).toEqual([]);
    expect(writeTextFile).not.toHaveBeenCalled();
  });

  it.each(['📊', '👩🏽‍💻', '👨‍👩‍👧‍👦', '🇨🇳', '1️⃣'])('accepts a single legacy emoji including joined sequences: %s', async (avatar) => {
    await saveTeamTool.execute({ ...input, avatar }, {});
    expect(useTeamStore.getState().teams[0].avatar).toBe(avatar);
  });

  it.each([
    { leader: 'Missing leader', members: [] },
    { leader: 'Analyst', members: ['Missing member', 'Another missing member'] },
    { leader: 'Fetcher', members: ['Missing member'] },
  ])('rejects the whole roster before any writes: %j', async (roster) => {
    delete agents.Fetcher.roleId;
    const out = await saveTeamTool.execute({ ...input, ...roster }, {});
    for (const name of [roster.leader, ...roster.members].filter((name) => !agents[name])) expect(String(out)).toContain(name);
    expect(useTeamStore.getState().teams).toEqual([]);
    expect(writeTextFile).not.toHaveBeenCalled();
  });

  it('does not partially overwrite an existing team when a member is missing', async () => {
    await saveTeamTool.execute(input, {});
    const before = useTeamStore.getState().teams[0];
    await saveTeamTool.execute({ ...input, members: ['Missing'], description: 'Must not save' }, {});
    expect(useTeamStore.getState().teams[0]).toEqual(before);
  });

  it('persists a stable identity before saving a newly created custom member', async () => {
    delete agents.Fetcher.roleId;
    await saveTeamTool.execute(input, {});
    expect(writeTextFile).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
    const metadata = serialize.mock.calls[0][0] as unknown as { roleId: string };
    expect(metadata.roleId).toEqual(expect.any(String));
    expect(useTeamStore.getState().teams[0].memberRoleIds).toContain(metadata.roleId);
  });

  it('leaves the team untouched if assigning an identity fails', async () => {
    delete agents.Fetcher.roleId;
    vi.mocked(writeTextFile).mockRejectedValueOnce(new Error('write failed'));
    const out = await saveTeamTool.execute(input, {});
    expect(String(out)).toContain('write failed');
    expect(useTeamStore.getState().teams).toEqual([]);
  });

  it('rejects disabled members like the manual picker', async () => {
    disabled.push('Fetcher');
    const out = await saveTeamTool.execute(input, {});
    expect(String(out)).toContain('Fetcher');
    expect(useTeamStore.getState().teams).toEqual([]);
  });

  it.each([{ name: ' ' }, { leader: ' ' }, { members: 'Fetcher' }, { members: [42] }, { intro: 42 }, { expertise: ['Queries', 42] }, { requirePlanApproval: 'false' }])('rejects malformed input without changing data: %j', async (invalid) => {
    const out = await saveTeamTool.execute({ ...input, ...invalid }, {});
    expect(String(out)).toContain('Error:');
    expect(useTeamStore.getState().teams).toEqual([]);
  });

  it('respects readonly and scheduled run ceilings without writing identities', async () => {
    for (const runPermissionCeiling of [buildIMRunPermissionCeiling('read_tools'), buildScheduledRunPermissionCeiling(['save_team'])]) {
      const out = await saveTeamTool.execute(input, { runPermissionCeiling });
      expect(String(out)).toContain('Error:');
      expect(useTeamStore.getState().teams).toEqual([]);
      expect(writeTextFile).not.toHaveBeenCalled();
    }
  });
});
