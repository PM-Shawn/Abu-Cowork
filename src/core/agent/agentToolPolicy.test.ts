import { describe, expect, it } from 'vitest';
import { checkAgentToolCall, resolveAgentToolNames, type AgentToolPolicy } from '@/core/agent/agentToolPolicy';

const BUSINESS_TOOLS = ['read_file', 'write_file', 'notes__read', 'notes__write', 'run_command'];

describe('agentToolPolicy', () => {
  it.each([
    ['omitted allowlist', {}, BUSINESS_TOOLS],
    ['empty allowlist', { tools: [] }, BUSINESS_TOOLS],
    ['exact name', { tools: ['read_file'] }, ['read_file']],
    ['namespace wildcard', { tools: ['notes__*'] }, ['notes__read', 'notes__write']],
    ['trimmed patterns', { tools: [' read_file ', ' notes__* '] }, ['read_file', 'notes__read', 'notes__write']],
    ['allow and deny', { tools: ['notes__*'], disallowedTools: ['notes__write'] }, ['notes__read']],
    ['inherited allow and deny', { disallowedTools: ['notes__*'] }, ['read_file', 'write_file', 'run_command']],
  ])('resolves %s against the supplied available names', (_label, metadata, expected) => {
    const policy: AgentToolPolicy = { ...metadata, protocolTools: [] };
    expect(resolveAgentToolNames(BUSINESS_TOOLS, policy)).toEqual({ toolNames: expected });
    for (const name of BUSINESS_TOOLS) {
      expect(checkAgentToolCall(policy, name, {}) === null).toBe(expected.includes(name));
    }
  });

  it.each([
    ['tools', 'read_file'],
    ['tools', null],
    ['tools', {}],
    ['tools', [42]],
    ['tools', ['read_file', '   ']],
    ['disallowedTools', 'write_file'],
    ['disallowedTools', null],
    ['disallowedTools', {}],
    ['disallowedTools', [false]],
    ['disallowedTools', ['write_file', '']],
  ] as const)('fails closed for invalid %s metadata %j, including protocol calls', (field, value) => {
    const policy: AgentToolPolicy = { [field]: value, protocolTools: ['report_plan'] };
    expect(resolveAgentToolNames([...BUSINESS_TOOLS, 'report_plan'], policy)).toEqual({
      toolNames: [],
      invalidField: field,
    });
    expect(checkAgentToolCall(policy, 'read_file', {})).not.toBeNull();
    expect(checkAgentToolCall(policy, 'report_plan', {})).not.toBeNull();
  });

  it('reports tools first when both metadata fields are invalid, even with no available names', () => {
    expect(resolveAgentToolNames([], { tools: false, disallowedTools: false, protocolTools: [] })).toEqual({
      toolNames: [],
      invalidField: 'tools',
    });
  });

  it('offers a constrained schema but checks the actual command before allowing a call', () => {
    const policy: AgentToolPolicy = { tools: ['run_command(npm run *)'], protocolTools: [] };
    expect(resolveAgentToolNames(BUSINESS_TOOLS, policy)).toEqual({ toolNames: ['run_command'] });
    expect(checkAgentToolCall(policy, 'run_command', { command: 'npm run test:unit' })).toBeNull();
    expect(checkAgentToolCall(policy, 'run_command', { command: 'rm -rf /tmp/forbidden' })).not.toBeNull();
    expect(checkAgentToolCall(policy, 'run_command', {})).not.toBeNull();
    expect(checkAgentToolCall(policy, 'run_command', undefined)).not.toBeNull();
  });

  it('lets trusted protocol names bypass only the role allowlist, while deny still wins', () => {
    const policy: AgentToolPolicy = {
      tools: ['read_file'],
      disallowedTools: ['run_agent_batch'],
      protocolTools: ['report_plan', 'delegate_to_agent', 'run_agent_batch'],
    };
    expect(resolveAgentToolNames(
      ['read_file', 'write_file', 'report_plan', 'delegate_to_agent', 'run_agent_batch'], policy,
    )).toEqual({ toolNames: ['read_file', 'report_plan', 'delegate_to_agent'] });
    expect(checkAgentToolCall(policy, 'report_plan', {})).toBeNull();
    expect(checkAgentToolCall(policy, 'delegate_to_agent', {})).toBeNull();
    expect(checkAgentToolCall(policy, 'write_file', {})).not.toBeNull();
    expect(checkAgentToolCall(policy, 'run_agent_batch', {})).not.toBeNull();
    // A policy cannot create a schema missing from the runtime registry.
    expect(resolveAgentToolNames(['read_file'], policy)).toEqual({ toolNames: ['read_file'] });
  });

  it('matches protocol names exactly and applies wildcard deny to them', () => {
    const policy: AgentToolPolicy = {
      tools: ['read_file'],
      disallowedTools: ['report_*'],
      protocolTools: ['report_plan', 'delegate_*'],
    };
    expect(resolveAgentToolNames(['report_plan', 'delegate_to_agent'], policy)).toEqual({ toolNames: [] });
    expect(checkAgentToolCall(policy, 'report_plan', {})).not.toBeNull();
    expect(checkAgentToolCall(policy, 'delegate_to_agent', {})).not.toBeNull();
  });

  it('keeps deny patterns at the existing name-level boundary, including constrained names', () => {
    const policy: AgentToolPolicy = {
      disallowedTools: ['run_command(npm run *)'],
      protocolTools: ['run_command'],
    };
    expect(resolveAgentToolNames(['run_command'], policy)).toEqual({ toolNames: [] });
    expect(checkAgentToolCall(policy, 'run_command', { command: 'npm run test' })).not.toBeNull();
    expect(checkAgentToolCall(policy, 'run_command', { command: 'echo otherwise' })).not.toBeNull();
  });
});
