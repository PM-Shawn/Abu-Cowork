import { describe, expect, it } from 'vitest';
import { readAgentIdentity, wantedAgentIdentity, withAgentIdentity, type CarriedIdentity } from '@/core/agent/agentIdentityCarry';
import { parseAgentFile } from '@/core/agent/registry';

/**
 * `role-id` and `created` are the two identity fields of an AGENT.md that no
 * writer other than their owners may set: `role-id` is minted only by
 * ensureRoleId (first team membership), `created` is stamped once when the
 * agent is first written. A write path that takes whole-file content from a
 * model (save_agent) routes it through `withAgentIdentity` so the model can
 * neither drop nor invent them.
 *
 * Identity is asserted with the registry's own reader (`parseAgentFile`), not
 * with this module's: the registry is what decides which identity an agent
 * has, and the two readings can differ (CRLF, alias and merge keys).
 */

const NOW = 1757570400000;
const AGENT_PATH = '/Users/tester/.abu/agents/reviewer/AGENT.md';
const EXISTING: CarriedIdentity = { roleId: 'role-abc123', createdAt: 1700000000000 };

/** Identity as the registry reads it; null when the registry cannot load the file. */
function registryIdentity(md: string): CarriedIdentity | null {
  const agent = parseAgentFile(md, AGENT_PATH);
  return agent ? { roleId: agent.roleId, createdAt: agent.createdAt } : null;
}

describe('readAgentIdentity', () => {
  it('returns nothing for a missing file', () => {
    expect(readAgentIdentity(null)).toEqual({});
  });

  it('reads role-id and created from the frontmatter', () => {
    const raw = '---\nname: reviewer\nrole-id: role-abc123\ncreated: 1700000000000\n---\n\nYou review code.';
    expect(readAgentIdentity(raw)).toEqual(EXISTING);
    expect(registryIdentity(raw)).toEqual(EXISTING);
  });

  it('reads CRLF frontmatter, identity on the last line included', () => {
    const raw = '---\r\nname: reviewer\r\nrole-id: role-abc123\r\ncreated: 1700000000000\r\n---\r\n\r\nBody';
    expect(readAgentIdentity(raw)).toEqual(EXISTING);
    expect(registryIdentity(raw)).toEqual(EXISTING);
  });

  it('reads the object the registry reads — alias and merge keys resolved', () => {
    for (const raw of [
      '---\nname: reviewer\nk: &k role-id\n*k : role-victim\n---\nBody',
      '---\nname: reviewer\n!!merge <<: { role-id: role-victim }\n---\nBody',
    ]) {
      expect(readAgentIdentity(raw), raw).toEqual({ roleId: 'role-victim' });
      expect(registryIdentity(raw), raw).toEqual({ roleId: 'role-victim', createdAt: undefined });
    }
  });

  it('treats absent, empty or mistyped values as absent', () => {
    expect(readAgentIdentity('---\nname: legacy\n---\nBody')).toEqual({});
    expect(readAgentIdentity("---\nname: x\nrole-id: ''\ncreated: soon\n---\nBody")).toEqual({});
    expect(readAgentIdentity('---\nname: x\nrole-id: 42\ncreated: [1]\n---\nBody')).toEqual({});
  });

  it('returns nothing for content without frontmatter, even a prompt line that looks like a key', () => {
    expect(readAgentIdentity('just a prompt')).toEqual({});
    expect(readAgentIdentity('role-id: role-in-prose\ncreated: 1')).toEqual({});
  });

  describe('existing file whose YAML no longer parses', () => {
    // It may have joined a team before it broke; the next "fix it" save must
    // not lose the id every membership points at.
    it('salvages role-id and created from their top-level lines', () => {
      const raw = '---\nname: reviewer\nrole-id: role-abc123\ncreated: 1700000000000\ntools: [read_file\n---\nBody';
      expect(registryIdentity(raw)).toBeNull();
      expect(readAgentIdentity(raw)).toEqual(EXISTING);
    });

    it('salvages a quoted role-id and a CRLF file', () => {
      const raw = '---\r\nname: [broken\r\nrole-id: "role-abc123"   # team\r\ncreated: 1700000000000\r\n---\r\nBody';
      expect(readAgentIdentity(raw)).toEqual(EXISTING);
    });

    it('salvages from a file whose closing fence is gone', () => {
      expect(readAgentIdentity('---\nname: reviewer\nrole-id: role-abc123\nYou review code.')).toEqual({ roleId: 'role-abc123' });
    });

    it('salvages only top-level lines, and nothing when there is nothing to salvage', () => {
      expect(readAgentIdentity('---\nname: [unclosed\n---\nBody')).toEqual({});
      expect(readAgentIdentity('---\nname: [unclosed\nnested:\n  role-id: role-x\n---\nBody')).toEqual({});
    });

    it('does not salvage from the prompt of a file whose frontmatter is intact but broken', () => {
      expect(readAgentIdentity('---\nname: [unclosed\n---\nrole-id: role-in-prose\n')).toEqual({});
    });
  });
});

