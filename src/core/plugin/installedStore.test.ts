import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readTextFile, writeTextFile, exists } from '@tauri-apps/plugin-fs';

vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(),
  writeTextFile: vi.fn().mockResolvedValue(undefined),
  readDir: vi.fn(),
  exists: vi.fn().mockResolvedValue(false),
}));

import {
  InstalledManifestUnreadableError,
  readInstalled,
  readInstalledResult,
  readInstalledForWrite,
  upsertInstalled,
  removeInstalled,
  findInstalled,
  type InstalledPlugin,
} from './installedStore';
import { installedManifestPath } from './paths';

const mockReadTextFile = vi.mocked(readTextFile);
const mockWriteTextFile = vi.mocked(writeTextFile);
const mockExists = vi.mocked(exists);

const HOME = '/Users/test';
const MANIFEST_PATH = installedManifestPath(HOME);

function makePlugin(overrides: Partial<InstalledPlugin> = {}): InstalledPlugin {
  return {
    key: 'foo@mkt',
    marketplace: 'mkt',
    name: 'foo',
    version: '1.0.0',
    installedAt: '2026-08-31T00:00:00.000Z',
    contributed: { skills: ['skill-a'], mcpServers: ['server-a'], agents: ['agent-a'] },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExists.mockResolvedValue(false);
  mockWriteTextFile.mockResolvedValue(undefined);
});

describe('readInstalledResult', () => {
  // `readInstalled` answers `[]` to both "nothing installed" and "could not
  // read", which is fine for a caller that only grants things from a record
  // and fatal for one that revokes: `pluginStore` narrows the MCP approval
  // gate from this list, so it needs the two told apart.

  it('reports a missing file as a successful empty read', async () => {
    mockExists.mockResolvedValue(false);
    expect(await readInstalledResult(HOME)).toEqual({ ok: true, plugins: [] });
  });

  it('reports an unreadable file as a failure', async () => {
    mockExists.mockResolvedValue(true);
    mockReadTextFile.mockRejectedValue(new Error('EACCES'));
    expect(await readInstalledResult(HOME)).toMatchObject({ ok: false });
  });

  it('reports malformed json as a failure, not as an empty install set', async () => {
    mockExists.mockResolvedValue(true);
    mockReadTextFile.mockResolvedValue('[{"key": "half-writ');
    expect(await readInstalledResult(HOME)).toMatchObject({ ok: false });
  });

  it('reports valid json that is not an array as a failure', async () => {
    mockExists.mockResolvedValue(true);
    mockReadTextFile.mockResolvedValue('{"key":"value"}');
    expect(await readInstalledResult(HOME)).toMatchObject({ ok: false });
  });

  it('still succeeds when only SOME records are invalid — one bad record is not a bad file', async () => {
    const plugin = makePlugin();
    mockExists.mockResolvedValue(true);
    mockReadTextFile.mockResolvedValue(JSON.stringify([plugin, { key: 'no-name' }]));
    expect(await readInstalledResult(HOME)).toEqual({ ok: true, plugins: [plugin] });
  });
});

describe('readInstalled', () => {
  it('returns [] when the file does not exist', async () => {
    mockExists.mockResolvedValue(false);
    const result = await readInstalled(HOME);
    expect(result).toEqual([]);
  });

  it('returns [] (not throw) when the json is corrupted', async () => {
    mockExists.mockResolvedValue(true);
    mockReadTextFile.mockResolvedValue('{ this is not valid json');
    const result = await readInstalled(HOME);
    expect(result).toEqual([]);
  });

  it('returns parsed plugins when the file is valid', async () => {
    const plugin = makePlugin();
    mockExists.mockResolvedValue(true);
    mockReadTextFile.mockResolvedValue(JSON.stringify([plugin]));
    const result = await readInstalled(HOME);
    expect(result).toEqual([plugin]);
  });

  it('round-trips sourceKind', async () => {
    const plugin = makePlugin({ sourceKind: 'git-subdir' });
    mockExists.mockResolvedValue(true);
    mockReadTextFile.mockResolvedValue(JSON.stringify([plugin]));
    expect(await readInstalled(HOME)).toEqual([plugin]);
  });

  it('reads a record written before contributed.agents existed as an empty list', async () => {
    const legacy = {
      key: 'foo@mkt',
      marketplace: 'mkt',
      name: 'foo',
      version: '1.0.0',
      installedAt: '2026-08-31T00:00:00.000Z',
      contributed: { skills: ['skill-a'], mcpServers: ['server-a'] },
    };
    mockExists.mockResolvedValue(true);
    mockReadTextFile.mockResolvedValue(JSON.stringify([legacy]));

    const [read] = await readInstalled(HOME);

    // The record still loads, and every consumer gets a list to iterate.
    expect(read.contributed.agents).toEqual([]);
    expect(read.contributed.skills).toEqual(['skill-a']);
    expect(read.contributed.mcpServers).toEqual(['server-a']);
  });

  it('replaces a contributed.agents value that is not a list of strings', async () => {
    const plugin = { ...makePlugin(), contributed: { skills: [], mcpServers: [], agents: 'nope' } };
    mockExists.mockResolvedValue(true);
    mockReadTextFile.mockResolvedValue(JSON.stringify([plugin]));
    const [read] = await readInstalled(HOME);
    expect(read.contributed.agents).toEqual([]);
  });

  it('round-trips contributed.agents when the record has it', async () => {
    const plugin = makePlugin();
    mockExists.mockResolvedValue(true);
    mockReadTextFile.mockResolvedValue(JSON.stringify([plugin]));
    expect((await readInstalled(HOME))[0].contributed.agents).toEqual(['agent-a']);
  });

  it('keeps a record written before sourceKind existed', async () => {
    const plugin = makePlugin();
    mockExists.mockResolvedValue(true);
    mockReadTextFile.mockResolvedValue(JSON.stringify([plugin]));
    const [read] = await readInstalled(HOME);
    expect(read).toEqual(plugin);
    expect(read.sourceKind).toBeUndefined();
  });

  it('drops an out-of-union sourceKind but keeps the record', async () => {
    mockExists.mockResolvedValue(true);
    mockReadTextFile.mockResolvedValue(JSON.stringify([{ ...makePlugin(), sourceKind: 'ftp' }]));
    const [read] = await readInstalled(HOME);
    expect(read).toEqual(makePlugin());
    expect(read.sourceKind).toBeUndefined();
  });

  it('drops a non-string sourceKind but keeps the record', async () => {
    mockExists.mockResolvedValue(true);
    mockReadTextFile.mockResolvedValue(JSON.stringify([{ ...makePlugin(), sourceKind: 7 }]));
    const [read] = await readInstalled(HOME);
    expect(read).toEqual(makePlugin());
    expect(read.sourceKind).toBeUndefined();
  });
});

