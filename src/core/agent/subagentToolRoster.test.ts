import { describe, expect, it } from 'vitest';
import { checkDispatchToolBoundary, resolveSubagentToolNames } from './subagentToolRoster';
import { buildScheduledRunPermissionCeiling, decideToolUnderRunPermissionCeiling } from '@/core/permissions/runPermissionCeiling';

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
