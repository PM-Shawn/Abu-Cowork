import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseAgentFile, serializeAgentMd } from './registry';

/**
 * `name:` frontmatter is one plain path segment. The registry also scans
 * `.abu/agents` in whatever directory Abu runs from — possibly a cloned
 * repository — and an agent's name is its folder under `~/.abu/agents/`, where
 * `joinPath` does not collapse `..`. A name that is not one segment is refused
 * at parse time, loudly enough that the author can find the file.
 */
describe('parseAgentFile — name: must be one plain path segment', () => {
  const filePath = '/repo/.abu/agents/x/AGENT.md';
  function agentFile(nameLine: string): string {
    return `---\n${nameLine}\ndescription: An agent\n---\n\nYou help.\n`;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['', 'empty'],
    [' ', 'blank'],
    ['.', 'the current directory'],
    ['..', 'the parent directory'],
    ['...', 'only dots'],
    ['../../evil', 'climbs out of ~/.abu/agents'],
    ['a/b', 'a nested path'],
    ['/etc', 'absolute'],
    ['..\\..\\evil', 'the Windows spelling of the same escape'],
    ['C:\\x', 'a Windows absolute path'],
    ['evil\u0000name', 'NUL'],
    ['evil\u0001name', 'a C0 control character'],
    ['evil\u0085name', 'NEL, a C1 control character'],
    ['a\nb', 'an interior newline'],
    [' evil', 'leading whitespace'],
    ['evil ', 'trailing whitespace'],
    ['evil\t', 'a trailing tab'],
  ])('refuses %j (%s) and warns naming the file', (name) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseAgentFile(agentFile(`name: ${JSON.stringify(name)}`), filePath)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    const text = warn.mock.calls[0].join(' ');
    expect(text).toContain(filePath);
    expect(text).toContain(JSON.stringify(name));
  });

  it.each(['产品经理', 'HR 招聘官', '数据分析师', 'code-reviewer', 'QA_bot', 'skill.v2', 'abu'])(
    'accepts %j without a warning',
    (name) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(parseAgentFile(agentFile(`name: ${JSON.stringify(name)}`), filePath)?.name).toBe(name);
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['description: only', 'no name key'],
    ['name:', 'a null name'],
    ['name: 42', 'a number'],
    ['name: [a, b]', 'a list'],
  ])('returns null without a warning for %j (%s)', (nameLine) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseAgentFile(agentFile(nameLine), filePath)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});

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

/**
 * Line endings. An AGENT.md saved on Windows (or by a model that writes CRLF)
 * ends every frontmatter line in `\r\n`. The fence regex used to stop at the
 * `\n` before the closing `---`, leaving a `\r` on the LAST frontmatter line —
 * so whatever key landed there read back as `"value\r"`: a role-id that no
 * team membership matches, a `created` stamp that is a string.
 */
describe('parseAgentFile — CRLF frontmatter', () => {
  it('reads the last frontmatter line without a trailing \\r', () => {
    const raw = '---\r\nname: reviewer\r\ncreated: 1700000000000\r\nrole-id: role-abc123\r\n---\r\n\r\nYou review code.\r\n';
    const parsed = parseAgentFile(raw, '/a/AGENT.md');
    expect(parsed?.roleId).toBe('role-abc123');
    expect(parsed?.systemPrompt).toBe('You review code.');
  });

  it('reads a created stamp on the last line as a number', () => {
    const raw = '---\r\nname: reviewer\r\nrole-id: role-abc123\r\ncreated: 1700000000000\r\n---\r\n\r\nYou review code.';
    const parsed = parseAgentFile(raw, '/a/AGENT.md');
    expect(parsed?.createdAt).toBe(1700000000000);
    expect(parsed?.roleId).toBe('role-abc123');
  });

  it('still reads LF frontmatter, blank lines around the fences included', () => {
    const raw = '---\n\nname: reviewer\nrole-id: role-abc123\n---\n\n\nYou review code.';
    const parsed = parseAgentFile(raw, '/a/AGENT.md');
    expect(parsed?.name).toBe('reviewer');
    expect(parsed?.roleId).toBe('role-abc123');
    expect(parsed?.systemPrompt).toBe('You review code.');
  });

  it('keeps a --- rule inside the prompt as prompt', () => {
    const raw = '---\r\nname: reviewer\r\n---\r\nIntro\r\n---\r\nMore';
    expect(parseAgentFile(raw, '/a/AGENT.md')?.systemPrompt).toBe('Intro\r\n---\r\nMore');
  });
});
