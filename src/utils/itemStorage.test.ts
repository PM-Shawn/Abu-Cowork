/**
 * saveItemToAbuDir is the one writer behind the agent and skill editors.
 * - `mustBeNew`: a create/rename must refuse an item already on disk instead
 *   of overwriting it.
 * - A letter-case-only rename must not delete the folder it just wrote into:
 *   on the case-insensitive macOS/Windows file systems `Reviewer/` IS `reviewer/`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { exists, mkdir, remove, writeTextFile } from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';
import { ITEM_EXISTS_CODE, saveItemToAbuDir } from './itemStorage';

const HOME = '/Users/tester';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(homeDir).mockResolvedValue(HOME);
  vi.mocked(exists).mockResolvedValue(false);
});

describe('saveItemToAbuDir', () => {
  it('refuses, writing nothing, when mustBeNew finds the manifest already there', async () => {
    vi.mocked(exists).mockResolvedValue(true);

    await expect(
      saveItemToAbuDir('agents', 'AGENT.md', 'reviewer', 'md', undefined, { mustBeNew: true }),
    ).rejects.toMatchObject({ code: ITEM_EXISTS_CODE });
    expect(exists).toHaveBeenCalledWith(`${HOME}/.abu/agents/reviewer/AGENT.md`);
    expect(mkdir).not.toHaveBeenCalled();
    expect(writeTextFile).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('writes a new item when nothing is there', async () => {
    await saveItemToAbuDir('skills', 'SKILL.md', 'fresh', 'md', undefined, { mustBeNew: true });

    expect(writeTextFile).toHaveBeenCalledWith(`${HOME}/.abu/skills/fresh/SKILL.md`, 'md');
  });

  it('overwrites without asking when the caller is saving the item in place', async () => {
    vi.mocked(exists).mockResolvedValue(true);

    await saveItemToAbuDir('agents', 'AGENT.md', 'reviewer', 'md');

    expect(exists).not.toHaveBeenCalled();
    expect(writeTextFile).toHaveBeenCalledWith(`${HOME}/.abu/agents/reviewer/AGENT.md`, 'md');
  });

  it('removes the old folder after a real rename', async () => {
    await saveItemToAbuDir('agents', 'AGENT.md', 'writer', 'md', `${HOME}/.abu/agents/reviewer/AGENT.md`);

    expect(remove).toHaveBeenCalledWith(`${HOME}/.abu/agents/reviewer`, { recursive: true });
  });

  it('never removes a folder outside ~/.abu/<folder>/ — a project-level item is only copied from', async () => {
    await saveItemToAbuDir('agents', 'AGENT.md', 'reviewer', 'md', '/work/repo/.abu/agents/reviewer/AGENT.md');

    expect(writeTextFile).toHaveBeenCalledWith(`${HOME}/.abu/agents/reviewer/AGENT.md`, 'md');
    expect(remove).not.toHaveBeenCalled();
  });

  it('never removes the ~/.abu/<folder>/ root itself', async () => {
    await saveItemToAbuDir('agents', 'AGENT.md', 'reviewer', 'md', `${HOME}/.abu/agents/AGENT.md`);

    expect(remove).not.toHaveBeenCalled();
  });

  it('still removes the old folder when the paths use Windows separators', async () => {
    vi.mocked(homeDir).mockResolvedValue('C:\\Users\\tester');

    await saveItemToAbuDir('agents', 'AGENT.md', 'writer', 'md', 'C:\\Users\\tester\\.abu\\agents\\reviewer\\AGENT.md');

    expect(remove).toHaveBeenCalledWith('C:/Users/tester/.abu/agents/reviewer', { recursive: true });
  });

  it('keeps the folder after a letter-case-only rename (it is the folder just written)', async () => {
    await saveItemToAbuDir('agents', 'AGENT.md', 'reviewer', 'md', `${HOME}/.abu/agents/Reviewer/AGENT.md`);

    expect(writeTextFile).toHaveBeenCalledWith(`${HOME}/.abu/agents/reviewer/AGENT.md`, 'md');
    expect(remove).not.toHaveBeenCalled();
  });
});
