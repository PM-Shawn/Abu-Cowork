import { describe, it, expect } from 'vitest';
import { parseAgentFile, serializeAgentMd } from './registry';

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

/**
 * `source:` frontmatter — the one provenance key AGENT.md carries.
 *
 * It exists so the UI can say "this agent came from a plugin, so editing it is
 * pointless — the next plugin update overwrites it". That makes two properties
 * load-bearing: the value round-trips byte-for-byte through
 * parse → serialize (a plugin agent re-saved by the editor must not silently
 * lose its origin), and anything that is not `plugin:<something>` is IGNORED
 * rather than kept, so a malformed value can never make the UI assert an
 * origin nobody wrote.
 */
describe('parseAgentFile / serializeAgentMd — source: frontmatter', () => {
  function agentFile(frontmatterLine: string): string {
    return `---\nname: reviewer\ndescription: A reviewer\n${frontmatterLine}\n---\n\nYou review.\n`;
  }

  it('parses plugin:<key> into a structured source', () => {
    const parsed = parseAgentFile(agentFile('source: plugin:weather@official'), '/a/AGENT.md');
    expect(parsed?.source).toEqual({ kind: 'plugin', plugin: 'weather@official' });
  });

  it('keeps a key that itself contains @ and / (npm-scoped plugin names)', () => {
    const parsed = parseAgentFile(agentFile('source: "plugin:@scope/pack@official"'), '/a/AGENT.md');
    expect(parsed?.source).toEqual({ kind: 'plugin', plugin: '@scope/pack@official' });
  });

  it('ignores every value that is not plugin:<non-empty>', () => {
    for (const line of [
      'source: user',
      'source: "plugin:"',
      'source: "plugin:   "',
      'source: builtin:abu',
      'source: 42',
      'source:\n  kind: plugin\n  plugin: weather@official',
      'source: []',
    ]) {
      const parsed = parseAgentFile(agentFile(line), '/a/AGENT.md');
      // Ignored, never rejected: the agent itself is still perfectly usable.
      expect(parsed, line).not.toBeNull();
      expect(parsed?.source, line).toBeUndefined();
    }
  });

  it('round-trips through serializeAgentMd', () => {
    const parsed = parseAgentFile(agentFile('source: plugin:weather@official'), '/a/AGENT.md');
    const text = serializeAgentMd(parsed!, parsed!.systemPrompt);
    expect(text).toContain('source: plugin:weather@official');
    expect(parseAgentFile(text, '/a/AGENT.md')?.source).toEqual({
      kind: 'plugin',
      plugin: 'weather@official',
    });
  });

  it('writes no source key for an agent that has none', () => {
    const parsed = parseAgentFile(agentFile('model: sonnet'), '/a/AGENT.md');
    expect(serializeAgentMd(parsed!, parsed!.systemPrompt)).not.toContain('source:');
  });
});

describe('parseAgentFile / serializeAgentMd — role tool inheritance', () => {
  function agentFile(declaration: string): string {
    return `---\nname: specialist\ndescription: Help with the task\n${declaration}\n---\n\nComplete the requested work.\n`;
  }

  it.each([
    ['omitted constraints', ''],
    ['empty role lists', 'tools: []\ndisallowed-tools: []'],
  ])('round-trips %s without writing a tool boundary', (_label, declaration) => {
    const parsed = parseAgentFile(agentFile(declaration), '/a/AGENT.md');
    expect(parsed).not.toBeNull();

    const serialized = serializeAgentMd(parsed!, parsed!.systemPrompt);
    expect(serialized).not.toMatch(/^(?:tools|disallowed-tools):/m);
    const reloaded = parseAgentFile(serialized, '/a/AGENT.md');
    expect(reloaded).not.toBeNull();
    expect(reloaded?.tools).toBeUndefined();
    expect(reloaded?.disallowedTools).toBeUndefined();
    expect(reloaded?.systemPrompt).toBe(parsed?.systemPrompt);
  });

  it.each([
    {
      label: 'an explicit allowlist and denylist',
      declaration: 'tools: [read_file, "abu-browser__*", "run_command(npm run *)"]\ndisallowed-tools: ["abu-browser__click"]',
      tools: ['read_file', 'abu-browser__*', 'run_command(npm run *)'],
      disallowedTools: ['abu-browser__click'],
    },
    {
      label: 'an explicit denylist with inherited tools',
      declaration: 'disallowed-tools: [run_command]',
      tools: undefined,
      disallowedTools: ['run_command'],
    },
  ])('preserves $label through an editor save', ({ declaration, tools, disallowedTools }) => {
    const parsed = parseAgentFile(agentFile(declaration), '/a/AGENT.md');
    expect(parsed).toMatchObject({ tools, disallowedTools });

    const serialized = serializeAgentMd({ ...parsed!, description: 'Updated description' }, parsed!.systemPrompt);
    expect(parseAgentFile(serialized, '/a/AGENT.md')).toMatchObject({
      description: 'Updated description',
      tools,
      disallowedTools,
    });
  });
});
