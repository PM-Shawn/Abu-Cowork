/**
 * saveItemToAbuDir is the one writer behind the agent and skill editors.
 * - `mustBeNew`: a create/rename must refuse an item already on disk instead
 *   of overwriting it.
 * - It never deletes anything. A rename MOVES the item's own folder under
 *   ~/.abu/<folder>/ (so a skill's scripts/ and an agent's memory.md go with
 *   it) — letter-case-only renames included — and only a genuine sibling item
 *   folder qualifies: `.`/`..` spellings, the root itself and any folder
 *   outside ~/.abu/<folder>/ are never moved, only copied from.
 * - A name that is not one plain folder name is refused before the disk is
 *   touched.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { exists, mkdir, remove, rename, writeTextFile } from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';
import { ITEM_EXISTS_CODE, ITEM_NAME_INVALID_CODE, saveItemToAbuDir } from './itemStorage';

const HOME = '/Users/tester';

/** Make `exists` answer true for exactly these paths. */
function onDisk(...paths: string[]): void {
  vi.mocked(exists).mockImplementation(async (p) => paths.includes(String(p)));
}

/** Nothing moved, nothing removed. */
function expectNoMoveNoRemove(): void {
  expect(rename).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(homeDir).mockResolvedValue(HOME);
  vi.mocked(exists).mockResolvedValue(false);
});

