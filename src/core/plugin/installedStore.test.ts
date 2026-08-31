import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readTextFile, writeTextFile, exists } from '@tauri-apps/plugin-fs';

vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(),
  writeTextFile: vi.fn().mockResolvedValue(undefined),
  readDir: vi.fn(),
  exists: vi.fn().mockResolvedValue(false),
}));

import {
  readInstalled,
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
    contributed: { skills: ['skill-a'], mcpServers: ['server-a'] },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExists.mockResolvedValue(false);
  mockWriteTextFile.mockResolvedValue(undefined);
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

  it('round-trips the contributed skills/mcpServers lists', async () => {
    mockExists.mockResolvedValue(false);
    const plugin = makePlugin({
      contributed: { skills: ['s1', 's2'], mcpServers: ['m1'] },
    });
    await upsertInstalled(HOME, plugin);
    const [, contentArg] = mockWriteTextFile.mock.calls[0];
    const written = JSON.parse(contentArg as string);
    expect(written[0].contributed).toEqual({ skills: ['s1', 's2'], mcpServers: ['m1'] });
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
