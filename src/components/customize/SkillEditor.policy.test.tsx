// @vitest-environment happy-dom
/**
 * The organization's skill blacklist in the skill editor: no save may leave a
 * skill answering to a blocked name — a new skill, a rename, or an existing
 * skill that already carries one. Only the policy hook is faked; in the OSS
 * build it allows every name.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { Skill } from '@/types';

vi.mock('@/utils/itemStorage', () => ({
  ITEM_EXISTS_CODE: 'ITEM_EXISTS',
  ITEM_NAME_INVALID_CODE: 'ITEM_NAME_INVALID',
  saveItemToAbuDir: vi.fn(async () => undefined),
}));

const blocked = new Set(['blocked-skill']);
vi.mock('@/core/enterprise/policy/matcher', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/enterprise/policy/matcher')>()),
  checkSkill: vi.fn((_policy: unknown, name: string) =>
    blocked.has(name) ? { decision: 'deny', reason: 'blocked by policy' } : { decision: 'allow' }),
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

const saveButton = (): HTMLButtonElement =>
  screen.getByText(getI18n().toolbox.skillSave).closest('button')! as HTMLButtonElement;
const nameInput = (): HTMLInputElement => screen.getByPlaceholderText('my-skill') as HTMLInputElement;
const policyHint = () => screen.queryByText(getI18n().toolbox.skillNamePolicyHint);

beforeEach(() => {
  vi.clearAllMocks();
  blocked.clear();
  blocked.add('blocked-skill');
  vi.spyOn(skillLoader, 'getAvailableSkills').mockReturnValue([{ name: 'summarize', description: '', source: 'user' }]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SkillEditor — the organization's skill policy", () => {
  it('blocks creating a skill under a blocked name: hint shown, save disabled, nothing written', async () => {
    render(<SkillEditor skill={null} onClose={vi.fn()} onSave={vi.fn(async () => undefined)} />);
    fireEvent.change(nameInput(), { target: { value: 'blocked-skill' } });

    expect(policyHint()).not.toBeNull();
    expect(saveButton().disabled).toBe(true);
    fireEvent.click(saveButton());
    await Promise.resolve();
    expect(vi.mocked(saveItemToAbuDir)).not.toHaveBeenCalled();
  });

  it('blocks renaming a skill to a blocked name', () => {
    render(<SkillEditor skill={summarize} onClose={vi.fn()} onSave={vi.fn(async () => undefined)} />);
    fireEvent.change(nameInput(), { target: { value: 'blocked-skill' } });

    expect(policyHint()).not.toBeNull();
    expect(saveButton().disabled).toBe(true);
  });

  it('blocks saving a skill that already answers to a blocked name', () => {
    const already: Skill = { ...summarize, name: 'blocked-skill', filePath: '/Users/tester/.abu/skills/blocked-skill/SKILL.md' };
    render(<SkillEditor skill={already} onClose={vi.fn()} onSave={vi.fn(async () => undefined)} />);

    expect(policyHint()).not.toBeNull();
    expect(saveButton().disabled).toBe(true);
  });

  it('saves any other name without a hint', async () => {
    const onSave = vi.fn(async () => undefined);
    render(<SkillEditor skill={null} onClose={vi.fn()} onSave={onSave} />);
    fireEvent.change(nameInput(), { target: { value: 'fresh-skill' } });

    expect(policyHint()).toBeNull();
    fireEvent.click(saveButton());
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  });

  it('refuses at save time a name the policy started blocking after it was typed', async () => {
    const onSave = vi.fn(async () => undefined);
    render(<SkillEditor skill={null} onClose={vi.fn()} onSave={onSave} />);
    fireEvent.change(nameInput(), { target: { value: 'fresh-skill' } });
    expect(saveButton().disabled).toBe(false);

    blocked.add('fresh-skill'); // the policy arrives between render and click
    fireEvent.click(saveButton());

    await waitFor(() => expect(policyHint()).not.toBeNull());
    expect(vi.mocked(saveItemToAbuDir)).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });
});
