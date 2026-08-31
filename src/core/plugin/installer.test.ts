import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(),
  exists: vi.fn(),
  readDir: vi.fn(),
}));

import { readTextFile, exists, readDir } from '@tauri-apps/plugin-fs';
import {
  readManifestFrom,
  resolveSourceDir,
  assertInsideDir,
  planInstall,
  installPlugin,
  UnsupportedSourceError,
  PluginSecurityError,
} from './installer';
import type { PluginSource } from './marketplace';

const mockRead = vi.mocked(readTextFile);
const mockExists = vi.mocked(exists);
const mockReadDir = vi.mocked(readDir);

/** Register a virtual filesystem: path → file contents. Dirs are inferred. */
function mountFiles(files: Record<string, string>) {
  mockExists.mockImplementation(async (p) => {
    const path = String(p);
    return path in files || Object.keys(files).some((f) => f.startsWith(`${path}/`));
  });
  mockRead.mockImplementation(async (p) => {
    const path = String(p);
    if (!(path in files)) throw new Error(`ENOENT: ${path}`);
    return files[path];
  });
  mockReadDir.mockImplementation(async (p) => {
    const prefix = `${String(p)}/`;
    const names = new Set<string>();
    for (const f of Object.keys(files)) {
      if (!f.startsWith(prefix)) continue;
      names.add(f.slice(prefix.length).split('/')[0]);
    }
    return [...names].map((name) => ({
      name,
      isDirectory: !files[`${prefix}${name}`],
      isFile: Boolean(files[`${prefix}${name}`]),
      isSymlink: false,
    })) as never;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('assertInsideDir', () => {
  it('accepts a path inside the base', () => {
    expect(() => assertInsideDir('/m/p', '/m/p/skills/a')).not.toThrow();
  });

  it('rejects traversal out of the base', () => {
    // This is the hole flagged during Task 1 review: a manifest that lists
    // `../../etc/passwd.png` must never resolve outside its own package.
    expect(() => assertInsideDir('/m/p', '/m/p/../../etc/passwd')).toThrow(PluginSecurityError);
  });

  it('rejects a sibling directory that merely shares a name prefix', () => {
    expect(() => assertInsideDir('/m/p', '/m/pevil/x')).toThrow(PluginSecurityError);
  });

  it('accepts the base itself', () => {
    expect(() => assertInsideDir('/m/p', '/m/p')).not.toThrow();
  });
});

describe('resolveSourceDir', () => {
  const marketplaceDir = '/mkt';

  it('resolves a relative source against the marketplace directory', () => {
    const source: PluginSource = { kind: 'relative', path: './plugins/foo' };
    expect(resolveSourceDir(source, marketplaceDir)).toBe('/mkt/plugins/foo');
  });

  it('rejects a relative source that escapes the marketplace directory', () => {
    const source: PluginSource = { kind: 'relative', path: '../../../etc' };
    expect(() => resolveSourceDir(source, marketplaceDir)).toThrow(PluginSecurityError);
  });

  it('throws a typed error for url sources (git fetch not wired yet)', () => {
    const source: PluginSource = { kind: 'url', url: 'https://x/y.git', sha: 'abc' };
    expect(() => resolveSourceDir(source, marketplaceDir)).toThrow(UnsupportedSourceError);
  });

  it('throws a typed error for git-subdir sources', () => {
    const source: PluginSource = { kind: 'git-subdir', url: 'https://x/y.git', path: 'skills' };
    expect(() => resolveSourceDir(source, marketplaceDir)).toThrow(UnsupportedSourceError);
  });
});

describe('readManifestFrom', () => {
  it('prefers .abu-plugin over .claude-plugin', async () => {
    mountFiles({
      '/p/.abu-plugin/plugin.json': JSON.stringify({ name: 'abu-one' }),
      '/p/.claude-plugin/plugin.json': JSON.stringify({ name: 'claude-one' }),
    });
    const m = await readManifestFrom('/p');
    expect(m.name).toBe('abu-one');
  });

  it('falls back to .claude-plugin when .abu-plugin is absent', async () => {
    // The whole compatibility story rests on this fallback — both OpenAI's
    // Codex and Tencent's WorkBuddy do the same thing.
    mountFiles({ '/p/.claude-plugin/plugin.json': JSON.stringify({ name: 'claude-one' }) });
    const m = await readManifestFrom('/p');
    expect(m.name).toBe('claude-one');
  });

  it('throws when neither candidate exists', async () => {
    mountFiles({ '/p/README.md': 'hi' });
    await expect(readManifestFrom('/p')).rejects.toThrow();
  });

  it('throws when the manifest is malformed json', async () => {
    mountFiles({ '/p/.abu-plugin/plugin.json': '{ not json' });
    await expect(readManifestFrom('/p')).rejects.toThrow();
  });
});

describe('planInstall', () => {
  const entry = { name: 'weather', source: { kind: 'relative', path: './plugins/weather' } as PluginSource };

  it('reports the skills and MCP servers the plugin will contribute', async () => {
    mountFiles({
      '/mkt/plugins/weather/.abu-plugin/plugin.json': JSON.stringify({
        name: 'weather',
        version: '1.2.0',
        mcpServers: { forecast: { command: 'npx', args: ['-y', 'weather-mcp'] } },
        interface: { capabilities: ['reads your location'] },
      }),
      '/mkt/plugins/weather/skills/today/SKILL.md': '---\nname: today\n---\n',
    });
    const d = await planInstall({ marketplaceName: 'official', marketplaceDir: '/mkt', entry });
    expect(d.name).toBe('weather');
    expect(d.key).toBe('weather@official');
    expect(d.version).toBe('1.2.0');
    expect(d.skills).toEqual(['today']);
    expect(d.mcpServers).toEqual([
      { name: 'forecast', command: 'npx', args: ['-y', 'weather-mcp'], url: undefined },
    ]);
    expect(d.capabilities).toEqual(['reads your location']);
  });

  it('surfaces an empty payload rather than failing when the plugin ships nothing', async () => {
    mountFiles({ '/mkt/plugins/weather/.abu-plugin/plugin.json': JSON.stringify({ name: 'weather' }) });
    const d = await planInstall({ marketplaceName: 'official', marketplaceDir: '/mkt', entry });
    expect(d.skills).toEqual([]);
    expect(d.mcpServers).toEqual([]);
  });

  it('rejects a manifest whose name disagrees with the marketplace entry', async () => {
    // Otherwise a marketplace could advertise `weather` and ship `keylogger`,
    // and the disclosure the user approved would describe the wrong package.
    mountFiles({
      '/mkt/plugins/weather/.abu-plugin/plugin.json': JSON.stringify({ name: 'keylogger' }),
    });
    await expect(
      planInstall({ marketplaceName: 'official', marketplaceDir: '/mkt', entry }),
    ).rejects.toThrow(PluginSecurityError);
  });
});

describe('installPlugin', () => {
  const entry = { name: 'weather', source: { kind: 'relative', path: './plugins/weather' } as PluginSource };

  beforeEach(() => {
    mountFiles({
      '/mkt/plugins/weather/.abu-plugin/plugin.json': JSON.stringify({
        name: 'weather',
        version: '1.2.0',
        mcpServers: { forecast: { command: 'npx' } },
      }),
      '/mkt/plugins/weather/skills/today/SKILL.md': '---\nname: today\n---\n',
    });
  });

  it('copies the package into place and records what it contributed', async () => {
    const copyDir = vi.fn(async () => {});
    const record = await installPlugin({
      home: '/home/u',
      marketplaceName: 'official',
      marketplaceDir: '/mkt',
      entry,
      copyDir,
    });

    expect(copyDir).toHaveBeenCalledWith(
      '/mkt/plugins/weather',
      '/home/u/.abu/plugin-packages/official/weather/1.2.0',
    );
    expect(record.key).toBe('weather@official');
    // The contributed list is what makes uninstall correct — it must never be
    // re-derived by scanning directories after the fact.
    expect(record.contributed).toEqual({ skills: ['today'], mcpServers: ['forecast'] });
    expect(record.installedAt).toBeTruthy();
  });

  it('does not record an install when the copy fails', async () => {
    const copyDir = vi.fn(async () => {
      throw new Error('disk full');
    });
    await expect(
      installPlugin({ home: '/home/u', marketplaceName: 'official', marketplaceDir: '/mkt', entry, copyDir }),
    ).rejects.toThrow('disk full');
  });

  it('uses "0.0.0" as the install directory when the manifest omits a version', async () => {
    mountFiles({ '/mkt/plugins/weather/.abu-plugin/plugin.json': JSON.stringify({ name: 'weather' }) });
    const copyDir = vi.fn(async () => {});
    await installPlugin({ home: '/home/u', marketplaceName: 'official', marketplaceDir: '/mkt', entry, copyDir });
    expect(copyDir).toHaveBeenCalledWith(
      '/mkt/plugins/weather',
      '/home/u/.abu/plugin-packages/official/weather/0.0.0',
    );
  });
});
