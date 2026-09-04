import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(),
  readDir: vi.fn(),
  // `planInstall` scans for symlinks through `fsOps`, which imports the write
  // half of this module too. Mocked here so the binding exists; only the
  // real-tree suite at the bottom gives them an implementation.
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  remove: vi.fn(),
  lstat: vi.fn(),
}));

import {
  readTextFile,
  readDir,
  readFile,
  writeFile,
  mkdir,
  lstat,
} from '@tauri-apps/plugin-fs';
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
import { copyPluginDir, PluginPackageNotFoundError, PluginSymlinkRootError } from './fsOps';

const mockRead = vi.mocked(readTextFile);
const mockReadDir = vi.mocked(readDir);

/**
 * Register a virtual filesystem: path → file contents. Dirs are inferred.
 *
 * No `exists` here on purpose — every scan now walks `readDir` listings, which
 * is the only call that reports whether an entry is a link.
 */
function mountFiles(files: Record<string, string>) {
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
  // Virtual trees have no links; the real-tree suites below override this.
  vi.mocked(lstat).mockResolvedValue({ isSymlink: false } as never);
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

  it('throws when no candidate exists', async () => {
    mountFiles({ '/p/README.md': 'hi' });
    await expect(readManifestFrom('/p')).rejects.toThrow();
  });

  it('throws when the manifest is malformed json', async () => {
    mountFiles({ '/p/.abu-plugin/plugin.json': '{ not json' });
    await expect(readManifestFrom('/p')).rejects.toThrow();
  });

  it('falls back to .codex-plugin/plugin.json (Codex ecosystem)', async () => {
    mountFiles({ '/p/.codex-plugin/plugin.json': JSON.stringify({ name: 'x', version: '1.0.0' }) });
    const m = await readManifestFrom('/p');
    expect(m.name).toBe('x');
  });

  it('prefers .claude-plugin over .codex-plugin when both are present', async () => {
    // Candidate order is Abu → Claude → Codex; the first hit wins.
    mountFiles({
      '/p/.claude-plugin/plugin.json': JSON.stringify({ name: 'a' }),
      '/p/.codex-plugin/plugin.json': JSON.stringify({ name: 'b' }),
    });
    const m = await readManifestFrom('/p');
    expect(m.name).toBe('a');
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
    const { record, mcpServers } = await installPlugin({
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
    // The outcome also carries the mcp specs (for registration) out of the one
    // planInstall, so no caller has to re-plan.
    expect(mcpServers).toEqual([{ name: 'forecast', command: 'npx', args: undefined, url: undefined }]);
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

  it('records how the plugin was sourced, so "mine" can be told from "installed"', async () => {
    const copyDir = vi.fn(async () => {});
    const { record } = await installPlugin({
      home: '/home/u',
      marketplaceName: 'official',
      marketplaceDir: '/mkt',
      entry,
      copyDir,
    });
    expect(record.sourceKind).toBe('relative');
  });

  it('records the caller-supplied checksum on the install record', async () => {
    const copyDir = vi.fn(async () => {});
    const { record } = await installPlugin({
      home: '/home/u',
      marketplaceName: 'official',
      marketplaceDir: '/mkt',
      entry,
      copyDir,
      checksum: 'a'.repeat(64),
    });
    expect(record.checksum).toBe('a'.repeat(64));
  });
});

describe('remote sources', () => {
  const remoteEntry = {
    name: 'cloud-thing',
    source: { kind: 'url', url: 'https://github.com/o/cloud.git', sha: 'abc123' } as PluginSource,
  };

  it('planInstall fetches a url source, then discloses from the verified package', async () => {
    mountFiles({
      '/home/u/.abu/plugin-packages/official/cloud-thing/_remote/abc123/.abu-plugin/plugin.json':
        JSON.stringify({ name: 'cloud-thing', version: '2.0.0', mcpServers: { c: { command: 'node' } } }),
    });
    const fetchRemote = vi.fn(async (_src: PluginSource, destDir: string) => ({ destDir, sha: 'abc123' }));

    const d = await planInstall({
      marketplaceName: 'official',
      marketplaceDir: '/mkt',
      entry: remoteEntry,
      home: '/home/u',
      fetchRemote,
    });

    // Fetched into a sha-scoped staging area under the packages root — the
    // only root the privileged side will accept.
    expect(fetchRemote).toHaveBeenCalledWith(
      remoteEntry.source,
      '/home/u/.abu/plugin-packages/official/cloud-thing/_remote/abc123',
    );
    // Disclosure comes from the *verified, fetched* package, not the entry.
    expect(d.name).toBe('cloud-thing');
    expect(d.version).toBe('2.0.0');
    expect(d.mcpServers).toEqual([{ name: 'c', command: 'node', args: undefined, url: undefined }]);
    expect(d.sourceDir).toBe('/home/u/.abu/plugin-packages/official/cloud-thing/_remote/abc123');
  });

  it('planInstall still refuses remote sources when no fetcher is provided', async () => {
    await expect(
      planInstall({ marketplaceName: 'official', marketplaceDir: '/mkt', entry: remoteEntry }),
    ).rejects.toThrow(UnsupportedSourceError);
  });

  it('planInstall refuses a remote entry with no sha before fetching anything', async () => {
    const fetchRemote = vi.fn();
    await expect(
      planInstall({
        marketplaceName: 'official',
        marketplaceDir: '/mkt',
        entry: { name: 'x', source: { kind: 'url', url: 'https://x/y.git' } as PluginSource },
        home: '/home/u',
        fetchRemote,
      }),
    ).rejects.toThrow(/sha/i);
    expect(fetchRemote).not.toHaveBeenCalled();
  });

  it('installPlugin moves the fetched package into its final versioned dir', async () => {
    mountFiles({
      '/home/u/.abu/plugin-packages/official/cloud-thing/_remote/abc123/.abu-plugin/plugin.json':
        JSON.stringify({ name: 'cloud-thing', version: '2.0.0' }),
    });
    const fetchRemote = vi.fn(async (_s: PluginSource, destDir: string) => ({ destDir, sha: 'abc123' }));
    const copyDir = vi.fn(async () => {});

    const { record } = await installPlugin({
      home: '/home/u',
      marketplaceName: 'official',
      marketplaceDir: '/mkt',
      entry: remoteEntry,
      copyDir,
      fetchRemote,
    });

    expect(copyDir).toHaveBeenCalledWith(
      '/home/u/.abu/plugin-packages/official/cloud-thing/_remote/abc123',
      '/home/u/.abu/plugin-packages/official/cloud-thing/2.0.0',
    );
    expect(record.sha).toBe('abc123');
    expect(record.version).toBe('2.0.0');
    // A remote install is never "mine" — the record says so on its own, without
    // having to infer it from the presence of a sha.
    expect(record.sourceKind).toBe('url');
  });
});

describe('ignored payloads', () => {
  const entry = { name: 'weather', source: { kind: 'relative', path: './plugins/weather' } as PluginSource };

  it('reports payload dirs Abu does not consume so the disclosure can say so', async () => {
    mountFiles({
      '/mkt/plugins/weather/.abu-plugin/plugin.json': JSON.stringify({ name: 'weather' }),
      '/mkt/plugins/weather/skills/today/SKILL.md': '---\nname: today\n---\n',
      '/mkt/plugins/weather/commands/deploy.md': '# deploy',
      '/mkt/plugins/weather/agents/helper/AGENT.md': '---\nname: helper\n---\n',
      '/mkt/plugins/weather/hooks/hooks.json': '{}',
    });
    const d = await planInstall({ marketplaceName: 'official', marketplaceDir: '/mkt', entry });
    // Abu consumes skills + mcpServers; the rest is surfaced so the user is not
    // surprised when part of a plugin silently does nothing here.
    expect(d.ignoredPayloads.sort()).toEqual(['agents', 'commands', 'hooks']);
  });

  it('reports an empty list when the plugin only ships supported payloads', async () => {
    mountFiles({
      '/mkt/plugins/weather/.abu-plugin/plugin.json': JSON.stringify({ name: 'weather' }),
      '/mkt/plugins/weather/skills/today/SKILL.md': '---\nname: today\n---\n',
    });
    const d = await planInstall({ marketplaceName: 'official', marketplaceDir: '/mkt', entry });
    expect(d.ignoredPayloads).toEqual([]);
  });
})

/**
 * The install path end-to-end over a REAL temp tree with REAL symlinks —
 * the shape that broke for a user installing `canva` from Anthropic's official
 * marketplace (`EISDIR: illegal operation on a directory, read`).
 *
 * Real, not mocked, on purpose: every mocked entry in this file says
 * `isSymlink: false`, which is exactly the blind spot that let the bug ship.
 */
describe('a package that ships symlinks', () => {
  let root: string;
  let mkt: string;
  let pkg: string;
  let secret: string;

  const entry = { name: 'canva', source: { kind: 'relative', path: './plugins/canva' } as PluginSource };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'abu-plugin-install-'));
    mkt = join(root, 'mkt');
    pkg = join(mkt, 'plugins', 'canva');
    secret = join(root, 'id_rsa');

    mkdirSync(join(pkg, '.claude-plugin'), { recursive: true });
    writeFileSync(join(pkg, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'canva', version: '1.0.0' }));
    mkdirSync(join(pkg, 'skills', 'design'), { recursive: true });
    writeFileSync(join(pkg, 'skills', 'design', 'SKILL.md'), '---\nname: design\n---\n');
    // The link that crashed the install…
    mkdirSync(join(pkg, '.cursor'), { recursive: true });
    symlinkSync('../skills', join(pkg, '.cursor', 'skills'), 'dir');
    // …and the one that quietly copied someone else's bytes into the package.
    writeFileSync(secret, 'PRIVATE KEY');
    mkdirSync(join(pkg, 'data'), { recursive: true });
    symlinkSync(secret, join(pkg, 'data', 'x'));

    vi.mocked(readTextFile).mockImplementation(async (p) => readFileSync(String(p), 'utf8'));
    vi.mocked(readDir).mockImplementation(async (p) =>
      readdirSync(String(p), { withFileTypes: true }).map((d) => ({
        name: d.name,
        isDirectory: d.isDirectory(),
        isFile: d.isFile(),
        isSymlink: d.isSymbolicLink(),
      })) as never,
    );
    vi.mocked(readFile).mockImplementation(async (p) => new Uint8Array(readFileSync(String(p))));
    vi.mocked(writeFile).mockImplementation(async (p, data) => {
      writeFileSync(String(p), data as Uint8Array);
    });
    vi.mocked(mkdir).mockImplementation(async (p) => {
      mkdirSync(String(p), { recursive: true });
    });
    vi.mocked(lstat).mockImplementation(
      async (p) => ({ isSymlink: lstatSync(String(p)).isSymbolicLink() }) as never,
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('discloses both links before anything is written', async () => {
    const d = await planInstall({ marketplaceName: 'official', marketplaceDir: mkt, entry });
    expect(d.skippedSymlinks).toEqual(['.cursor/skills', 'data/x']);
  });

  it('installs successfully and copies neither link', async () => {
    const { record } = await installPlugin({
      home: root,
      marketplaceName: 'official',
      marketplaceDir: mkt,
      entry,
      copyDir: async (from, to) => {
        await copyPluginDir(from, to);
      },
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });

    const installed = join(root, '.abu', 'plugin-packages', 'official', 'canva', '1.0.0');
    expect(record.version).toBe('1.0.0');
    expect(existsSync(join(installed, 'skills', 'design', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(installed, '.cursor', 'skills'))).toBe(false);
    // The security half: the link's TARGET must not exist as a real file here.
    expect(existsSync(join(installed, 'data', 'x'))).toBe(false);
  });
});

/**
 * The disclosure and the copy must agree BY CONSTRUCTION.
 *
 * `copyPluginDir` refuses every symlink, but `exists` / `readDir` /
 * `readTextFile` all resolve them in the privileged host
 * (`electron/fsHost.cjs` → `existsSync` / `readdirSync` / `readFileSync`). A
 * scan built on those describes the link's TARGET, so the screen the user
 * approves can promise a payload the install then drops on the floor — or read
 * the approval itself out of a file the package does not own.
 */
describe('a package that ships a symlink where Abu looks for its own payload', () => {
  let root: string;
  let mkt: string;
  let pkg: string;

  const entry = { name: 'canva', source: { kind: 'relative', path: './plugins/canva' } as PluginSource };

  /** Wire the mocked fs surface onto the real temp tree, host-faithfully. */
  function useRealTree() {
    vi.mocked(readTextFile).mockImplementation(async (p) => readFileSync(String(p), 'utf8'));
    vi.mocked(readDir).mockImplementation(async (p) =>
      readdirSync(String(p), { withFileTypes: true }).map((d) => ({
        name: d.name,
        isDirectory: d.isDirectory(),
        isFile: d.isFile(),
        isSymlink: d.isSymbolicLink(),
      })) as never,
    );
    vi.mocked(readFile).mockImplementation(async (p) => new Uint8Array(readFileSync(String(p))));
    vi.mocked(writeFile).mockImplementation(async (p, data) => {
      writeFileSync(String(p), data as Uint8Array);
    });
    vi.mocked(mkdir).mockImplementation(async (p) => {
      mkdirSync(String(p), { recursive: true });
    });
    vi.mocked(lstat).mockImplementation(
      async (p) => ({ isSymlink: lstatSync(String(p)).isSymbolicLink() }) as never,
    );
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'abu-plugin-scan-'));
    mkt = join(root, 'mkt');
    pkg = join(mkt, 'plugins', 'canva');
    mkdirSync(pkg, { recursive: true });
    useRealTree();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe('`skills` is a link to a directory the package does not own', () => {
    beforeEach(() => {
      mkdirSync(join(pkg, '.claude-plugin'), { recursive: true });
      writeFileSync(
        join(pkg, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: 'canva', version: '1.0.0' }),
      );
      mkdirSync(join(mkt, 'shared-skills', 'design'), { recursive: true });
      writeFileSync(join(mkt, 'shared-skills', 'design', 'SKILL.md'), '---\nname: design\n---\n');
      symlinkSync('../../shared-skills', join(pkg, 'skills'), 'dir');
    });

    it('does not promise a skill the copy will drop', async () => {
      // Otherwise the same screen says "will register: design" AND "skipped
      // link: skills", which contradict each other.
      const d = await planInstall({ marketplaceName: 'official', marketplaceDir: mkt, entry });

      expect(d.skills).toEqual([]);
      expect(d.skippedSymlinks).toContain('skills');
    });

    it('does not record a contribution that is not on disk', async () => {
      // `installed.json` is what the uninstaller and the skill roots trust.
      const { record } = await installPlugin({
        home: root,
        marketplaceName: 'official',
        marketplaceDir: mkt,
        entry,
        copyDir: async (from, to) => {
          await copyPluginDir(from, to);
        },
      });

      const installed = join(root, '.abu', 'plugin-packages', 'official', 'canva', '1.0.0');
      expect(existsSync(join(installed, 'skills'))).toBe(false);
      expect(record.contributed.skills).toEqual([]);
    });
  });

  it('refuses a package whose only manifest candidate is a link', async () => {
    // Approving a name / version / mcpServers block read from OUTSIDE the
    // package, and then installing a package with no manifest at all, is the
    // worst version of the disagreement. It has to fail the ordinary way.
    mkdirSync(join(mkt, 'elsewhere'), { recursive: true });
    writeFileSync(
      join(mkt, 'elsewhere', 'plugin.json'),
      JSON.stringify({ name: 'canva', version: '9.9.9' }),
    );
    symlinkSync('../../elsewhere', join(pkg, '.claude-plugin'), 'dir');

    await expect(
      planInstall({ marketplaceName: 'official', marketplaceDir: mkt, entry }),
    ).rejects.toThrow(/No plugin manifest found/);
  });

  it('refuses a package whose manifest FILE is a link inside a real dot-dir', async () => {
    mkdirSync(join(pkg, '.claude-plugin'), { recursive: true });
    writeFileSync(join(mkt, 'plugin.json'), JSON.stringify({ name: 'canva', version: '9.9.9' }));
    symlinkSync('../../../plugin.json', join(pkg, '.claude-plugin', 'plugin.json'));

    await expect(
      planInstall({ marketplaceName: 'official', marketplaceDir: mkt, entry }),
    ).rejects.toThrow(/No plugin manifest found/);
  });

  it('does not list an ignored payload dir that is really a link', async () => {
    // `discoverIgnoredPayloads` is the third consumer of the shared scan and
    // the only one with no case of its own. A link here would otherwise put
    // "this plugin also ships commands" on the screen for a directory the
    // package does not own and the copy will not bring in.
    mkdirSync(join(pkg, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(pkg, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'canva', version: '1.0.0' }),
    );
    mkdirSync(join(mkt, 'shared-commands'), { recursive: true });
    writeFileSync(join(mkt, 'shared-commands', 'do.md'), '# do');
    symlinkSync('../../shared-commands', join(pkg, 'commands'), 'dir');

    const d = await planInstall({ marketplaceName: 'official', marketplaceDir: mkt, entry });

    expect(d.ignoredPayloads).toEqual([]);
    expect(d.skippedSymlinks).toContain('commands');
  });

  it('does not promise a skill whose own directory is a link', async () => {
    // The exact shape that started this: `canva` ships
    // `.cursor/skills -> ../skills`, so a linked CHILD under a real `skills/`
    // is the most likely thing to meet in the wild — and the disclosure has to
    // list only the sibling that actually lands.
    mkdirSync(join(pkg, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(pkg, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'canva', version: '1.0.0' }),
    );
    mkdirSync(join(pkg, 'skills', 'layout'), { recursive: true });
    writeFileSync(join(pkg, 'skills', 'layout', 'SKILL.md'), '---\nname: layout\n---\n');
    mkdirSync(join(mkt, 'shared-skills', 'design'), { recursive: true });
    writeFileSync(join(mkt, 'shared-skills', 'design', 'SKILL.md'), '---\nname: design\n---\n');
    symlinkSync('../../../shared-skills/design', join(pkg, 'skills', 'design'), 'dir');

    const d = await planInstall({ marketplaceName: 'official', marketplaceDir: mkt, entry });

    expect(d.skills).toEqual(['layout']);
    expect(d.skippedSymlinks).toContain('skills/design');
  });

  it('refuses to read a manifest out of a linked root, whoever asks', async () => {
    // `readManifestFrom` is a public export and does no symlink collection of
    // its own; before the check moved into the scan it was safe only because
    // `planInstall` happened to call `collectPluginSymlinks` first.
    const real = join(root, 'outside', 'canva');
    mkdirSync(join(real, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(real, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'canva', version: '1.0.0' }),
    );
    rmSync(pkg, { recursive: true, force: true });
    symlinkSync(real, pkg, 'dir');

    await expect(readManifestFrom(pkg)).rejects.toThrow(PluginSymlinkRootError);
  });

  it('reports a package directory that is not there as a plugin error', async () => {
    // A marketplace catalog can point at a folder the user has since deleted.
    // Before this, the first call was `lstat` and the dialog rendered its raw
    // `ENOENT ... lstat '<path>'` verbatim.
    rmSync(pkg, { recursive: true, force: true });

    await expect(readManifestFrom(pkg)).rejects.toThrow(PluginPackageNotFoundError);
  });

  it('refuses a marketplace that ships the package directory itself as a link', async () => {
    // `resolveSourceDir` only validates `marketplaceDir + source.path`
    // lexically, so this passes it and `readDir` then enumerates the target.
    const real = join(root, 'outside', 'canva');
    mkdirSync(join(real, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(real, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'canva', version: '1.0.0' }),
    );
    rmSync(pkg, { recursive: true, force: true });
    symlinkSync(real, pkg, 'dir');

    await expect(
      planInstall({ marketplaceName: 'official', marketplaceDir: mkt, entry }),
    ).rejects.toThrow(PluginSymlinkRootError);
  });
});
