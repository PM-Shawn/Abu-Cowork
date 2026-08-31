import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  exists: vi.fn(),
  mkdir: vi.fn(),
}));

import { readTextFile, exists } from '@tauri-apps/plugin-fs';
import { pluginSkillDirs, pluginMcpServerNames } from './skillRoots';
import type { InstalledPlugin } from './installedStore';

const mockRead = vi.mocked(readTextFile);
const mockExists = vi.mocked(exists);

function installed(...plugins: InstalledPlugin[]) {
  mockExists.mockResolvedValue(true);
  mockRead.mockResolvedValue(JSON.stringify(plugins));
}

const weather: InstalledPlugin = {
  key: 'weather@official',
  marketplace: 'official',
  name: 'weather',
  version: '1.2.0',
  installedAt: '2026-09-01T00:00:00.000Z',
  contributed: { skills: ['today', 'tomorrow'], mcpServers: ['forecast'] },
};

const notes: InstalledPlugin = {
  key: 'notes@personal',
  marketplace: 'personal',
  name: 'notes',
  version: '0.1.0',
  installedAt: '2026-09-01T00:00:00.000Z',
  contributed: { skills: [], mcpServers: ['notes-db'] },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('pluginSkillDirs', () => {
  it('returns one skills root per installed plugin', async () => {
    installed(weather, notes);
    await expect(pluginSkillDirs('/home/u')).resolves.toEqual([
      '/home/u/.abu/plugin-packages/official/weather/1.2.0/skills',
      '/home/u/.abu/plugin-packages/personal/notes/0.1.0/skills',
    ]);
  });

  it('returns an empty list when nothing is installed', async () => {
    mockExists.mockResolvedValue(false);
    await expect(pluginSkillDirs('/home/u')).resolves.toEqual([]);
  });

  it('does not throw when the install record is corrupt', async () => {
    // A broken installed.json must degrade to "no plugin skills", never take
    // the whole skill loader down with it.
    mockExists.mockResolvedValue(true);
    mockRead.mockResolvedValue('{ not json');
    await expect(pluginSkillDirs('/home/u')).resolves.toEqual([]);
  });
});

describe('pluginMcpServerNames', () => {
  it('collects every contributed server name across plugins', async () => {
    installed(weather, notes);
    await expect(pluginMcpServerNames('/home/u')).resolves.toEqual(['forecast', 'notes-db']);
  });

  it('de-duplicates when two plugins contribute the same server name', async () => {
    installed(weather, { ...notes, contributed: { skills: [], mcpServers: ['forecast'] } });
    await expect(pluginMcpServerNames('/home/u')).resolves.toEqual(['forecast']);
  });

  it('returns an empty list when nothing is installed', async () => {
    mockExists.mockResolvedValue(false);
    await expect(pluginMcpServerNames('/home/u')).resolves.toEqual([]);
  });
});
