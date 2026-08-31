import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  exists: vi.fn(),
  mkdir: vi.fn(),
}));

import { readTextFile, writeTextFile, exists } from '@tauri-apps/plugin-fs';
import { uninstallPlugin, PluginNotInstalledError } from './uninstaller';
import type { InstalledPlugin } from './installedStore';

const mockRead = vi.mocked(readTextFile);
const mockWrite = vi.mocked(writeTextFile);
const mockExists = vi.mocked(exists);

const weather: InstalledPlugin = {
  key: 'weather@official',
  marketplace: 'official',
  name: 'weather',
  version: '1.2.0',
  installedAt: '2026-09-01T00:00:00.000Z',
  contributed: { skills: ['today'], mcpServers: ['forecast'] },
};

const notes: InstalledPlugin = {
  key: 'notes@personal',
  marketplace: 'personal',
  name: 'notes',
  version: '0.1.0',
  installedAt: '2026-09-01T00:00:00.000Z',
  contributed: { skills: ['jot'], mcpServers: ['notes-db'] },
};

function installed(...plugins: InstalledPlugin[]) {
  mockExists.mockResolvedValue(true);
  mockRead.mockResolvedValue(JSON.stringify(plugins));
}

/** Parse whatever the store last wrote back to installed.json. */
function lastWrittenRecords(): InstalledPlugin[] {
  const call = mockWrite.mock.calls.at(-1);
  if (!call) throw new Error('installed.json was never written');
  return JSON.parse(String(call[1]));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('uninstallPlugin', () => {
  it('removes the package directory computed from the install record', async () => {
    installed(weather, notes);
    const removeDir = vi.fn(async () => {});

    await uninstallPlugin({ home: '/home/u', key: 'weather@official', removeDir });

    expect(removeDir).toHaveBeenCalledWith('/home/u/.abu/plugin-packages/official/weather/1.2.0');
  });

  it('drops only the uninstalled plugin from the install record', async () => {
    installed(weather, notes);
    await uninstallPlugin({ home: '/home/u', key: 'weather@official', removeDir: async () => {} });

    const remaining = lastWrittenRecords();
    expect(remaining.map((p) => p.key)).toEqual(['notes@personal']);
  });

  it('reports what was withdrawn so callers can deregister it', async () => {
    installed(weather, notes);
    const result = await uninstallPlugin({
      home: '/home/u',
      key: 'weather@official',
      removeDir: async () => {},
    });

    expect(result.withdrawn).toEqual({ skills: ['today'], mcpServers: ['forecast'] });
  });

  it('throws a typed error when the plugin is not installed', async () => {
    installed(notes);
    await expect(
      uninstallPlugin({ home: '/home/u', key: 'weather@official', removeDir: async () => {} }),
    ).rejects.toThrow(PluginNotInstalledError);
  });

  it('keeps the install record intact when directory removal fails', async () => {
    // Otherwise the plugin would vanish from the UI while its files — and its
    // skills and MCP servers — stayed live on disk.
    installed(weather, notes);
    const removeDir = vi.fn(async () => {
      throw new Error('EPERM');
    });

    await expect(
      uninstallPlugin({ home: '/home/u', key: 'weather@official', removeDir }),
    ).rejects.toThrow('EPERM');
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('still deregisters when the directory is already gone', async () => {
    // A user who deleted the folder by hand must still be able to clean up the
    // record through the UI, rather than being stuck with a ghost entry.
    installed(weather);
    const removeDir = vi.fn(async () => {
      throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    });

    const result = await uninstallPlugin({
      home: '/home/u',
      key: 'weather@official',
      removeDir,
      tolerateMissingDir: true,
    });

    expect(result.withdrawn.skills).toEqual(['today']);
    expect(lastWrittenRecords()).toEqual([]);
  });
});
