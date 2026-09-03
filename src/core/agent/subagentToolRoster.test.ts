import { describe, expect, it } from 'vitest';
import { checkDispatchToolBoundary, resolveSubagentToolNames } from './subagentToolRoster';

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
});

describe('protocol tools', () => {
  it('team_propose_plan is available even when the agent declares an explicit tools allowlist', () => {
    // Marketplace/builtin agents ship frozen tool lists that predate the team
    // protocol tool — the leader must still be able to report its split
    // (real-machine bug 2026-08-31: planning silently produced no plan).
    const names = resolveSubagentToolNames(
      ['web_search', 'read_file', 'team_propose_plan'],
      { tools: ['web_search'] },
    ).toolNames;
    expect(names).toContain('team_propose_plan');
    expect(names).toContain('web_search');
    expect(names).not.toContain('read_file');
  });

  it('an explicit disallowed-tools entry still removes the protocol tool', () => {
    const names = resolveSubagentToolNames(
      ['team_propose_plan', 'read_file'],
      { disallowedTools: ['team_propose_plan'] },
    ).toolNames;
    expect(names).not.toContain('team_propose_plan');
  });

  describe('checkDispatchToolBoundary (dispatch-time re-check)', () => {
    it('lets a frozen-tools agent call the protocol tool it was offered', () => {
      // Builtin 数据分析师 shape: a fixed list that predates team_propose_plan.
      const frozen = ['read_file', 'write_file', 'run_command', 'web_search'];
      expect(checkDispatchToolBoundary(frozen, undefined, 'team_propose_plan', { items: [] })).toBeNull();
      // …and the run-level allowlist must not veto it either.
      expect(checkDispatchToolBoundary(frozen, ['read_file'], 'team_propose_plan', { items: [] })).toBeNull();
    });

    it('still refuses ordinary tools outside the declared list or the run allowlist', () => {
      const frozen = ['read_file'];
      expect(checkDispatchToolBoundary(frozen, undefined, 'write_file', { path: '/x' })).toMatch(/fixed tool boundary/);
      expect(checkDispatchToolBoundary(undefined, ['read_file'], 'write_file', { path: '/x' })).toMatch(/not allowed for this agent run/);
      expect(checkDispatchToolBoundary(frozen, undefined, 'read_file', { path: '/x' })).toBeNull();
    });
  });
});