describe('saveItemToAbuDir', () => {
  describe('mustBeNew', () => {
    it('refuses, writing nothing, when mustBeNew finds the manifest already there', async () => {
      vi.mocked(exists).mockResolvedValue(true);

      await expect(
        saveItemToAbuDir('agents', 'AGENT.md', 'reviewer', 'md', undefined, { mustBeNew: true }),
      ).rejects.toMatchObject({ code: ITEM_EXISTS_CODE });
      expect(exists).toHaveBeenCalledWith(`${HOME}/.abu/agents/reviewer/AGENT.md`);
      expect(mkdir).not.toHaveBeenCalled();
      expect(writeTextFile).not.toHaveBeenCalled();
      expectNoMoveNoRemove();
    });

    it('writes a new item with the host\'s create-only flag when nothing is there', async () => {
      await saveItemToAbuDir('skills', 'SKILL.md', 'fresh', 'md', undefined, { mustBeNew: true });

      expect(writeTextFile).toHaveBeenCalledWith(`${HOME}/.abu/skills/fresh/SKILL.md`, 'md', { createNew: true });
    });

    it('refuses a rename onto a name whose manifest is already on disk — nothing moved', async () => {
      onDisk(`${HOME}/.abu/agents/writer/AGENT.md`, `${HOME}/.abu/agents/reviewer`);

      await expect(
        saveItemToAbuDir('agents', 'AGENT.md', 'writer', 'md', `${HOME}/.abu/agents/reviewer/AGENT.md`, { mustBeNew: true }),
      ).rejects.toMatchObject({ code: ITEM_EXISTS_CODE });
      expect(writeTextFile).not.toHaveBeenCalled();
      expectNoMoveNoRemove();
    });
  });

  it('overwrites without asking when the caller is saving the item in place', async () => {
    vi.mocked(exists).mockResolvedValue(true);

    await saveItemToAbuDir('agents', 'AGENT.md', 'reviewer', 'md');

    expect(exists).not.toHaveBeenCalled();
    expect(writeTextFile).toHaveBeenCalledWith(`${HOME}/.abu/agents/reviewer/AGENT.md`, 'md');
    expectNoMoveNoRemove();
  });

  describe('rename = move', () => {
    it('moves the old folder to the new name, then writes the manifest into it — never removes', async () => {
      onDisk(`${HOME}/.abu/skills/render`);

      await saveItemToAbuDir('skills', 'SKILL.md', 'render-v2', 'md', `${HOME}/.abu/skills/render/SKILL.md`, { mustBeNew: true });

      expect(rename).toHaveBeenCalledWith(`${HOME}/.abu/skills/render`, `${HOME}/.abu/skills/render-v2`);
      expect(writeTextFile).toHaveBeenCalledWith(`${HOME}/.abu/skills/render-v2/SKILL.md`, 'md');
      // The move happened before the write: the manifest lands in the moved folder.
      expect(vi.mocked(rename).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(writeTextFile).mock.invocationCallOrder[0]);
      expect(mkdir).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    });

    it('moves an agent folder (and so its memory.md) with Windows separators', async () => {
      vi.mocked(homeDir).mockResolvedValue('C:\\Users\\tester');
      onDisk('C:/Users/tester/.abu/agents/reviewer');

      await saveItemToAbuDir('agents', 'AGENT.md', 'writer', 'md', 'C:\\Users\\tester\\.abu\\agents\\reviewer\\AGENT.md');

      expect(rename).toHaveBeenCalledWith('C:/Users/tester/.abu/agents/reviewer', 'C:/Users/tester/.abu/agents/writer');
      expect(writeTextFile).toHaveBeenCalledWith('C:/Users/tester/.abu/agents/writer/AGENT.md', 'md');
      expect(remove).not.toHaveBeenCalled();
    });

    it('moves on a letter-case-only rename, so the folder\'s case really changes', async () => {
      onDisk(`${HOME}/.abu/agents/Reviewer`);

      await saveItemToAbuDir('agents', 'AGENT.md', 'reviewer', 'md', `${HOME}/.abu/agents/Reviewer/AGENT.md`);

      expect(rename).toHaveBeenCalledWith(`${HOME}/.abu/agents/Reviewer`, `${HOME}/.abu/agents/reviewer`);
      expect(writeTextFile).toHaveBeenCalledWith(`${HOME}/.abu/agents/reviewer/AGENT.md`, 'md');
      expect(remove).not.toHaveBeenCalled();
    });

    it('writes in place when the old folder already has the target name', async () => {
      onDisk(`${HOME}/.abu/agents/reviewer`);

      await saveItemToAbuDir('agents', 'AGENT.md', 'reviewer', 'md', `${HOME}/.abu/agents/reviewer/AGENT.md`);

      expect(writeTextFile).toHaveBeenCalledWith(`${HOME}/.abu/agents/reviewer/AGENT.md`, 'md');
      expectNoMoveNoRemove();
    });

    it('writes afresh when the old folder is already gone (nothing to carry)', async () => {
      await saveItemToAbuDir('agents', 'AGENT.md', 'writer', 'md', `${HOME}/.abu/agents/reviewer/AGENT.md`, { mustBeNew: true });

      expect(writeTextFile).toHaveBeenCalledWith(`${HOME}/.abu/agents/writer/AGENT.md`, 'md', { createNew: true });
      expectNoMoveNoRemove();
    });

    it('surfaces a failed move and writes nothing (the OS refuses to rename onto an occupied folder)', async () => {
      onDisk(`${HOME}/.abu/agents/reviewer`);
      vi.mocked(rename).mockRejectedValueOnce(new Error('ENOTEMPTY'));

      await expect(
        saveItemToAbuDir('agents', 'AGENT.md', 'writer', 'md', `${HOME}/.abu/agents/reviewer/AGENT.md`),
      ).rejects.toThrow('ENOTEMPTY');
      expect(writeTextFile).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    });
  });

  describe('only a genuine sibling item folder under ~/.abu/<folder>/ is ever moved', () => {
    const notOwned: Array<[string, string]> = [
      ['the root spelled with a `.` segment', `${HOME}/.abu/agents/./AGENT.md`],
      ['the parent spelled with a `..` segment', `${HOME}/.abu/agents/../AGENT.md`],
      ['`..` inside an item folder', `${HOME}/.abu/agents/reviewer/../AGENT.md`],
      ['a trailing slash after the manifest', `${HOME}/.abu/agents/reviewer/AGENT.md/`],
      ['a `.` folder with a trailing slash', `${HOME}/.abu/agents/./`],
      ['a doubled separator', `${HOME}/.abu/agents//AGENT.md`],
      ['a `..` detour that lands back on a sibling', `${HOME}/.abu/agents/../agents/reviewer/AGENT.md`],
      ['the root itself', `${HOME}/.abu/agents/AGENT.md`],
      ['a project-level item', '/work/repo/.abu/agents/reviewer/AGENT.md'],
      ['the other item kind\'s folder', `${HOME}/.abu/skills/reviewer/AGENT.md`],
    ];

    it.each(notOwned)('%s: copies into ~/.abu, moves and removes nothing', async (_label, oldFilePath) => {
      vi.mocked(exists).mockResolvedValue(true); // every folder "exists": only the structural check decides

      await saveItemToAbuDir('agents', 'AGENT.md', 'writer', 'md', oldFilePath);

      expect(writeTextFile).toHaveBeenCalledWith(`${HOME}/.abu/agents/writer/AGENT.md`, 'md');
      expectNoMoveNoRemove();
    });

    it('a Windows home in backslashes with a `.` segment is refused too', async () => {
      vi.mocked(homeDir).mockResolvedValue('C:\\Users\\tester');
      vi.mocked(exists).mockResolvedValue(true);

      await saveItemToAbuDir('agents', 'AGENT.md', 'writer', 'md', 'C:\\Users\\tester\\.abu\\agents\\.\\AGENT.md');
      await saveItemToAbuDir('agents', 'AGENT.md', 'writer', 'md', 'C:\\Users\\tester\\.abu\\agents\\..\\AGENT.md');

      expectNoMoveNoRemove();
    });

    it('a project-level item is copied even under mustBeNew, and the original is untouched', async () => {
      await saveItemToAbuDir('skills', 'SKILL.md', 'render-v2', 'md', '/work/repo/.abu/skills/render/SKILL.md', { mustBeNew: true });

      expect(writeTextFile).toHaveBeenCalledWith(`${HOME}/.abu/skills/render-v2/SKILL.md`, 'md', { createNew: true });
      expectNoMoveNoRemove();
    });
  });

  describe('a name that is not one plain folder name is refused before touching disk', () => {
    const invalid = ['', ' ', '.', '..', 'a/b', '../x', 'a\\b', ' lead', 'trail ', 'nul\u0000x', 'tab\tx', 'del\u007fx'];

    it.each(invalid)('%j', async (name) => {
      await expect(
        saveItemToAbuDir('agents', 'AGENT.md', name, 'md', `${HOME}/.abu/agents/reviewer/AGENT.md`),
      ).rejects.toMatchObject({ code: ITEM_NAME_INVALID_CODE });
      expect(homeDir).not.toHaveBeenCalled();
      expect(exists).not.toHaveBeenCalled();
      expect(mkdir).not.toHaveBeenCalled();
      expect(writeTextFile).not.toHaveBeenCalled();
      expectNoMoveNoRemove();
    });

    it('accepts a unicode name (the create_agent tool allows letters of any script)', async () => {
      await saveItemToAbuDir('agents', 'AGENT.md', '产品经理', 'md');

      expect(writeTextFile).toHaveBeenCalledWith(`${HOME}/.abu/agents/产品经理/AGENT.md`, 'md');
    });
  });
});
