import type { ToolDefinition } from '@/types';
import { agentRegistry } from '@/core/agent/registry';
import { effectiveRoleId, ensureRoleId } from '@/core/team/roleIdentity';
import { isValidNewAvatar } from '@/core/tools/definitions/agentTools';
import { useTeamStore } from '@/stores/teamStore';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { getI18n, format } from '@/i18n';
import { TOOL_NAMES } from '@/core/tools/toolNames';

const optionalStrings = ['description', 'intro', 'avatar', 'leaderNote'] as const;
const optionalLists = ['expertise', 'samplePrompts'] as const;

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export const saveTeamTool: ToolDefinition = {
  name: TOOL_NAMES.SAVE_TEAM,
  description: 'Create or modify a persistent team when the user asks. An existing team with the same name has its roster replaced. Pass exact available agent names for leader and members; unknown or unavailable names fail without saving the team. Omitted optional fields are preserved on updates; pass an empty string or array to clear a field, or false to disable plan approval. This tool never deletes teams.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Team name; an existing name replaces that team.' },
      leader: { type: 'string', description: 'Exact agent name of the team leader.' },
      members: { type: 'array', items: { type: 'string' }, description: 'Exact agent names; the leader is included automatically.' },
      description: { type: 'string', description: 'One sentence describing the team.' },
      intro: { type: 'string', description: 'Self-introduction shown in the team detail and chat welcome.' },
      expertise: { type: 'array', items: { type: 'string' }, description: 'Display-only areas of expertise, usually three.' },
      samplePrompts: { type: 'array', items: { type: 'string' }, description: 'Suggested questions, usually three; clicking only prefills a new chat.' },
      avatar: { type: 'string', description: 'Optional valid built-in icon reference, e.g. icon:chart-bar/blue, or one emoji. Empty clears the avatar.' },
      requirePlanApproval: { type: 'boolean', description: 'Whether the leader waits for user approval before executing its plan. Defaults to false on creation; omitted preserves the setting on updates.' },
      leaderNote: { type: 'string', description: 'Extra instructions for the leader when working with this team.' },
    },
    required: ['name', 'leader', 'members'],
  },
  // `context` is unused: the run-permission ceiling and the user confirmation
  // are the registry's self-extension gate (`classifySelfExtension` +
  // `checkToolApproval`), so a team write is gated in exactly one place.
  execute: async (input) => {
    const t = getI18n().toolResult.team;
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const leaderName = typeof input.leader === 'string' ? input.leader.trim() : '';
    if (!name || !leaderName || !isStringList(input.members)
      || optionalStrings.some((key) => input[key] !== undefined && typeof input[key] !== 'string')
      || optionalLists.some((key) => input[key] !== undefined && !isStringList(input[key]))
      || (input.requirePlanApproval !== undefined && typeof input.requirePlanApproval !== 'boolean')) {
      return t.invalidInput;
    }
    if (typeof input.avatar === 'string' && !isValidNewAvatar(input.avatar.trim())) return t.invalidInput;

    const names = [...new Set([leaderName, ...input.members.map((member) => member.trim())])];
    const available = new Set(agentRegistry.getAvailableAgents().map((agent) => agent.name));
    const disabled = new Set(useSettingsStore.getState().disabledAgents);
    const resolved = names.map((agentName) => ({ name: agentName, agent: agentRegistry.getAgent(agentName) }));
    const missing = resolved.filter(({ name: agentName, agent }) => !available.has(agentName) || !agent || agent.name === 'abu' || agent.managed || disabled.has(agentName));
    // Validate the ENTIRE roster before ensureRoleId can write any AGENT.md.
    if (missing.length) return format(t.unavailableAgents, { names: missing.map(({ name: agentName }) => JSON.stringify(agentName)).join(', ') });

    try {
      const roleIds: string[] = [];
      let wroteIdentity = false;
      for (const { agent } of resolved) {
        // All entries were checked before the first asynchronous write.
        const member = agent!;
        const existingRoleId = effectiveRoleId(member);
        const identity = existingRoleId ? { roleId: existingRoleId, wrote: false } : await ensureRoleId(member);
        roleIds.push(identity.roleId);
        wroteIdentity ||= identity.wrote;
      }
      if (wroteIdentity) await useDiscoveryStore.getState().refresh();

      const text = (key: typeof optionalStrings[number]) => (input[key] as string | undefined)?.trim() || undefined;
      const lines = (key: typeof optionalLists[number]) => {
        const values = (input[key] as string[] | undefined)?.map((value) => value.trim()).filter(Boolean);
        return values?.length ? values : undefined;
      };
      const fields = {
        name, leaderRoleId: roleIds[0], memberRoleIds: roleIds,
        // Omission means keep the user's value; explicit empties mean clear it.
        ...(input.description !== undefined && { description: text('description') }),
        ...(input.intro !== undefined && { intro: text('intro') }),
        ...(input.avatar !== undefined && { avatar: text('avatar') }),
        ...(input.leaderNote !== undefined && { leaderNote: text('leaderNote') }),
        ...(input.expertise !== undefined && { expertise: lines('expertise') }),
        ...(input.samplePrompts !== undefined && { samplePrompts: lines('samplePrompts') }),
        ...(input.requirePlanApproval !== undefined && { requirePlanApproval: input.requirePlanApproval === true }),
      };
      // Re-read after identity writes: another caller may have saved this name.
      const store = useTeamStore.getState();
      const existing = store.teams.find((team) => team.name === name);
      const id = existing ? existing.id : store.createTeam(fields).id;
      if (existing) store.updateTeam(id, fields);
      const saved = useTeamStore.getState().teams.find((team) => team.id === id)!;
      return format(t.saved, { name: saved.name, leader: leaderName, count: String(saved.memberRoleIds.length - 1), approval: saved.requirePlanApproval ? t.approvalOn : t.approvalOff })
        + '\n' + JSON.stringify({ name: saved.name, leader: leaderName, members: names.slice(1), description: saved.description, intro: saved.intro, expertise: saved.expertise, samplePrompts: saved.samplePrompts, avatar: saved.avatar, leaderNote: saved.leaderNote, requirePlanApproval: saved.requirePlanApproval === true });
    } catch (error) {
      return format(t.saveFailed, { reason: String(error) });
    }
  },
  isConcurrencySafe: false,
};
