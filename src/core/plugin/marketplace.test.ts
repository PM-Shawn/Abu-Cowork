import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  parseSource,
  parseMarketplace,
  resolveRename,
  MarketplaceParseError,
} from './marketplace';

describe('parseSource', () => {
  it('accepts a local source object using the existing relative source contract', () => {
    expect(parseSource({ source: 'local', path: './plugins/demo' })).toEqual({
      kind: 'relative', path: './plugins/demo',
    });
  });

  it.each([undefined, null, 42, '', '  '])('rejects an invalid local source path: %s', (path) => {
    expect(() => parseSource({ source: 'local', path })).toThrow(MarketplaceParseError);
  });

  it('parses a relative-path string source', () => {
    expect(parseSource('./plugins/agent-sdk-dev')).toEqual({
      kind: 'relative',
      path: './plugins/agent-sdk-dev',
    });
  });

  it('parses a url source object', () => {
    const raw = {
      source: 'url',
      url: 'https://github.com/SalesforceAIResearch/agentforce-adlc.git',
      sha: 'd16d14ac7f817336e21bf9392cf51b6cac6194d8',
    };
    expect(parseSource(raw)).toEqual({
      kind: 'url',
      url: raw.url,
      sha: raw.sha,
    });
  });

  it('parses a url source object without a sha', () => {
    const raw = {
      source: 'url',
      url: 'https://github.com/example/repo.git',
    };
    expect(parseSource(raw)).toEqual({
      kind: 'url',
      url: raw.url,
      sha: undefined,
    });
  });

  it('parses a git-subdir source object with all fields present', () => {
    const raw = {
      source: 'git-subdir',
      url: 'https://github.com/42Crunch-AI/claude-plugins.git',
      path: 'plugins/api-security-testing',
      ref: 'v1.5.5',
      sha: '30287f5e3f122a646d1ac5ca3ab96e130c52a3ad',
    };
    expect(parseSource(raw)).toEqual({
      kind: 'git-subdir',
      url: raw.url,
      path: raw.path,
      ref: raw.ref,
      sha: raw.sha,
    });
  });

  it('throws MarketplaceParseError for an unknown source discriminant', () => {
    expect(() => parseSource({ source: 'npm', url: 'x' })).toThrow(MarketplaceParseError);
  });

  it('throws MarketplaceParseError when source is missing', () => {
    expect(() => parseSource(undefined)).toThrow(MarketplaceParseError);
    expect(() => parseSource(null)).toThrow(MarketplaceParseError);
  });

  it('throws MarketplaceParseError when url source is missing the url field', () => {
    expect(() => parseSource({ source: 'url' })).toThrow(MarketplaceParseError);
  });

  it('throws MarketplaceParseError when git-subdir source is missing the path field', () => {
    expect(() =>
      parseSource({ source: 'git-subdir', url: 'https://github.com/x/y.git' }),
    ).toThrow(MarketplaceParseError);
  });
});

describe('resolveRename', () => {
  it('resolves an old name to its new name', () => {
    expect(resolveRename('adlc', { adlc: 'agentforce-adlc' })).toBe('agentforce-adlc');
  });

  it('returns the name unchanged when there is no mapping for it', () => {
    expect(resolveRename('unmapped-plugin', { adlc: 'agentforce-adlc' })).toBe(
      'unmapped-plugin',
    );
  });

  it('returns the name unchanged when renames is undefined', () => {
    expect(resolveRename('some-plugin', undefined)).toBe('some-plugin');
  });
});

