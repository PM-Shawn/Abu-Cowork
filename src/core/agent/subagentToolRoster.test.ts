import { describe, expect, it } from 'vitest';
import { resolveSubagentToolNames } from './subagentToolRoster';

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
});
