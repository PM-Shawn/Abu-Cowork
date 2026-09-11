import { describe, expect, it } from 'vitest';
import { readAgentIdentity, withAgentIdentity } from '@/core/agent/agentIdentityCarry';

/**
 * `role-id` and `created` are the two identity fields of an AGENT.md that no
 * writer other than their owners may set: `role-id` is minted only by
 * ensureRoleId (first team membership), `created` is stamped once when the
 * agent is first written. A write path that takes whole-file content from a
 * model (save_agent) routes it through `withAgentIdentity` so the model can
 * neither drop nor invent them.
 */

const NOW = 1757570400000;

describe('readAgentIdentity', () => {
  it('returns nothing for a missing file', () => {
    expect(readAgentIdentity(null)).toEqual({});
  });

  it('reads role-id and created from the frontmatter', () => {
    const raw = '---\nname: reviewer\nrole-id: role-abc123\ncreated: 1700000000000\n---\n\nYou review code.';
    expect(readAgentIdentity(raw)).toEqual({ roleId: 'role-abc123', createdAt: 1700000000000 });
  });

  it('reads CRLF frontmatter', () => {
    const raw = '---\r\nname: reviewer\r\nrole-id: role-abc123\r\ncreated: 1700000000000\r\n---\r\n\r\nBody';
    expect(readAgentIdentity(raw)).toEqual({ roleId: 'role-abc123', createdAt: 1700000000000 });
  });

  it('treats absent, empty or mistyped values as absent', () => {
    expect(readAgentIdentity('---\nname: legacy\n---\nBody')).toEqual({});
    expect(readAgentIdentity("---\nname: x\nrole-id: ''\ncreated: soon\n---\nBody")).toEqual({});
    expect(readAgentIdentity('---\nname: x\nrole-id: 42\ncreated: [1]\n---\nBody')).toEqual({});
  });

  it('returns nothing for content without frontmatter or with unparseable frontmatter', () => {
    expect(readAgentIdentity('just a prompt')).toEqual({});
    expect(readAgentIdentity('---\nname: [unclosed\n---\nBody')).toEqual({});
  });
});

