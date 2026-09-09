import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  exists: vi.fn(),
  mkdir: vi.fn(),
}));

import { readTextFile, exists } from '@tauri-apps/plugin-fs';
import { pluginSkillDirs, pluginSkillLocations, mcpServerNamesOf } from './skillRoots';
import { readInstalled, type InstalledPlugin } from './installedStore';

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
  it('loads exact component paths from new records while keeping the legacy fallback', async () => {
    installed({ ...weather, componentLayoutVersion: 1, skillPaths: ['extras/review', '.'] }, notes);
    expect(await pluginSkillLocations('/home/u')).toEqual([
      { path: '/home/u/.abu/plugin-packages/official/weather/1.2.0/extras/review', direct: true, packageRoot: '/home/u/.abu/plugin-packages/official/weather/1.2.0' },
      { path: '/home/u/.abu/plugin-packages/official/weather/1.2.0', direct: true, packageRoot: '/home/u/.abu/plugin-packages/official/weather/1.2.0' },
      { path: '/home/u/.abu/plugin-packages/personal/notes/0.1.0/skills', direct: false },
    ]);
  });

  it.each([undefined, ['../outside'], ['/outside'], ['C:\\outside'], [42], 'bad'])(
    'never broadens scanning when a new layout record has malformed paths: %j', async (skillPaths) => {
    mockExists.mockResolvedValue(true);
    mockRead.mockResolvedValue(JSON.stringify([{ ...weather, componentLayoutVersion: 1, skillPaths }]));
    expect(await pluginSkillLocations('/home/u')).toEqual([]);
    expect(mcpServerNamesOf(await readInstalled('/home/u'))).toEqual(['forecast']);
    });

  it('refuses to scan an unknown future layout version', async () => {
    mockExists.mockResolvedValue(true);
    mockRead.mockResolvedValue(JSON.stringify([{ ...weather, componentLayoutVersion: 2, skillPaths: ['extras/review'] }]));
    expect(await pluginSkillLocations('/home/u')).toEqual([]);
  });
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

// The approval gate is armed as `mcpServerNamesOf(records the caller already
// read)` — see `pluginStore.refreshInstalled`. These drive the pure function
// through `readInstalled` so the fixtures stay the on-disk shape.
describe('mcpServerNamesOf', () => {
  it('collects every contributed server name across plugins', async () => {
    installed(weather, notes);
    expect(mcpServerNamesOf(await readInstalled('/home/u'))).toEqual(['forecast', 'notes-db']);
  });

  it('de-duplicates when two plugins contribute the same server name', async () => {
    installed(weather, { ...notes, contributed: { skills: [], mcpServers: ['forecast'] } });
    expect(mcpServerNamesOf(await readInstalled('/home/u'))).toEqual(['forecast']);
  });

  it('returns an empty list when nothing is installed', async () => {
    mockExists.mockResolvedValue(false);
    expect(mcpServerNamesOf(await readInstalled('/home/u'))).toEqual([]);
  });
});
