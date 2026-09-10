import { describe, it, expect } from 'vitest';
import { getCapabilityPrompt } from './capabilityPrompt';

describe('capabilityPrompt — extension directory facts', () => {
  it('does not claim every agent has an AGENT.md file', () => {
    // Built-in agents are registered in registry.ts with filePath `__builtin__`;
    // a blanket "each agent has an AGENT.md file" sent the leader off to
    // read_file ~/.abu/agents/<builtin>/AGENT.md and get ENOENT.
    expect(getCapabilityPrompt()).not.toContain('each agent has an AGENT.md');
  });

  it('scopes the agents directory to user-created agents', () => {
    expect(getCapabilityPrompt()).toContain('user-created agents');
  });

  it('forbids hand-building an agent path and names the roster as authoritative', () => {
    const prompt = getCapabilityPrompt();
    expect(prompt).toContain('Do NOT construct a filesystem path from an agent name');
    expect(prompt).toContain('Built-in agents have NO file there.');
    expect(prompt).not.toContain('team members have NO file');
    expect(prompt).toContain('the Available Agents list in this prompt is authoritative');
  });

  it('keeps the matching skill-path rule (nothing today asserts it)', () => {
    expect(getCapabilityPrompt()).toContain('Do NOT construct a filesystem path from the skill name');
  });
});