describe('withAgentIdentity', () => {
  describe('brand-new agent (no existing file)', () => {
    it('stamps created with now', () => {
      const content = '---\nname: fresh\ndescription: New one\n---\n\nPrompt';
      expect(withAgentIdentity(content, null, NOW)).toBe(
        `---\nname: fresh\ndescription: New one\ncreated: ${NOW}\n---\n\nPrompt`,
      );
    });

    it('removes a role-id the model invented (ids are minted only on first team membership)', () => {
      const content = '---\nname: fresh\nrole-id: role-made-up\ndescription: New one\n---\n\nPrompt';
      expect(withAgentIdentity(content, null, NOW)).toBe(
        `---\nname: fresh\ndescription: New one\ncreated: ${NOW}\n---\n\nPrompt`,
      );
    });

    it('replaces a created stamp the model wrote with now, in place', () => {
      const content = '---\nname: fresh\ncreated: 5\ndescription: New one\n---\n\nPrompt';
      expect(withAgentIdentity(content, null, NOW)).toBe(
        `---\nname: fresh\ncreated: ${NOW}\ndescription: New one\n---\n\nPrompt`,
      );
    });
  });

  describe('overwriting an existing agent', () => {
    const existing = { roleId: 'role-abc123', createdAt: 1700000000000 };

    it('restores both fields when the model dropped them', () => {
      const content = '---\nname: reviewer\ndescription: Improved\n---\n\nBetter prompt';
      expect(withAgentIdentity(content, existing, NOW)).toBe(
        '---\nname: reviewer\ndescription: Improved\nrole-id: role-abc123\ncreated: 1700000000000\n---\n\nBetter prompt',
      );
    });

    it('forces both fields back to the existing values when the model wrote different ones', () => {
      const content = '---\nname: reviewer\nrole-id: role-other\ncreated: 1\ndescription: Improved\n---\n\nBetter prompt';
      expect(withAgentIdentity(content, existing, NOW)).toBe(
        '---\nname: reviewer\nrole-id: role-abc123\ncreated: 1700000000000\ndescription: Improved\n---\n\nBetter prompt',
      );
    });

    it('leaves content that already carries the right identity byte-identical, however it is spelled', () => {
      const content = '---\nname: reviewer\nrole-id: "role-abc123"   # team id\ncreated: 1700000000000\n---\n\nPrompt';
      expect(withAgentIdentity(content, existing, NOW)).toBe(content);
    });

    it('keeps a legacy agent (no created stamp) unstamped — stamping on edit would falsely mark it newest', () => {
      const content = '---\nname: legacy\ndescription: Improved\n---\n\nPrompt';
      expect(withAgentIdentity(content, {}, NOW)).toBe(content);
    });

    it('removes a created stamp the model wrote for a legacy agent', () => {
      const content = '---\nname: legacy\ncreated: 1757000000000\ndescription: Improved\n---\n\nPrompt';
      expect(withAgentIdentity(content, {}, NOW)).toBe('---\nname: legacy\ndescription: Improved\n---\n\nPrompt');
    });

    it('carries a role-id on a legacy agent that has one but no created stamp', () => {
      const content = '---\nname: legacy\n---\n\nPrompt';
      expect(withAgentIdentity(content, { roleId: 'role-abc123' }, NOW)).toBe(
        '---\nname: legacy\nrole-id: role-abc123\n---\n\nPrompt',
      );
    });

    it('removes a last-line identity key without leaving a blank line behind', () => {
      const content = '---\nname: legacy\ncreated: 99\n---\n\nPrompt';
      expect(withAgentIdentity(content, {}, NOW)).toBe('---\nname: legacy\n---\n\nPrompt');
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
    expect(withAgentIdentity(content, { roleId: 'role-abc123', createdAt: 1700000000000 }, NOW)).toBe(
      `---\n${head}\nrole-id: role-abc123\n${tail}\ncreated: 1700000000000\n---\n\nrole-id: not-frontmatter\n---\nBody after a rule`,
    );
  });

  it('rewrites only the identity key\'s own lines, not the comment lines after it', () => {
    // An empty value's yaml node runs on over the comment below it; only the
    // value's own text may be replaced.
    const content = '---\nname: a\nrole-id:\n# about the description\ndescription: y\ncreated: |\n  5\n# tail\n---\nP';
    expect(withAgentIdentity(content, { roleId: 'role-abc123' }, NOW)).toBe(
      '---\nname: a\nrole-id: role-abc123\n# about the description\ndescription: y\n# tail\n---\nP',
    );
  });

  it('keeps CRLF line endings, in place and for an added key', () => {
    const content = '---\r\nname: reviewer\r\nrole-id: role-other\r\ndescription: Improved\r\n---\r\n\r\nPrompt\r\n';
    expect(withAgentIdentity(content, { roleId: 'role-abc123', createdAt: 1700000000000 }, NOW)).toBe(
      '---\r\nname: reviewer\r\nrole-id: role-abc123\r\ndescription: Improved\r\ncreated: 1700000000000\r\n---\r\n\r\nPrompt\r\n',
    );
  });

  it('keeps the indentation of an indented top-level map', () => {
    const content = '---\n  name: fresh\n  role-id: role-made-up\n---\nPrompt';
    expect(withAgentIdentity(content, null, NOW)).toBe(`---\n  name: fresh\n  created: ${NOW}\n---\nPrompt`);
  });

  it('quotes a carried role-id that would not survive as a plain scalar', () => {
    const content = '---\nname: reviewer\n---\nPrompt';
    const out = withAgentIdentity(content, { roleId: 'role: odd #id' }, NOW);
    expect(readAgentIdentity(out)).toEqual({ roleId: 'role: odd #id' });
  });

  it('enforces identity on a flow-style frontmatter map too', () => {
    const content = '---\n{ name: fresh, role-id: role-made-up }\n---\nPrompt';
    const out = withAgentIdentity(content, null, NOW);
    expect(readAgentIdentity(out)).toEqual({ createdAt: NOW });
    expect(out).toMatch(/name: fresh/);
    expect(out.endsWith('\n---\nPrompt')).toBe(true);
  });

  it('returns content without frontmatter unchanged', () => {
    expect(withAgentIdentity('role-id: x\nJust a prompt', null, NOW)).toBe('role-id: x\nJust a prompt');
  });

  it('returns content with unparseable frontmatter unchanged', () => {
    const content = '---\nname: [unclosed\nrole-id: role-made-up\n---\nPrompt';
    expect(withAgentIdentity(content, null, NOW)).toBe(content);
  });
});
