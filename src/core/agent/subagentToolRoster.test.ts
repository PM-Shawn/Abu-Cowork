import { describe, expect, it } from 'vitest';
import { checkDispatchToolBoundary, resolveSubagentToolNames } from './subagentToolRoster';
import { buildScheduledRunPermissionCeiling, decideToolUnderRunPermissionCeiling } from '@/core/permissions/runPermissionCeiling';
import { agentToolPolicyForRoute, resolveAgentToolNames } from './agentToolPolicy';

const KNOWN_TOOLS = [
  'read_file',
  'write_file',
  'abu-browser__screenshot',
  'delegate_to_agent',
  'run_agent_batch',
  'update_soul',
  'ask_user_question',
];

describe('resolveSubagentToolNames', () => {
  it('shares wildcard, denylist, parent boundary and fixed exclusions', () => {
    expect(resolveSubagentToolNames(KNOWN_TOOLS, {})).toEqual({
      toolNames: ['read_file', 'write_file', 'abu-browser__screenshot'],
    });
    expect(resolveSubagentToolNames(
      KNOWN_TOOLS,
      { tools: ['read_file', 'abu-browser__*'], disallowedTools: ['abu-browser__screenshot'] },
      ['read_*'],
    )).toEqual({ toolNames: ['read_file'] });
  });

  it('never offers present_files to a member, even when its role names the tool', () => {
    expect(resolveSubagentToolNames(['read_file', 'present_files'], {})).toEqual({ toolNames: ['read_file'] });
    expect(resolveSubagentToolNames(['read_file', 'present_files'], { tools: ['present_files'] })).toEqual({
      toolNames: [],
    });
  });

  describe('an expert that runs the user turn itself', () => {
    const turnOwner = { ownsUserTurn: true };

    it('is offered present_files, also when its role lists other tools only', () => {
      expect(resolveSubagentToolNames(['read_file', 'present_files'], {}, undefined, undefined, turnOwner)).toEqual({
        toolNames: ['read_file', 'present_files'],
      });
      expect(resolveSubagentToolNames(['read_file', 'write_file', 'present_files'], { tools: ['read_file'] }, undefined, undefined, turnOwner)).toEqual({
        toolNames: ['read_file', 'present_files'],
      });
    });

    it('loses present_files to its own deny list and to the restrictions of the run', () => {
      const names = ['read_file', 'present_files'];
      expect(resolveSubagentToolNames(names, { disallowedTools: ['present_files'] }, undefined, undefined, turnOwner).toolNames).toEqual(['read_file']);
      expect(resolveSubagentToolNames(names, {}, ['read_*'], undefined, turnOwner).toolNames).toEqual(['read_file']);
      expect(resolveSubagentToolNames(names, {}, undefined, ['present_files'], turnOwner).toolNames).toEqual(['read_file']);
    });

    it('keeps every other member exclusion', () => {
      expect(resolveSubagentToolNames([...KNOWN_TOOLS, 'manage_goal', 'save_agent', 'present_files'], {}, undefined, undefined, turnOwner)).toEqual({
        toolNames: ['read_file', 'write_file', 'abu-browser__screenshot', 'present_files'],
      });
    });

    it('may call present_files past a role allowlist, and nothing else past it', () => {
      const role = { tools: ['read_file'] };
      expect(checkDispatchToolBoundary(role, undefined, 'present_files', { files: [] }, turnOwner)).toBeNull();
      expect(checkDispatchToolBoundary(role, undefined, 'write_file', { path: '/a' }, turnOwner)).toContain('fixed tool boundary');
      expect(checkDispatchToolBoundary(role, ['read_*'], 'present_files', { files: [] }, turnOwner)).toContain('not allowed for this agent run');
      expect(checkDispatchToolBoundary({ disallowedTools: ['present_files'] }, undefined, 'present_files', { files: [] }, turnOwner)).toContain('fixed tool boundary');
    });

    it('leaves a member behind a role allowlist without present_files', () => {
      expect(checkDispatchToolBoundary({ tools: ['read_file'] }, undefined, 'present_files', { files: [] })).toContain('fixed tool boundary');
    });
  });

  it('fails closed for malformed and blank declarations', () => {
    expect(resolveSubagentToolNames(KNOWN_TOOLS, { tools: ['   '] })).toEqual({
      toolNames: [],
      invalidField: 'tools',
    });
    expect(resolveSubagentToolNames(KNOWN_TOOLS, { disallowedTools: ['read_file', ''] })).toEqual({
      toolNames: [],
      invalidField: 'disallowedTools',
    });
  });

  it('inherits empty role and optional task patterns while exact empty task snapshots deny every tool', () => {
    expect(resolveSubagentToolNames(['read_file'], { tools: [] }, [])).toEqual({ toolNames: ['read_file'] });
    expect(resolveSubagentToolNames([], { tools: [] }, [])).toEqual({ toolNames: [] });
    const exactTaskSnapshot = buildScheduledRunPermissionCeiling([]);
    expect(decideToolUnderRunPermissionCeiling(exactTaskSnapshot, 'read_file', {}).decision).toBe('deny');
    expect(decideToolUnderRunPermissionCeiling(exactTaskSnapshot, 'report_plan', {}).decision).toBe('deny');
  });

  it('keeps member exclusions and task restrictions after the shared role policy', () => {
    expect(resolveSubagentToolNames(
      [...KNOWN_TOOLS, 'report_plan'],
      { tools: ['*'] },
      ['read_file', 'write_file', 'delegate_to_agent', 'run_agent_batch'],
      ['write_*'],
    )).toEqual({ toolNames: ['read_file'] });
    expect(resolveSubagentToolNames(['read_file', 'report_plan'], { tools: ['read_file'] })).toEqual({
      toolNames: ['read_file'],
    });
  });
});

