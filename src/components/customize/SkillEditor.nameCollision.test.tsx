// @vitest-environment happy-dom
/**
 * Same data-loss path as the agent editor: the skill editor used to write
 * `~/.abu/skills/<name>/SKILL.md` unconditionally and delete the old folder on
 * rename, so creating a skill under an existing skill's name (or renaming onto
 * one) silently replaced it. A new or renamed skill must refuse any name
 * another skill already uses — case-insensitively — without colliding with itself.
 *
 * Saving now never deletes: it writes the skill's own file in place —
 * wherever it lives, a project included — or moves the skill's own folder
 * (scripts/ and references/ included) to its name within the same parent —
 * itemStorage.test.ts. The last block runs the real storage layer for a
 * project skill and for an edit whose folder is not named after the skill.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { Skill, SkillMetadata } from '@/types';

vi.mock('@/utils/itemStorage', () => ({
  ITEM_EXISTS_CODE: 'ITEM_EXISTS',
  ITEM_NAME_INVALID_CODE: 'ITEM_NAME_INVALID',
  saveItemToAbuDir: vi.fn(async () => undefined),
}));

import { saveItemToAbuDir } from '@/utils/itemStorage';
import { exists, lstat, readTextFile, remove, rename, writeTextFile } from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';
import { skillLoader } from '@/core/skill/loader';
import { getI18n } from '@/i18n';
import SkillEditor from './SkillEditor';

const summarize: Skill = {
  name: 'summarize',
  description: 'Summarizes',
  source: 'user',
  content: 'Summarize things.',
  filePath: '/Users/tester/.abu/skills/summarize/SKILL.md',
  skillDir: '/Users/tester/.abu/skills/summarize',
};

const known: SkillMetadata[] = [
  { name: 'summarize', description: '', source: 'user' },
  { name: 'deep-research', description: '', source: 'builtin' },
  // A disabled plugin's skill still owns its name.
  { name: 'weather', description: '', source: 'plugin' },
];

const saveButton = (): HTMLButtonElement =>
  screen.getByText(getI18n().toolbox.skillSave).closest('button')! as HTMLButtonElement;
const nameInput = (): HTMLInputElement => screen.getByPlaceholderText('my-skill') as HTMLInputElement;
const takenHint = () => screen.queryByText(getI18n().toolbox.skillNameTakenHint);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(skillLoader, 'getAvailableSkills').mockReturnValue(known);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SkillEditor — a new or renamed skill cannot take another skill\'s name', () => {
  it('blocks creating a skill under an existing skill\'s name: hint shown, save disabled, nothing written', async () => {
    render(<SkillEditor skill={null} onClose={vi.fn()} onSave={vi.fn(async () => undefined)} />);
    fireEvent.change(nameInput(), { target: { value: 'summarize' } });

    expect(takenHint()).not.toBeNull();
    expect(saveButton().disabled).toBe(true);
    fireEvent.click(saveButton());
    await Promise.resolve();
    expect(vi.mocked(saveItemToAbuDir)).not.toHaveBeenCalled();
    expect(skillLoader.getAvailableSkills).toHaveBeenCalledWith({ includeDrafts: true, includeDisabledPlugins: true });
  });

  it('blocks a builtin skill\'s name', () => {
    render(<SkillEditor skill={null} onClose={vi.fn()} onSave={vi.fn(async () => undefined)} />);
    fireEvent.change(nameInput(), { target: { value: 'deep-research' } });

    expect(takenHint()).not.toBeNull();
    expect(saveButton().disabled).toBe(true);
  });

  it('blocks renaming onto another skill\'s name', async () => {
    render(<SkillEditor skill={summarize} onClose={vi.fn()} onSave={vi.fn(async () => undefined)} />);
    fireEvent.change(nameInput(), { target: { value: 'weather' } });

    expect(takenHint()).not.toBeNull();
    expect(saveButton().disabled).toBe(true);
    fireEvent.click(saveButton());
    await Promise.resolve();
    expect(vi.mocked(saveItemToAbuDir)).not.toHaveBeenCalled();
  });

  it('allows renaming a skill to its own name in a different letter case', async () => {
    const upper: Skill = { ...summarize, name: 'Summarize', filePath: '/Users/tester/.abu/skills/Summarize/SKILL.md' };
    vi.mocked(skillLoader.getAvailableSkills).mockReturnValue([{ name: 'Summarize', description: '' }]);
    render(<SkillEditor skill={upper} onClose={vi.fn()} onSave={vi.fn(async () => undefined)} />);
    fireEvent.change(nameInput(), { target: { value: 'summarize' } });

    expect(takenHint()).toBeNull();
    fireEvent.click(saveButton());

    await waitFor(() => expect(vi.mocked(saveItemToAbuDir)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(saveItemToAbuDir).mock.calls[0][5]).toEqual({ mustBeNew: false });
  });

  it('allows a unique name and asks the disk to refuse if one appeared meanwhile', async () => {
    const onSave = vi.fn(async () => undefined);
    render(<SkillEditor skill={null} onClose={vi.fn()} onSave={onSave} />);
    fireEvent.change(nameInput(), { target: { value: 'fresh-skill' } });

    expect(takenHint()).toBeNull();
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const [folder, , savedName, , , options] = vi.mocked(saveItemToAbuDir).mock.calls[0];
    expect([folder, savedName]).toEqual(['skills', 'fresh-skill']);
    expect(options).toEqual({ mustBeNew: true });
  });

  it('shows the hint and does not close when the disk refuses the name at save time', async () => {
    vi.mocked(saveItemToAbuDir).mockRejectedValueOnce(Object.assign(new Error('exists'), { code: 'ITEM_EXISTS' }));
    const onSave = vi.fn(async () => undefined);
    render(<SkillEditor skill={null} onClose={vi.fn()} onSave={onSave} />);
    fireEvent.change(nameInput(), { target: { value: 'fresh-skill' } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(takenHint()).not.toBeNull());
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe('SkillEditor — a save failure is never silent', () => {
  it('shows a save-failed message under Save and stays open', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(saveItemToAbuDir).mockRejectedValueOnce(new Error('EACCES: permission denied'));
    const onSave = vi.fn(async () => undefined);
    render(<SkillEditor skill={summarize} onClose={vi.fn()} onSave={onSave} />);

    fireEvent.click(saveButton());
    await waitFor(() => expect(screen.queryByText(getI18n().toolbox.itemSaveFailed)).not.toBeNull());
    expect(onSave).not.toHaveBeenCalled();
    expect(saveButton().disabled).toBe(false);
  });
});

describe('SkillEditor — editing an existing skill saves through its own folder (real storage layer)', () => {
  const HOME = '/Users/tester';

  beforeEach(async () => {
    const actual = await vi.importActual<{ saveItemToAbuDir: typeof saveItemToAbuDir }>('@/utils/itemStorage');
    vi.mocked(saveItemToAbuDir).mockImplementation(actual.saveItemToAbuDir);
    vi.mocked(homeDir).mockResolvedValue(HOME);
    // The skill's SKILL.md is a plain file in a plain folder, holding its previous text.
    vi.mocked(lstat).mockImplementation(async (p) => ({ isFile: /\.md$/i.test(String(p)), isDirectory: !/\.md$/i.test(String(p)), isSymlink: false }) as Awaited<ReturnType<typeof lstat>>);
    vi.mocked(readTextFile).mockResolvedValue('original');
  });

  afterEach(() => {
    vi.mocked(saveItemToAbuDir).mockImplementation(async () => undefined);
    vi.mocked(exists).mockResolvedValue(false);
    vi.mocked(lstat).mockResolvedValue({ isSymlink: false } as Awaited<ReturnType<typeof lstat>>);
    vi.mocked(readTextFile).mockResolvedValue('');
  });

  /** Every path writeTextFile was called with. */
  const writtenPaths = () => vi.mocked(writeTextFile).mock.calls.map(([p]) => String(p));

  const onDisk = (...paths: string[]) => vi.mocked(exists).mockImplementation(async (p) => paths.includes(String(p)));
  const mismatched: Skill = {
    ...summarize,
    filePath: `${HOME}/.abu/skills/summarize-old/SKILL.md`,
    skillDir: `${HOME}/.abu/skills/summarize-old`,
  };

  it('an ordinary edit (folder named after the skill) writes in place — no move, no removal', async () => {
    onDisk(`${HOME}/.abu/skills/summarize`, `${HOME}/.abu/skills/summarize/SKILL.md`);
    const onSave = vi.fn(async () => undefined);
    render(<SkillEditor skill={summarize} onClose={vi.fn()} onSave={onSave} />);
    fireEvent.click(saveButton());

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(writeTextFile).toHaveBeenCalledWith(`${HOME}/.abu/skills/summarize/SKILL.md`, expect.any(String), { create: false });
    expect(rename).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('a project skill is saved in its own file — the user\'s same-named skill in ~/.abu is never written', async () => {
    const projectSkill: Skill = {
      ...summarize,
      source: 'project',
      filePath: '/work/repo/.abu/skills/summarize/SKILL.md',
      skillDir: '/work/repo/.abu/skills/summarize',
    };
    onDisk(`${HOME}/.abu/skills/summarize`, `${HOME}/.abu/skills/summarize/SKILL.md`);
    const onSave = vi.fn(async () => undefined);
    render(<SkillEditor skill={projectSkill} onClose={vi.fn()} onSave={onSave} />);
    fireEvent.click(saveButton());

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(writtenPaths()).toEqual(['/work/repo/.abu/skills/summarize/SKILL.md']);
    expect(rename).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('a skill whose folder is not named after it is moved (with its scripts) to its name when that folder is free', async () => {
    onDisk(`${HOME}/.abu/skills/summarize-old`);
    const onSave = vi.fn(async () => undefined);
    render(<SkillEditor skill={mismatched} onClose={vi.fn()} onSave={onSave} />);
    fireEvent.click(saveButton());

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    // Written in place first, then the folder (and so its scripts/) is moved.
    expect(writeTextFile).toHaveBeenCalledWith(`${HOME}/.abu/skills/summarize-old/SKILL.md`, expect.any(String), { create: false });
    expect(rename).toHaveBeenCalledWith(`${HOME}/.abu/skills/summarize-old`, `${HOME}/.abu/skills/summarize`);
    expect(remove).not.toHaveBeenCalled();
  });

  it('when its name\'s folder holds another skill, the save fails visibly and that skill\'s file is untouched', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    onDisk(`${HOME}/.abu/skills/summarize-old`, `${HOME}/.abu/skills/summarize`, `${HOME}/.abu/skills/summarize/SKILL.md`);
    vi.mocked(rename).mockRejectedValueOnce(new Error('ENOTEMPTY: directory not empty'));
    const onSave = vi.fn(async () => undefined);
    render(<SkillEditor skill={mismatched} onClose={vi.fn()} onSave={onSave} />);
    fireEvent.click(saveButton());

    await waitFor(() => expect(screen.queryByText(getI18n().toolbox.itemSaveFailed)).not.toBeNull());
    expect(onSave).not.toHaveBeenCalled();
    // The other skill's file is never written; this skill's text is put back.
    expect(writtenPaths()).not.toContain(`${HOME}/.abu/skills/summarize/SKILL.md`);
    expect(vi.mocked(writeTextFile).mock.calls.at(-1)).toEqual([`${HOME}/.abu/skills/summarize-old/SKILL.md`, 'original', { create: false }]);
    expect(remove).not.toHaveBeenCalled();
  });
});
