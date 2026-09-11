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
  describe('checkDispatchToolBoundary (dispatch-time re-check)', () => {
    it('still refuses ordinary tools outside the declared list or the run allowlist', () => {
      const frozen = ['read_file'];
      expect(checkDispatchToolBoundary(frozen, undefined, 'write_file', { path: '/x' })).toMatch(/fixed tool boundary/);
      expect(checkDispatchToolBoundary(undefined, ['read_file'], 'write_file', { path: '/x' })).toMatch(/not allowed for this agent run/);
      expect(checkDispatchToolBoundary(frozen, undefined, 'read_file', { path: '/x' })).toBeNull();
    });
  });
});