// System-configuration tools a member may never hold, however its card, the
// dispatch call or the model asks. Listed one by one rather than imported from
// the module under test, so dropping a name from the block list fails here.
const SYSTEM_CONFIG_TOOLS = [
  'manage_scheduled_task',
  'manage_trigger',
  'manage_file_watch',
  'manage_mcp_server',
  'save_agent',
  'save_team',
  'skill_manage',
  'plugin_prepare',
];

describe('system-configuration tools never reach a member', () => {
  it.each(SYSTEM_CONFIG_TOOLS)('keeps %s out of a member roster however the member asks for it', (toolName) => {
    const inventory = ['read_file', toolName];
    // Inherited roster, an explicit card allowlist, a wildcard card, and a
    // dispatch-time allowedTools naming it: none of them let it through.
    expect(resolveSubagentToolNames(inventory, {})).toEqual({ toolNames: ['read_file'] });
    expect(resolveSubagentToolNames(inventory, { tools: [toolName] })).toEqual({ toolNames: [] });
    expect(resolveSubagentToolNames(inventory, { tools: ['*'] })).toEqual({ toolNames: ['read_file'] });
    expect(resolveSubagentToolNames(inventory, {}, [toolName])).toEqual({ toolNames: [] });
  });

  // The block list is a member rule, not a product rule: the root agent and a
  // team leader reach their roster through agentToolPolicy, which this list
  // must not touch — a leader that cannot call save_agent/save_team could not
  // do the job the create-agent skill asks of it.
  it.each([
    ['root agent', false],
    ['team leader', true],
  ])('leaves the %s holding every system-configuration tool', (_label, asTeam) => {
    const inventory = ['read_file', ...SYSTEM_CONFIG_TOOLS];
    const policy = agentToolPolicyForRoute({
      type: 'agent',
      name: 'abu',
      definition: { name: 'abu', description: 'root', systemPrompt: '', filePath: '__builtin__' },
      cleanInput: '',
      ...(asTeam
        ? { team: { teamId: 't', teamName: 'T', leader: { name: 'abu', description: 'root', systemPrompt: '', filePath: '__builtin__' }, members: [] } }
        : {}),
    })!;
    expect(resolveAgentToolNames(inventory, policy)).toEqual({ toolNames: inventory });
  });
});

describe('protocol tools', () => {
  describe('checkDispatchToolBoundary (dispatch-time re-check)', () => {
    it('still refuses ordinary tools outside the declared list or the run allowlist', () => {
      const frozen = ['read_file'];
      expect(checkDispatchToolBoundary({ tools: frozen }, undefined, 'write_file', { path: '/x' })).toMatch(/fixed tool boundary/);
      expect(checkDispatchToolBoundary({}, ['read_file'], 'write_file', { path: '/x' })).toMatch(/not allowed for this agent run/);
      expect(checkDispatchToolBoundary({ tools: frozen }, undefined, 'read_file', { path: '/x' })).toBeNull();
    });

    it('rechecks role deny and invalid metadata at dispatch time', () => {
      expect(checkDispatchToolBoundary({ disallowedTools: ['read_*'] }, undefined, 'read_file', {})).not.toBeNull();
      expect(checkDispatchToolBoundary({ tools: 'read_file' }, undefined, 'read_file', {})).not.toBeNull();
      expect(checkDispatchToolBoundary({ disallowedTools: [''] }, undefined, 'read_file', {})).not.toBeNull();
    });

    it('grants no member protocol exemption from role or task parameter restrictions', () => {
      expect(checkDispatchToolBoundary({ tools: ['read_file'] }, undefined, 'report_plan', {})).not.toBeNull();
      expect(checkDispatchToolBoundary({}, ['read_file'], 'report_plan', {})).not.toBeNull();
      expect(checkDispatchToolBoundary({}, ['run_command(npm run *)'], 'run_command', { command: 'echo no' })).not.toBeNull();
      expect(checkDispatchToolBoundary({ tools: [] }, [], 'read_file', {})).toBeNull();
      const forgedPolicy = { tools: ['read_file'], protocolTools: ['report_plan'] };
      expect(resolveSubagentToolNames(['report_plan'], forgedPolicy)).toEqual({ toolNames: [] });
      expect(checkDispatchToolBoundary(forgedPolicy, undefined, 'report_plan', {})).not.toBeNull();
    });
  });
});
