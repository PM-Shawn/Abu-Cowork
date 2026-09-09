import { describe, expect, it } from 'vitest';
import { resolveSubagentToolNames } from '@/core/agent/subagentToolRoster';
import {
  getAgentToolSummary,
  getUnmatchedAgentToolPatterns,
  parseAgentToolPatterns,
} from './agentToolPresentation';

describe('agentToolPresentation', () => {
  const runtimeTools = [
    'read_file', 'write_file', 'abu-browser__screenshot', 'abu-browser__click',
    'runtime-service__inspect', 'delegate_to_agent', 'run_agent_batch', 'update_soul', 'ask_user_question',
  ];

  it.each([
    { label: 'omitted constraints', tools: undefined, disallowedTools: undefined },
    { label: 'empty role lists', tools: [], disallowedTools: [] },
  ])('summarizes $label using the actual member roster at each runtime', ({ tools, disallowedTools }) => {
    for (const known of [runtimeTools, [...runtimeTools, 'new-runtime-service__search']]) {
      const summary = getAgentToolSummary(tools, disallowedTools, known);
      expect(summary).toEqual({
        isUnrestricted: true,
        ...resolveSubagentToolNames(known, { tools, disallowedTools }),
      });
      expect(summary.toolNames).toEqual(known.filter((name) => ![
        'delegate_to_agent', 'run_agent_batch', 'update_soul', 'ask_user_question',
      ].includes(name)));
    }
  });

  it('shows inherited tools minus an explicit deny using the actual member roster', () => {
    const disallowedTools = ['abu-browser__*', 'write_file'];
    const summary = getAgentToolSummary(undefined, disallowedTools, runtimeTools);
    expect(summary).toEqual({
      isUnrestricted: false,
      ...resolveSubagentToolNames(runtimeTools, { disallowedTools }),
    });
    expect(summary.toolNames).toEqual(['read_file', 'runtime-service__inspect']);
  });

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
