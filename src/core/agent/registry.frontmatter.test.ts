import { describe, it, expect } from 'vitest';
import { parseAgentFile } from './registry';

/**
 * `skills:` frontmatter shape. YAML has no way to tell an author that a bare
 * scalar is not a list, so `skills: weekly-report` is a shape the field WILL
 * receive. It used to be cast straight to `string[]`, after which
 * `resolvePreloadedSkills` bailed on its `Array.isArray` check and the
 * subagent loop's own `Array.isArray` fail-loud guard suppressed the warning
 * too — an entirely silent no-op. The sibling skill-format field `tools:`
 * accepts both an array and a whitespace-delimited string
 * (`loader.ts`'s `normalizeToolList`), so `skills:` is normalised the same way.
 */
describe('parseAgentFile — skills: frontmatter', () => {
  function agentFile(frontmatterLine: string): string {
    return `---\nname: reporter\ndescription: A reporter\n${frontmatterLine}\n---\n\nYou write reports.\n`;
  }

  it('keeps a YAML list as-is', () => {
    const parsed = parseAgentFile(agentFile('skills:\n  - weekly-report\n  - chart-builder'), '/a/AGENT.md');
    expect(parsed?.skills).toEqual(['weekly-report', 'chart-builder']);
  });

  it('keeps a flow-sequence list as-is', () => {
    const parsed = parseAgentFile(agentFile('skills: [weekly-report, chart-builder]'), '/a/AGENT.md');
    expect(parsed?.skills).toEqual(['weekly-report', 'chart-builder']);
  });

  it('normalises a single scalar into a one-element list instead of ignoring it', () => {
    const parsed = parseAgentFile(agentFile('skills: weekly-report'), '/a/AGENT.md');
    expect(parsed?.skills).toEqual(['weekly-report']);
  });

  it('normalises a whitespace-delimited scalar the way tools: does', () => {
    const parsed = parseAgentFile(agentFile('skills: weekly-report chart-builder'), '/a/AGENT.md');
    expect(parsed?.skills).toEqual(['weekly-report', 'chart-builder']);
  });

  it('drops non-string list entries rather than passing a number to the loader', () => {
    const parsed = parseAgentFile(agentFile('skills:\n  - weekly-report\n  - 42\n  - "  "'), '/a/AGENT.md');
    expect(parsed?.skills).toEqual(['weekly-report']);
  });

  it('leaves skills undefined when the field is absent, empty, or unusable', () => {
    expect(parseAgentFile(agentFile('model: sonnet'), '/a/AGENT.md')?.skills).toBeUndefined();
    expect(parseAgentFile(agentFile('skills: []'), '/a/AGENT.md')?.skills).toBeUndefined();
    expect(parseAgentFile(agentFile('skills: "   "'), '/a/AGENT.md')?.skills).toBeUndefined();
    expect(parseAgentFile(agentFile('skills: 42'), '/a/AGENT.md')?.skills).toBeUndefined();
  });
});
