import { describe, expect, it } from 'vitest';
import {
  getAgentToolSummary,
  getUnmatchedAgentToolPatterns,
  parseAgentToolPatterns,
} from './agentToolPresentation';

describe('agentToolPresentation', () => {
  it('parses trimmed comma-separated patterns', () => {
    expect(parseAgentToolPatterns(' read_file, abu-browser__* , ,write_file ')).toEqual([
      'read_file',
      'abu-browser__*',
      'write_file',
    ]);
  });

  it('uses runtime wildcard semantics to identify unmatched entries', () => {
    expect(getUnmatchedAgentToolPatterns(
      'read_file, abu-browser__*, missing_tool',
      ['read_file', 'abu-browser__screenshot'],
    )).toEqual(['missing_tool']);
  });

  it('describes unrestricted and whitelisted tool access', () => {
    const known = ['read_file', 'write_file', 'abu-browser__screenshot', 'abu-browser__click', 'run_agent_batch'];
    expect(getAgentToolSummary(undefined, undefined, known)).toEqual({
      isUnrestricted: true,
      toolNames: known.slice(0, -1),
    });
    expect(getAgentToolSummary(
      ['read_file', 'abu-browser__*'],
      ['abu-browser__click'],
      known,
    )).toEqual({
      isUnrestricted: false,
      toolNames: ['read_file', 'abu-browser__screenshot'],
    });
    expect(getAgentToolSummary(undefined, ['read_file'], known)).toEqual({
      isUnrestricted: false,
      toolNames: ['write_file', 'abu-browser__screenshot', 'abu-browser__click'],
    });
    expect(getAgentToolSummary('read_file' as never, undefined, known)).toEqual({
      isUnrestricted: false,
      toolNames: [],
      invalidField: 'tools',
    });
    expect(getAgentToolSummary(undefined, 'write_file' as never, known)).toEqual({
      isUnrestricted: false,
      toolNames: [],
      invalidField: 'disallowedTools',
    });
    expect(getAgentToolSummary(['   '], undefined, known)).toEqual({
      isUnrestricted: false,
      toolNames: [],
      invalidField: 'tools',
    });
  });
});