describe('wantedAgentIdentity', () => {
  it('stamps a new agent now and gives it no role-id', () => {
    expect(wantedAgentIdentity(null, NOW)).toEqual({ createdAt: NOW });
  });

  it('carries an existing agent as it is, stamp or no stamp', () => {
    expect(wantedAgentIdentity(EXISTING, NOW)).toEqual(EXISTING);
    expect(wantedAgentIdentity({ roleId: 'role-abc123' }, NOW)).toEqual({ roleId: 'role-abc123' });
    expect(wantedAgentIdentity({}, NOW)).toEqual({});
  });
});

describe('withAgentIdentity', () => {
  describe('brand-new agent (no existing file)', () => {
    it('stamps created with now', () => {
      const content = '---\nname: fresh\ndescription: New one\n---\n\nPrompt';
      const out = withAgentIdentity(content, null, NOW);
      expect(out).toBe(`---\nname: fresh\ndescription: New one\ncreated: ${NOW}\n---\n\nPrompt`);
      expect(registryIdentity(out)).toEqual({ createdAt: NOW });
    });

    it('removes a role-id the model invented (ids are minted only on first team membership)', () => {
      const content = '---\nname: fresh\nrole-id: role-made-up\ndescription: New one\n---\n\nPrompt';
      const out = withAgentIdentity(content, null, NOW);
      expect(out).toBe(`---\nname: fresh\ndescription: New one\ncreated: ${NOW}\n---\n\nPrompt`);
      expect(registryIdentity(out)).toEqual({ createdAt: NOW });
    });

    it('replaces a created stamp the model wrote with now, in place', () => {
      const content = '---\nname: fresh\ncreated: 5\ndescription: New one\n---\n\nPrompt';
      const out = withAgentIdentity(content, null, NOW);
      expect(out).toBe(`---\nname: fresh\ncreated: ${NOW}\ndescription: New one\n---\n\nPrompt`);
      expect(registryIdentity(out)).toEqual({ createdAt: NOW });
    });
  });

  describe('overwriting an existing agent', () => {
    it('restores both fields when the model dropped them', () => {
      const content = '---\nname: reviewer\ndescription: Improved\n---\n\nBetter prompt';
      const out = withAgentIdentity(content, EXISTING, NOW);
      expect(out).toBe('---\nname: reviewer\ndescription: Improved\nrole-id: role-abc123\ncreated: 1700000000000\n---\n\nBetter prompt');
      expect(registryIdentity(out)).toEqual(EXISTING);
    });

    it('forces both fields back to the existing values when the model wrote different ones', () => {
      const content = '---\nname: reviewer\nrole-id: role-other\ncreated: 1\ndescription: Improved\n---\n\nBetter prompt';
      const out = withAgentIdentity(content, EXISTING, NOW);
      expect(out).toBe('---\nname: reviewer\nrole-id: role-abc123\ncreated: 1700000000000\ndescription: Improved\n---\n\nBetter prompt');
      expect(registryIdentity(out)).toEqual(EXISTING);
    });

    it('leaves content that already carries the right identity byte-identical, however it is spelled', () => {
      const content = '---\nname: reviewer\nrole-id: "role-abc123"   # team id\ncreated: 1700000000000\n---\n\nPrompt';
      expect(withAgentIdentity(content, EXISTING, NOW)).toBe(content);
      expect(registryIdentity(content)).toEqual(EXISTING);
    });

    it('keeps a legacy agent (no created stamp) unstamped — stamping on edit would falsely mark it newest', () => {
      const content = '---\nname: legacy\ndescription: Improved\n---\n\nPrompt';
      expect(withAgentIdentity(content, {}, NOW)).toBe(content);
      expect(registryIdentity(content)).toEqual({});
    });

    it('removes a created stamp the model wrote for a legacy agent', () => {
      const content = '---\nname: legacy\ncreated: 1757000000000\ndescription: Improved\n---\n\nPrompt';
      const out = withAgentIdentity(content, {}, NOW);
      expect(out).toBe('---\nname: legacy\ndescription: Improved\n---\n\nPrompt');
      expect(registryIdentity(out)).toEqual({});
    });

    it('carries a role-id on a legacy agent that has one but no created stamp', () => {
      const out = withAgentIdentity('---\nname: legacy\n---\n\nPrompt', { roleId: 'role-abc123' }, NOW);
      expect(out).toBe('---\nname: legacy\nrole-id: role-abc123\n---\n\nPrompt');
      expect(registryIdentity(out)).toEqual({ roleId: 'role-abc123' });
    });

    it('removes a last-line identity key without leaving a blank line behind', () => {
      const out = withAgentIdentity('---\nname: legacy\ncreated: 99\n---\n\nPrompt', {}, NOW);
      expect(out).toBe('---\nname: legacy\n---\n\nPrompt');
      expect(registryIdentity(out)).toEqual({});
    });

    it('rewrites an explicit (? key) role-id as a plain key', () => {
      const out = withAgentIdentity('---\nname: reviewer\n? role-id\n: role-other\n---\nP', EXISTING, NOW);
      expect(out).toBe('---\nname: reviewer\nrole-id: role-abc123\ncreated: 1700000000000\n---\nP');
      expect(registryIdentity(out)).toEqual(EXISTING);
    });
  });

  it('preserves every other key, comment and formatting byte-for-byte', () => {
    const head = [
      '# Written by Abu',
      'name: reviewer',
      'description: "A very long description that runs well past eighty characters so a re-serializer would fold it"',
      'tools:',
      '- read_file',
      '- write_file   # keep this spacing',
      'flow: [a,  b]',
      "category: 'code'   # quoted",
    ].join('\n');
    const tail = [
      'intro: |',
      '  line one',
      '  line two',
      '',
      '# trailing comment',
      'tags: [x]',
    ].join('\n');
    const content = `---\n${head}\nrole-id: role-invented\n${tail}\n---\n\nrole-id: not-frontmatter\n---\nBody after a rule`;
    const out = withAgentIdentity(content, EXISTING, NOW);
    expect(out).toBe(
      `---\n${head}\nrole-id: role-abc123\n${tail}\ncreated: 1700000000000\n---\n\nrole-id: not-frontmatter\n---\nBody after a rule`,
    );
    expect(registryIdentity(out)).toEqual(EXISTING);
  });

  it('rewrites only the identity key\'s own lines, not the comment lines after it', () => {
    // An empty value's yaml node runs on over the comment below it; only the
    // value's own text may be replaced.
    const content = '---\nname: a\nrole-id:\n# about the description\ndescription: y\ncreated: |\n  5\n# tail\n---\nP';
    const out = withAgentIdentity(content, { roleId: 'role-abc123' }, NOW);
    expect(out).toBe('---\nname: a\nrole-id: role-abc123\n# about the description\ndescription: y\n# tail\n---\nP');
    expect(registryIdentity(out)).toEqual({ roleId: 'role-abc123' });
  });

  it('keeps CRLF line endings, in place and for an added key — and the registry reads them back clean', () => {
    const content = '---\r\nname: reviewer\r\nrole-id: role-other\r\ndescription: Improved\r\n---\r\n\r\nPrompt\r\n';
    const out = withAgentIdentity(content, EXISTING, NOW);
    expect(out).toBe(
      '---\r\nname: reviewer\r\nrole-id: role-abc123\r\ndescription: Improved\r\ncreated: 1700000000000\r\n---\r\n\r\nPrompt\r\n',
    );
    expect(registryIdentity(out)).toEqual(EXISTING);
  });

  it('keeps the indentation of an indented top-level map', () => {
    const out = withAgentIdentity('---\n  name: fresh\n  role-id: role-made-up\n---\nPrompt', null, NOW);
    expect(out).toBe(`---\n  name: fresh\n  created: ${NOW}\n---\nPrompt`);
    expect(registryIdentity(out)).toEqual({ createdAt: NOW });
  });

  it('quotes a carried role-id that would not survive as a plain scalar', () => {
    const out = withAgentIdentity('---\nname: reviewer\n---\nPrompt', { roleId: 'role: odd #id' }, NOW);
    expect(registryIdentity(out)).toEqual({ roleId: 'role: odd #id' });
  });

  it('enforces identity on a flow-style frontmatter map too', () => {
    const out = withAgentIdentity('---\n{ name: fresh, role-id: role-made-up }\n---\nPrompt', null, NOW);
    expect(registryIdentity(out)).toEqual({ createdAt: NOW });
    expect(out.endsWith('\n---\nPrompt')).toBe(true);
  });

  // The helper edits the YAML it can see; these shapes read differently as a
  // JS object, so the result does NOT carry the wanted identity. The caller
  // (save_agent) detects exactly that with parseAgentFile and refuses to write.
  it('cannot see an alias key — the registry reading disagrees, which the caller must catch', () => {
    const out = withAgentIdentity('---\nname: fresh\nk: &k role-id\n*k : role-victim\n---\nP', null, NOW);
    expect(registryIdentity(out)).not.toEqual(wantedAgentIdentity(null, NOW));
  });

  it('returns content without frontmatter unchanged (the registry cannot load it either)', () => {
    expect(withAgentIdentity('role-id: x\nJust a prompt', null, NOW)).toBe('role-id: x\nJust a prompt');
    expect(registryIdentity('role-id: x\nJust a prompt')).toBeNull();
  });

  it('returns content with unparseable frontmatter unchanged (the registry cannot load it either)', () => {
    const content = '---\nname: [unclosed\nrole-id: role-made-up\n---\nPrompt';
    expect(withAgentIdentity(content, null, NOW)).toBe(content);
    expect(registryIdentity(content)).toBeNull();
  });
});
