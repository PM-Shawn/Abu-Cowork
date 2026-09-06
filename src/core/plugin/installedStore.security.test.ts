import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  exists: vi.fn(),
  mkdir: vi.fn(),
}));

import { readTextFile, exists } from '@tauri-apps/plugin-fs';
import { readInstalled } from './installedStore';
import { pluginSkillDirs, mcpServerNamesOf } from './skillRoots';

const mockRead = vi.mocked(readTextFile);
const mockExists = vi.mocked(exists);

function onDisk(json: string) {
  mockExists.mockResolvedValue(true);
  mockRead.mockResolvedValue(json);
}

const GOOD = {
  key: 'weather@official',
  marketplace: 'official',
  name: 'weather',
  version: '1.0.0',
  installedAt: '2026-09-01T00:00:00.000Z',
  contributed: { skills: ['today'], mcpServers: ['forecast'] },
};

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * `installed.json` is not a trusted document: it is edited by hand, synced
 * between machines, and truncated by crashes. Every consumer of it runs on the
 * skill-loading path, and `loader.ts` has no guard around that call — so one
 * malformed record must never be able to take every skill down with it.
 *
 * This got sharper once `pluginInstallDir` started rejecting unsafe segments:
 * a record with a traversal in its name now *throws* rather than quietly
 * producing a bad path, which turns a bad record into a fatal one unless it is
 * dropped at the read boundary.
 */
describe('installed.json is treated as untrusted input', () => {
  it.each([
    ['a record missing every field', '[{}]'],
    ['a record whose name is not a string', '[{"key":"a@b","marketplace":"b","name":123,"version":"1"}]'],
    ['a record with no contributed block', '[{"key":"a@b","marketplace":"b","name":"a","version":"1"}]'],
    ['a record whose contributed lists are not arrays', '[{"key":"a@b","marketplace":"b","name":"a","version":"1","contributed":{"skills":"x","mcpServers":null}}]'],
    ['a null entry', '[null]'],
    ['a string entry', '["nope"]'],
    ['a record carrying a path traversal', '[{"key":"a@b","marketplace":"../../Library","name":"LaunchAgents","version":".","contributed":{"skills":[],"mcpServers":[]}}]'],
  ])('drops %s instead of surfacing it', async (_label, json) => {
    onDisk(json);
    await expect(readInstalled('/home/u')).resolves.toEqual([]);
  });

  it('keeps the good records alongside the bad ones', async () => {
    onDisk(JSON.stringify([{ junk: true }, GOOD, null]));
    const kept = await readInstalled('/home/u');
    expect(kept.map((p) => p.key)).toEqual(['weather@official']);
  });

  it('never throws out of pluginSkillDirs, whatever the file holds', async () => {
    // loader.ts has no try/catch here; a throw means the user loses *all*
    // skills, plugin-contributed or not.
    onDisk('[{"key":"a@b","marketplace":"../../Library","name":"LaunchAgents","version":"."}]');
    await expect(pluginSkillDirs('/home/u')).resolves.toEqual([]);
  });

  it('never throws out of the approval-gate arming path either', async () => {
    // A throw here would leave the approval gate unarmed.
    onDisk('[{"key":"a@b"}]');
    expect(mcpServerNamesOf(await readInstalled('/home/u'))).toEqual([]);
  });
});
