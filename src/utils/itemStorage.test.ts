/**
 * saveItemToAbuDir is the one writer behind the agent and skill editors.
 * - A NEW item goes to ~/.abu/<folder>/<name>/; `mustBeNew` refuses an item
 *   already on disk instead of overwriting it.
 * - An EXISTING item is saved where it lives — ~/.abu, a project, the shared
 *   ~/.agents folder — never copied into ~/.abu (the copy overwrote the
 *   user's same-named item and was shadowed by the project item: finding I4).
 *   A rename writes the manifest in place, then MOVES the item's folder
 *   within its own parent, putting the old text back if the move fails.
 * - It never deletes anything, and it only touches a path spelled like an
 *   item: `<…>/<agents|skills>/<plain item>/<manifest>`, whose folder and
 *   manifest are a plain folder and a plain file right now — no links.
 * - A name that is not one plain folder name is refused before the disk is
 *   touched.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { exists, lstat, mkdir, readTextFile, remove, rename, writeTextFile } from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';
import { ITEM_EXISTS_CODE, ITEM_NAME_INVALID_CODE, saveItemToAbuDir } from './itemStorage';

const HOME = '/Users/tester';
const PROJECT = '/work/repo';

/** Make `exists` answer true for exactly these paths. */
function onDisk(...paths: string[]): void {
  vi.mocked(exists).mockImplementation(async (p) => paths.includes(String(p)));
}

/** Nothing moved, nothing removed. */
function expectNoMoveNoRemove(): void {
  expect(rename).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
}

/** Nothing written, moved or removed. */
function expectUntouched(): void {
  expect(mkdir).not.toHaveBeenCalled();
  expect(writeTextFile).not.toHaveBeenCalled();
  expectNoMoveNoRemove();
}

type Info = Awaited<ReturnType<typeof lstat>>;
const PLAIN_FILE = { isFile: true, isDirectory: false, isSymlink: false } as Info;
const PLAIN_DIR = { isFile: false, isDirectory: true, isSymlink: false } as Info;
const LINK = { isFile: false, isDirectory: false, isSymlink: true } as Info;

/** `lstat` of the item: folders are plain folders, `*.md` plain files, unless overridden. */
function lstatAs(overrides: Record<string, Info | Error> = {}): void {
  vi.mocked(lstat).mockImplementation(async (p) => {
    const hit = overrides[String(p)];
    if (hit instanceof Error) throw hit;
    return hit ?? (/\.md$/i.test(String(p)) ? PLAIN_FILE : PLAIN_DIR);
  });
}

/** Every path writeTextFile was called with. */
function writtenPaths(): string[] {
  return vi.mocked(writeTextFile).mock.calls.map(([p]) => String(p));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(homeDir).mockResolvedValue(HOME);
  vi.mocked(exists).mockResolvedValue(false);
  // The item being edited is a plain folder whose manifest holds its previous text.
  lstatAs();
  vi.mocked(readTextFile).mockResolvedValue('original');
  vi.mocked(rename).mockResolvedValue(undefined);
  vi.mocked(writeTextFile).mockResolvedValue(undefined);
});