describe('parseMarketplace', () => {
  it('loads the Codex local marketplace entry shape', () => {
    const result = parseMarketplace({
      name: 'local-repo',
      plugins: [{
        name: 'my-plugin',
        source: { source: 'local', path: './plugins/my-plugin' },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        category: 'Productivity',
      }],
    });
    expect(result.plugins[0].source).toEqual({ kind: 'relative', path: './plugins/my-plugin' });
  });

  const minimalValid = {
    name: 'test-marketplace',
    plugins: [
      {
        name: 'plugin-a',
        source: './plugins/plugin-a',
      },
    ],
  };

  it('parses a minimal valid marketplace', () => {
    const result = parseMarketplace(minimalValid);
    expect(result.name).toBe('test-marketplace');
    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0]).toMatchObject({
      name: 'plugin-a',
      source: { kind: 'relative', path: './plugins/plugin-a' },
    });
  });

  it('accepts an empty plugins array as valid', () => {
    const result = parseMarketplace({ name: 'empty-marketplace', plugins: [] });
    expect(result.plugins).toEqual([]);
  });

  it('throws MarketplaceParseError when top-level name is missing', () => {
    expect(() => parseMarketplace({ plugins: [] })).toThrow(MarketplaceParseError);
  });

  it('throws MarketplaceParseError when top-level plugins is missing', () => {
    expect(() => parseMarketplace({ name: 'no-plugins' })).toThrow(MarketplaceParseError);
  });

  it('throws MarketplaceParseError, including the offending plugin name, when a plugin entry is invalid', () => {
    let caught: unknown;
    try {
      parseMarketplace({
        name: 'bad-marketplace',
        plugins: [
          { name: 'good-plugin', source: './plugins/good-plugin' },
          { name: 'bad-plugin', source: { source: 'npm' } },
        ],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MarketplaceParseError);
    expect((caught as MarketplaceParseError).message).toContain('bad-plugin');
  });

  it('throws MarketplaceParseError, including the offending index, when an invalid plugin entry has no name', () => {
    let caught: unknown;
    try {
      parseMarketplace({
        name: 'bad-marketplace',
        plugins: [{ source: { source: 'npm' } }],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MarketplaceParseError);
    expect((caught as MarketplaceParseError).message).toContain('0');
  });

  it('supports author as a plain string', () => {
    const result = parseMarketplace({
      name: 'm',
      plugins: [{ name: 'p', source: './p', author: 'Jane Doe' }],
    });
    expect(result.plugins[0].author).toBe('Jane Doe');
  });

  it('supports author as an object with name and email', () => {
    const result = parseMarketplace({
      name: 'm',
      plugins: [
        { name: 'p', source: './p', author: { name: 'Jane Doe', email: 'jane@example.com' } },
      ],
    });
    expect(result.plugins[0].author).toEqual({ name: 'Jane Doe', email: 'jane@example.com' });
  });

  it('preserves renames on the parsed marketplace', () => {
    const result = parseMarketplace({
      name: 'm',
      plugins: [],
      renames: { adlc: 'agentforce-adlc' },
    });
    expect(result.renames).toEqual({ adlc: 'agentforce-adlc' });
  });

  it('retains unknown top-level and plugin-level fields without throwing', () => {
    const result = parseMarketplace({
      $schema: 'https://example.com/schema.json',
      name: 'm',
      metadata: { generatedAt: '2026-08-31' },
      strict: true,
      plugins: [
        {
          name: 'p',
          source: './p',
          lspServers: { typescript: {} },
          skills: ['skill-one'],
        },
      ],
    });
    expect(result.name).toBe('m');
    expect((result as unknown as Record<string, unknown>).metadata).toEqual({
      generatedAt: '2026-08-31',
    });
    expect((result.plugins[0] as unknown as Record<string, unknown>).lspServers).toEqual({
      typescript: {},
    });
  });

  const realMarketplacePath = join(
    homedir(),
    '.claude/plugins/marketplaces/claude-plugins-official/.claude-plugin/marketplace.json',
  );
  const hasRealMarketplace = existsSync(realMarketplacePath);

  (hasRealMarketplace ? it : it.skip)(
    'parses the real claude-plugins-official marketplace.json end to end',
    () => {
      const raw = JSON.parse(readFileSync(realMarketplacePath, 'utf-8'));
      const result = parseMarketplace(raw);
      expect(result.plugins.length).toBeGreaterThan(200);
    },
  );
});