describe('upsertInstalled', () => {
  it('adds a new plugin when the store is empty', async () => {
    mockExists.mockResolvedValue(false);
    const plugin = makePlugin();
    await upsertInstalled(HOME, plugin);
    expect(mockWriteTextFile).toHaveBeenCalledTimes(1);
    const [pathArg, contentArg] = mockWriteTextFile.mock.calls[0];
    expect(pathArg).toBe(MANIFEST_PATH);
    const written = JSON.parse(contentArg as string);
    expect(written).toEqual([plugin]);
  });

  it('replaces an existing entry with the same key instead of duplicating', async () => {
    const original = makePlugin({ version: '1.0.0' });
    mockExists.mockResolvedValue(true);
    mockReadTextFile.mockResolvedValue(JSON.stringify([original]));

    const updated = makePlugin({ version: '2.0.0' });
    await upsertInstalled(HOME, updated);

    const [, contentArg] = mockWriteTextFile.mock.calls[0];
    const written = JSON.parse(contentArg as string);
    expect(written).toHaveLength(1);
    expect(written[0].version).toBe('2.0.0');
  });

  it('round-trips the contributed skills/mcpServers/agents lists', async () => {
    mockExists.mockResolvedValue(false);
    const plugin = makePlugin({
      contributed: { skills: ['s1', 's2'], mcpServers: ['m1'], agents: ['a1'] },
    });
    await upsertInstalled(HOME, plugin);
    const [, contentArg] = mockWriteTextFile.mock.calls[0];
    const written = JSON.parse(contentArg as string);
    expect(written[0].contributed).toEqual({ skills: ['s1', 's2'], mcpServers: ['m1'], agents: ['a1'] });
  });

  it('writes formatted (pretty-printed, multi-line) json', async () => {
    mockExists.mockResolvedValue(false);
    await upsertInstalled(HOME, makePlugin());
    const [, contentArg] = mockWriteTextFile.mock.calls[0];
    expect(contentArg as string).toContain('\n');
    expect(contentArg as string).toMatch(/^\[\n/);
  });
});

describe('removeInstalled', () => {
  it('removes an existing key', async () => {
    const plugin = makePlugin();
    mockExists.mockResolvedValue(true);
    mockReadTextFile.mockResolvedValue(JSON.stringify([plugin]));

    await removeInstalled(HOME, 'foo@mkt');

    const [, contentArg] = mockWriteTextFile.mock.calls[0];
    const written = JSON.parse(contentArg as string);
    expect(written).toEqual([]);
  });

  it('is a no-op (no throw, no write) when the key does not exist', async () => {
    const plugin = makePlugin();
    mockExists.mockResolvedValue(true);
    mockReadTextFile.mockResolvedValue(JSON.stringify([plugin]));

    await expect(removeInstalled(HOME, 'does-not-exist@mkt')).resolves.not.toThrow();
    expect(mockWriteTextFile).not.toHaveBeenCalled();
  });
});

describe('write-side fail-closed (controller ruling)', () => {
  // Every write here is read-modify-write, and `readInstalled` collapses a
  // failed read to `[]`. Without this guard an unreadable manifest would be
  // REWRITTEN from that empty list — install would replace the user's whole
  // record with one entry, uninstall would silently drop every other plugin,
  // and the packages on disk would be orphaned with nothing to remove them.

  it('upsertInstalled refuses to write when the manifest cannot be read', async () => {
    mockExists.mockResolvedValue(true);
    mockReadTextFile.mockRejectedValue(new Error('EACCES'));

    await expect(upsertInstalled(HOME, makePlugin())).rejects.toBeInstanceOf(
      InstalledManifestUnreadableError,
    );
    expect(mockWriteTextFile).not.toHaveBeenCalled();
  });

  it('upsertInstalled refuses to write when the manifest is not valid JSON', async () => {
    mockExists.mockResolvedValue(true);
    mockReadTextFile.mockResolvedValue('{ this is not json');

    await expect(upsertInstalled(HOME, makePlugin())).rejects.toBeInstanceOf(
      InstalledManifestUnreadableError,
    );
    expect(mockWriteTextFile).not.toHaveBeenCalled();
  });

  it('removeInstalled refuses to write when the manifest cannot be read', async () => {
    mockExists.mockResolvedValue(true);
    mockReadTextFile.mockResolvedValue('null');

    await expect(removeInstalled(HOME, 'foo@mkt')).rejects.toBeInstanceOf(
      InstalledManifestUnreadableError,
    );
    expect(mockWriteTextFile).not.toHaveBeenCalled();
  });

  it('still writes when the manifest is merely ABSENT — the honest empty state', async () => {
    mockExists.mockResolvedValue(false);

    await expect(upsertInstalled(HOME, makePlugin())).resolves.toBeUndefined();
    expect(mockWriteTextFile).toHaveBeenCalledWith(MANIFEST_PATH, expect.any(String));
  });
});

describe('findInstalled', () => {
  it('returns the matching plugin', async () => {
    const plugin = makePlugin();
    mockExists.mockResolvedValue(true);
    mockReadTextFile.mockResolvedValue(JSON.stringify([plugin]));

    const result = await findInstalled(HOME, 'foo@mkt');
    expect(result).toEqual(plugin);
  });

  it('returns null when there is no match', async () => {
    mockExists.mockResolvedValue(true);
    mockReadTextFile.mockResolvedValue(JSON.stringify([makePlugin()]));

    const result = await findInstalled(HOME, 'nope@mkt');
    expect(result).toBeNull();
  });

  it('returns null when the store is empty', async () => {
    mockExists.mockResolvedValue(false);
    const result = await findInstalled(HOME, 'foo@mkt');
    expect(result).toBeNull();
  });
});

describe('Electron registry coordinator', () => {
  function shell(bridge?: ReturnType<typeof vi.fn>) {
    vi.stubGlobal('__ABU_SHELL__', { pluginRegistry: bridge });
  }

  it('sends mutations rather than renderer-generated replacement arrays', async () => {
    const bridge = vi.fn().mockResolvedValue(undefined);
    shell(bridge);
    try {
      await upsertInstalled(HOME, makePlugin());
      await removeInstalled(HOME, 'foo@mkt');
      expect(bridge.mock.calls).toEqual([
        ['upsert', { home: HOME, record: makePlugin() }],
        ['remove', { home: HOME, key: 'foo@mkt' }],
      ]);
      expect(mockReadTextFile).not.toHaveBeenCalled();
      expect(mockWriteTextFile).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it('reads the host profile and preserves legacy record normalization', async () => {
    const bridge = vi.fn().mockResolvedValue(JSON.stringify([{ ...makePlugin(), contributed: { skills: [], mcpServers: [] } }]));
    shell(bridge);
    try {
      expect(await readInstalled(HOME)).toEqual([{ ...makePlugin(), contributed: { skills: [], mcpServers: [], agents: [] } }]);
      expect(bridge).toHaveBeenCalledWith('read', { home: HOME });
      expect(mockReadTextFile).not.toHaveBeenCalled();
      bridge.mockResolvedValue(null);
      expect(await readInstalledResult(HOME)).toEqual({ ok: true, plugins: [] });
      expect(await readInstalledForWrite(HOME)).toEqual([]);
      expect(bridge).toHaveBeenLastCalledWith('read', { home: HOME, forWrite: true });
      bridge.mockResolvedValue({ bad: 'response' });
      expect(await readInstalledResult(HOME)).toMatchObject({ ok: false });
    } finally { vi.unstubAllGlobals(); }
  });

  it('does not bypass the coordinator when the Electron bridge fails or is missing', async () => {
    shell(vi.fn().mockRejectedValue(new Error('host write failed')));
    try {
      await expect(upsertInstalled(HOME, makePlugin())).rejects.toThrow('host write failed');
      await expect(removeInstalled(HOME, 'foo@mkt')).rejects.toThrow('host write failed');
      expect(await readInstalledResult(HOME)).toMatchObject({ ok: false });
      shell();
      await expect(upsertInstalled(HOME, makePlugin())).rejects.toThrow('host bridge');
      await expect(removeInstalled(HOME, 'foo@mkt')).rejects.toThrow('host bridge');
      expect(await readInstalledResult(HOME)).toMatchObject({ ok: false });
      expect(mockReadTextFile).not.toHaveBeenCalled();
      expect(mockWriteTextFile).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
});
