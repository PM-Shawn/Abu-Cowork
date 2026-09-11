// @vitest-environment happy-dom
/**
 * Same data-loss path as the agent editor: the skill editor writes
 * `~/.abu/skills/<name>/SKILL.md` unconditionally and deletes the old folder on
 * rename, so creating a skill under an existing skill's name (or renaming onto
 * one) silently replaced it. A new or renamed skill must refuse any name
 * another skill already uses — case-insensitively — without colliding with itself.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { Skill, SkillMetadata } from '@/types';

vi.mock('@/utils/itemStorage', () => ({
  ITEM_EXISTS_CODE: 'ITEM_EXISTS',
  saveItemToAbuDir: vi.fn(async () => undefined),
}));

import { saveItemToAbuDir } from '@/utils/itemStorage';
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