describe('saveItemToAbuDir', () => {
  describe('a new item goes to ~/.abu/<folder>/<name>/', () => {
    it('refuses, writing nothing, when mustBeNew finds the manifest already there', async () => {
      vi.mocked(exists).mockResolvedValue(true);

      await expect(
        saveItemToAbuDir('agents', 'AGENT.md', 'reviewer', 'md', undefined, { mustBeNew: true }),
      ).rejects.toMatchObject({ code: ITEM_EXISTS_CODE });
      expect(exists).toHaveBeenCalledWith(`${HOME}/.abu/agents/reviewer/AGENT.md`);
      expectUntouched();
    });

    it('writes with the host\'s create-only flag when nothing is there', async () => {
      await saveItemToAbuDir('skills', 'SKILL.md', 'fresh', 'md', undefined, { mustBeNew: true });

      expect(mkdir).toHaveBeenCalledWith(`${HOME}/.abu/skills/fresh`, { recursive: true });
      expect(writeTextFile).toHaveBeenCalledWith(`${HOME}/.abu/skills/fresh/SKILL.md`, 'md', { createNew: true });
    });

    it('without mustBeNew writes without probing', async () => {
      vi.mocked(exists).mockResolvedValue(true);

      await saveItemToAbuDir('agents', 'AGENT.md', 'reviewer', 'md');

      expect(exists).not.toHaveBeenCalled();
      expect(writeTextFile).toHaveBeenCalledWith(`${HOME}/.abu/agents/reviewer/AGENT.md`, 'md');
      expectNoMoveNoRemove();
    });

    it('accepts a unicode name (the create_agent tool allows letters of any script)', async () => {
      await saveItemToAbuDir('agents', 'AGENT.md', '产品经理', 'md');

      expect(writeTextFile).toHaveBeenCalledWith(`${HOME}/.abu/agents/产品经理/AGENT.md`, 'md');
    });
  });

  describe('an existing item is saved in its own file, wherever it lives', () => {
    const locations: Array<[string, 'agents' | 'skills', 'AGENT.md' | 'SKILL.md', string]> = [
      ['the user\'s own expert', 'agents', 'AGENT.md', `${HOME}/.abu/agents/reviewer/AGENT.md`],
      ['a project expert', 'agents', 'AGENT.md', `${PROJECT}/.abu/agents/reviewer/AGENT.md`],
      ['a project skill', 'skills', 'SKILL.md', `${PROJECT}/.abu/skills/reviewer/SKILL.md`],
      ['a project skill in the cross-client folder', 'skills', 'SKILL.md', `${PROJECT}/.agents/skills/reviewer/SKILL.md`],
      ['a skill Abu wrote for this project', 'skills', 'SKILL.md', `${HOME}/.abu/projects/-work-repo/skills/reviewer/SKILL.md`],
      ['a skill in the shared ~/.agents folder', 'skills', 'SKILL.md', `${HOME}/.agents/skills/reviewer/SKILL.md`],
    ];

    it.each(locations)('%s', async (_label, folder, fileName, filePath) => {
      // A same-named user item exists: it must not be touched.
      onDisk(`${HOME}/.abu/${folder}/reviewer/${fileName}`, `${HOME}/.abu/${folder}/reviewer`);

      await saveItemToAbuDir(folder, fileName, 'reviewer', 'md', filePath);

      expect(writeTextFile).toHaveBeenCalledTimes(1);
      // create: false — a manifest that is gone is refused, not recreated.
      expect(writeTextFile).toHaveBeenCalledWith(filePath, 'md', { create: false });
      expect(mkdir).not.toHaveBeenCalled();
      expectNoMoveNoRemove();
    });

    it('never writes into ~/.abu when saving a project item, even under mustBeNew', async () => {
      onDisk(`${HOME}/.abu/skills/render/SKILL.md`);

      await saveItemToAbuDir('skills', 'SKILL.md', 'render', 'md', `${PROJECT}/.abu/skills/render/SKILL.md`, { mustBeNew: true });

      expect(writtenPaths()).toEqual([`${PROJECT}/.abu/skills/render/SKILL.md`]);
      expect(exists).not.toHaveBeenCalled();
    });

    it('keeps a lower-case manifest name', async () => {
      await saveItemToAbuDir('agents', 'AGENT.md', 'reviewer', 'md', `${PROJECT}/.abu/agents/reviewer/agent.md`);

      expect(writeTextFile).toHaveBeenCalledWith(`${PROJECT}/.abu/agents/reviewer/agent.md`, 'md', { create: false });
    });

    it('accepts Windows separators', async () => {
      await saveItemToAbuDir('skills', 'SKILL.md', 'reviewer', 'md', 'D:\\work\\repo\\.abu\\skills\\reviewer\\SKILL.md');

      expect(writeTextFile).toHaveBeenCalledWith('D:/work/repo/.abu/skills/reviewer/SKILL.md', 'md', { create: false });
    });
  });

  describe('rename = write in place, then move the folder within its own parent', () => {
    it('in ~/.abu: never removes, never creates a folder', async () => {
      await saveItemToAbuDir('skills', 'SKILL.md', 'render-v2', 'md', `${HOME}/.abu/skills/render/SKILL.md`, { mustBeNew: true });

      expect(writeTextFile).toHaveBeenCalledWith(`${HOME}/.abu/skills/render/SKILL.md`, 'md', { create: false });
      expect(rename).toHaveBeenCalledWith(`${HOME}/.abu/skills/render`, `${HOME}/.abu/skills/render-v2`);
      // The manifest is written before the move, so a failed write moves nothing.
      expect(vi.mocked(writeTextFile).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(rename).mock.invocationCallOrder[0]);
      expect(mkdir).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    });

    it('in a project: the folder stays in the project and nothing lands in ~/.abu', async () => {
      await saveItemToAbuDir('skills', 'SKILL.md', 'render-v2', 'md', `${PROJECT}/.abu/skills/render/SKILL.md`, { mustBeNew: true });

      expect(exists).toHaveBeenCalledWith(`${PROJECT}/.abu/skills/render-v2/SKILL.md`);
      expect(writtenPaths()).toEqual([`${PROJECT}/.abu/skills/render/SKILL.md`]);
      expect(rename).toHaveBeenCalledWith(`${PROJECT}/.abu/skills/render`, `${PROJECT}/.abu/skills/render-v2`);
      expect(mkdir).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    });

    it('moves an agent folder (and so its memory.md) with Windows separators', async () => {
      await saveItemToAbuDir('agents', 'AGENT.md', 'writer', 'md', 'C:\\Users\\tester\\.abu\\agents\\reviewer\\AGENT.md');

      expect(writeTextFile).toHaveBeenCalledWith('C:/Users/tester/.abu/agents/reviewer/AGENT.md', 'md', { create: false });
      expect(rename).toHaveBeenCalledWith('C:/Users/tester/.abu/agents/reviewer', 'C:/Users/tester/.abu/agents/writer');
      expect(remove).not.toHaveBeenCalled();
    });

    it('moves on a letter-case-only rename, so the folder\'s case really changes', async () => {
      await saveItemToAbuDir('agents', 'AGENT.md', 'reviewer', 'md', `${HOME}/.abu/agents/Reviewer/AGENT.md`);

      expect(rename).toHaveBeenCalledWith(`${HOME}/.abu/agents/Reviewer`, `${HOME}/.abu/agents/reviewer`);
      expect(remove).not.toHaveBeenCalled();
    });

    it('refuses a rename onto a name already on disk in the item\'s own folder — nothing written or moved', async () => {
      onDisk(`${PROJECT}/.abu/agents/writer/AGENT.md`);

      await expect(
        saveItemToAbuDir('agents', 'AGENT.md', 'writer', 'md', `${PROJECT}/.abu/agents/reviewer/AGENT.md`, { mustBeNew: true }),
      ).rejects.toMatchObject({ code: ITEM_EXISTS_CODE });
      expectUntouched();
    });

    it('a failed move puts the old text back and surfaces the error — nothing removed', async () => {
      vi.mocked(rename).mockRejectedValueOnce(new Error('ENOTEMPTY'));

      await expect(
        saveItemToAbuDir('agents', 'AGENT.md', 'writer', 'md', `${HOME}/.abu/agents/reviewer/AGENT.md`, { mustBeNew: true }),
      ).rejects.toThrow('ENOTEMPTY');
      expect(vi.mocked(writeTextFile).mock.calls).toEqual([
        [`${HOME}/.abu/agents/reviewer/AGENT.md`, 'md', { create: false }],
        [`${HOME}/.abu/agents/reviewer/AGENT.md`, 'original', { create: false }],
      ]);
      expect(remove).not.toHaveBeenCalled();
    });

    it('a failed move keeps the original error even when putting the text back fails too', async () => {
      vi.mocked(rename).mockRejectedValueOnce(new Error('ENOTEMPTY'));
      vi.mocked(writeTextFile).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('EACCES'));

      await expect(
        saveItemToAbuDir('agents', 'AGENT.md', 'writer', 'md', `${HOME}/.abu/agents/reviewer/AGENT.md`),
      ).rejects.toThrow('ENOTEMPTY');
    });

    it('a retry after a failed move is not refused as a name collision', async () => {
      vi.mocked(rename).mockRejectedValueOnce(new Error('EBUSY'));
      const save = () => saveItemToAbuDir('skills', 'SKILL.md', 'render-v2', 'md', `${HOME}/.abu/skills/render/SKILL.md`, { mustBeNew: true });

      await expect(save()).rejects.toThrow('EBUSY');
      await expect(save()).resolves.toBeUndefined();
      expect(rename).toHaveBeenLastCalledWith(`${HOME}/.abu/skills/render`, `${HOME}/.abu/skills/render-v2`);
    });

    it('a failed manifest write moves nothing', async () => {
      vi.mocked(writeTextFile).mockRejectedValueOnce(new Error('EROFS'));

      await expect(
        saveItemToAbuDir('skills', 'SKILL.md', 'render-v2', 'md', `${PROJECT}/.abu/skills/render/SKILL.md`),
      ).rejects.toThrow('EROFS');
      expectNoMoveNoRemove();
    });
  });

  describe('the item folder and its manifest must still be plain', () => {
    const manifest = `${PROJECT}/.abu/skills/render/SKILL.md`;
    const itemDir = `${PROJECT}/.abu/skills/render`;
    const notPlain: Array<[string, () => void]> = [
      ['a symlinked manifest', () => lstatAs({ [manifest]: LINK })],
      ['a directory at the manifest', () => lstatAs({ [manifest]: PLAIN_DIR })],
      ['a manifest that is gone', () => lstatAs({ [manifest]: new Error('ENOENT') })],
      // The host resolves every parent of an lstat'ed path, so a linked item
      // folder answers "plain file" for its manifest: the folder is checked too.
      ['an item folder swapped for a link since the scan', () => lstatAs({ [itemDir]: LINK })],
      ['an item folder that is gone', () => lstatAs({ [itemDir]: new Error('ENOENT') })],
    ];

    it.each(notPlain)('%s: refused, nothing written or moved', async (_label, arrange) => {
      arrange();

      await expect(
        saveItemToAbuDir('skills', 'SKILL.md', 'render', 'md', `${PROJECT}/.abu/skills/render/SKILL.md`),
      ).rejects.toThrow();
      await expect(
        saveItemToAbuDir('skills', 'SKILL.md', 'render-v2', 'md', `${PROJECT}/.abu/skills/render/SKILL.md`),
      ).rejects.toThrow();
      expectUntouched();
    });
  });

  describe('only a path spelled like an item is ever touched', () => {
    const notAnItem: Array<[string, string]> = [
      ['the root spelled with a `.` segment', `${HOME}/.abu/agents/./AGENT.md`],
      ['the parent spelled with a `..` segment', `${HOME}/.abu/agents/../AGENT.md`],
      ['`..` inside an item folder', `${HOME}/.abu/agents/reviewer/../AGENT.md`],
      ['a trailing slash after the manifest', `${HOME}/.abu/agents/reviewer/AGENT.md/`],
      ['a `.` folder with a trailing slash', `${HOME}/.abu/agents/./`],
      ['a doubled separator', `${HOME}/.abu/agents//AGENT.md`],
      ['a `..` detour that lands back on a sibling', `${HOME}/.abu/agents/../agents/reviewer/AGENT.md`],
      ['a manifest directly in the root (a rename would move the root)', `${HOME}/.abu/agents/AGENT.md`],
      ['the other item kind\'s folder', `${HOME}/.abu/skills/reviewer/AGENT.md`],
      ['a file that is not the manifest', `${HOME}/.abu/agents/reviewer/memory.md`],
      ['the bundled builtin-agents folder', '/Applications/Abu.app/Contents/Resources/builtin-agents/reviewer/AGENT.md'],
      ['the builtin marker', '__builtin__'],
      ['a relative path', 'agents/reviewer/AGENT.md'],
      ['a Windows `.` segment', 'C:\\Users\\tester\\.abu\\agents\\.\\AGENT.md'],
    ];

    it.each(notAnItem)('%s: refused, nothing written or moved', async (_label, oldFilePath) => {
      vi.mocked(exists).mockResolvedValue(true);

      await expect(saveItemToAbuDir('agents', 'AGENT.md', 'writer', 'md', oldFilePath)).rejects.toThrow();
      await expect(saveItemToAbuDir('agents', 'AGENT.md', 'reviewer', 'md', oldFilePath)).rejects.toThrow();
      expect(lstat).not.toHaveBeenCalled();
      expectUntouched();
    });

    it('the enterprise skills folder is not an item root', async () => {
      await expect(
        saveItemToAbuDir('skills', 'SKILL.md', 'policy', 'md', `${HOME}/Library/Application Support/abu/skills/enterprise/policy/SKILL.md`),
      ).rejects.toThrow();
      expectUntouched();
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
      expect(lstat).not.toHaveBeenCalled();
      expectUntouched();
    });
  });
});
