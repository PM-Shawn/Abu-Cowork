// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
/**
 * The skill editor takes the place of the skill list. These hold its controls:
 * where the focus goes, what each field is called, and what the two save
 * buttons do while a save runs.
 */
import type { ReactElement } from 'react';
import { act, fireEvent, render as renderBare, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import type { Skill } from '@/types';

vi.mock('@/utils/itemStorage', () => ({
  ITEM_EXISTS_CODE: 'ITEM_EXISTS',
  ITEM_NAME_INVALID_CODE: 'ITEM_NAME_INVALID',
  saveItemToAbuDir: vi.fn(async () => undefined),
}));
vi.mock('@/utils/navigation', () => ({ navigateToChatWithInput: vi.fn() }));
vi.mock('@/components/chat/MarkdownRenderer', () => ({
  default: ({ content }: { content: string }) => <div data-testid="markdown">{content}</div>,
}));

import { saveItemToAbuDir } from '@/utils/itemStorage';
import { navigateToChatWithInput } from '@/utils/navigation';
import { skillLoader } from '@/core/skill/loader';
import { getI18n } from '@/i18n';
import SkillEditor from './SkillEditor';

const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });
const tb = () => getI18n().toolbox;

const summarize: Skill = {
  name: 'summarize',
  description: 'Summarizes',
  source: 'user',
  content: 'Summarize things.',
  filePath: '/Users/tester/.abu/skills/summarize/SKILL.md',
  skillDir: '/Users/tester/.abu/skills/summarize',
  context: 'fork',
  userInvocable: false,
};

const back = () => screen.getByRole('button', { name: getI18n().schedule.backToList });
const save = () => screen.getByRole('button', { name: tb().skillSave });
const saveAndTest = () => screen.getByRole('button', { name: tb().skillSaveAndTest });

beforeAll(() => {
  // happy-dom has none of these; the open list of a select calls them.
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(saveItemToAbuDir).mockImplementation(async () => undefined);
  vi.spyOn(skillLoader, 'getAvailableSkills').mockReturnValue([{ name: 'summarize', description: '', source: 'user' }]);
  vi.spyOn(skillLoader, 'listSupportingFiles').mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SkillEditor · the page', () => {
  it('opens with the focus on its way back, which is named', () => {
    render(<SkillEditor skill={null} onClose={vi.fn()} onSave={vi.fn(async () => undefined)} />);
    expect(back()).toHaveFocus();
    expect(screen.getByRole('heading', { level: 2, name: tb().skillEditorTitle })).toBeInTheDocument();
  });

  it('leaves through its way back', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<SkillEditor skill={null} onClose={onClose} onSave={vi.fn(async () => undefined)} />);
    await user.click(back());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ties each field to its label', () => {
    render(<SkillEditor skill={summarize} onClose={vi.fn()} onSave={vi.fn(async () => undefined)} />);
    expect(screen.getByLabelText(tb().skillEditorName)).toHaveValue('summarize');
    expect(screen.getByLabelText(tb().skillEditorDescription)).toHaveValue('Summarizes');
    expect(screen.getByLabelText(tb().skillEditorContent)).toHaveValue('Summarize things.');
    expect(screen.getByLabelText(tb().skillEditorContent)).toHaveClass('font-code');
  });

  it('marks a name that cannot be saved and says why', () => {
    render(<SkillEditor skill={null} onClose={vi.fn()} onSave={vi.fn(async () => undefined)} />);
    const name = screen.getByLabelText(tb().skillEditorName);
    expect(name).not.toHaveAttribute('aria-invalid');

    fireEvent.change(name, { target: { value: 'summarize' } });

    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(tb().skillNameTakenHint)).toHaveClass('text-danger');
    expect(save()).toBeDisabled();
    expect(saveAndTest()).toBeDisabled();
  });

  it('switches between the text and its preview, and says which is on', async () => {
    const user = userEvent.setup();
    render(<SkillEditor skill={summarize} onClose={vi.fn()} onSave={vi.fn(async () => undefined)} />);
    const preview = screen.getByRole('button', { name: tb().skillEditorPreview });
    expect(preview).toHaveAttribute('aria-pressed', 'false');

    await user.click(preview);

    expect(preview).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('markdown')).toHaveTextContent('Summarize things.');
    expect(screen.queryByPlaceholderText('Write skill instructions in Markdown...')).toBeNull();

    await user.click(preview);
    expect(screen.getByPlaceholderText('Write skill instructions in Markdown...')).toHaveValue('Summarize things.');
  });

  it('lists the files the skill ships with', async () => {
    vi.mocked(skillLoader.listSupportingFiles).mockResolvedValue(['notes.txt', 'scripts/run.sh']);
    render(<SkillEditor skill={summarize} onClose={vi.fn()} onSave={vi.fn(async () => undefined)} />);
    expect(await screen.findByText('run.sh')).toBeInTheDocument();
    expect(skillLoader.listSupportingFiles).toHaveBeenCalledWith('summarize');
    expect(screen.getByText('scripts')).toBeInTheDocument();
    expect(screen.getByText('notes.txt')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: tb().skillFiles })).toBeInTheDocument();
  });
});

describe('SkillEditor · advanced settings', () => {
  const openAdvanced = async (user: ReturnType<typeof userEvent.setup>) => {
    const toggle = screen.getByRole('button', { name: tb().skillAdvancedSettings });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  };

  it('stays closed until it is opened, then shows its fields with their labels', async () => {
    const user = userEvent.setup();
    render(<SkillEditor skill={summarize} onClose={vi.fn()} onSave={vi.fn(async () => undefined)} />);
    expect(screen.queryByLabelText(tb().skillLicense)).toBeNull();

    await openAdvanced(user);

    for (const label of [tb().skillLicense, tb().skillTrigger, tb().skillDoNotTrigger, tb().skillTags, tb().skillMaxTurns, tb().skillAllowedTools, tb().skillArgumentHint]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    expect(screen.getByLabelText(tb().skillMaxTurns)).toHaveAttribute('type', 'number');
    const invocable = screen.getByRole('switch', { name: tb().skillUserInvocable });
    expect(invocable).toHaveAttribute('aria-checked', 'false');
    const context = screen.getByRole('combobox', { name: tb().skillContext });
    expect(context).toHaveTextContent(tb().skillContextFork);
  });

  it('saves the context and the switch as they were set', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => undefined);
    render(<SkillEditor skill={summarize} onClose={vi.fn()} onSave={onSave} />);
    await openAdvanced(user);

    await user.click(screen.getByRole('combobox', { name: tb().skillContext }));
    await user.click(await screen.findByRole('option', { name: tb().skillContextInline }));
    await user.click(screen.getByRole('switch', { name: tb().skillUserInvocable }));
    fireEvent.change(screen.getByLabelText(tb().skillMaxTurns), { target: { value: '7' } });
    await user.click(save());

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const written = String(vi.mocked(saveItemToAbuDir).mock.calls[0][3]);
    expect(written).toContain('context: inline');
    expect(written).toContain('user-invocable: true');
    expect(written).toContain('max-turns: 7');
  });

  it('does not change the context from an arrow key on the closed select', async () => {
    const user = userEvent.setup();
    render(<SkillEditor skill={summarize} onClose={vi.fn()} onSave={vi.fn(async () => undefined)} />);
    await openAdvanced(user);
    const context = screen.getByRole('combobox', { name: tb().skillContext });
    context.focus();

    await user.keyboard('{ArrowDown}');
    await user.keyboard('{Escape}');

    expect(context).toHaveTextContent(tb().skillContextFork);
  });
});

describe('SkillEditor · saving', () => {
  it('keeps both buttons busy and focusable while the save runs, and saves once', async () => {
    let finish: () => void = () => {};
    vi.mocked(saveItemToAbuDir).mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const onSave = vi.fn(async () => undefined);
    const user = userEvent.setup();
    render(<SkillEditor skill={summarize} onClose={vi.fn()} onSave={onSave} />);

    await user.click(save());

    expect(save()).toHaveAttribute('aria-disabled', 'true');
    expect(save()).not.toBeDisabled();
    expect(save()).toHaveFocus();
    expect(saveAndTest()).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(save());
    fireEvent.click(saveAndTest());
    expect(saveItemToAbuDir).toHaveBeenCalledTimes(1);

    await act(async () => { finish(); });
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(save()).not.toHaveAttribute('aria-disabled');
    expect(navigateToChatWithInput).not.toHaveBeenCalled();
  });

  it('saves and then opens a task with the skill', async () => {
    const onSave = vi.fn(async () => undefined);
    const user = userEvent.setup();
    render(<SkillEditor skill={summarize} onClose={vi.fn()} onSave={onSave} />);

    await user.click(saveAndTest());

    await waitFor(() => expect(navigateToChatWithInput).toHaveBeenCalledWith('/summarize '));
    expect(saveItemToAbuDir).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('opens no task when the save fails, and says so beside the buttons', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(saveItemToAbuDir).mockRejectedValueOnce(new Error('EACCES'));
    const user = userEvent.setup();
    render(<SkillEditor skill={summarize} onClose={vi.fn()} onSave={vi.fn(async () => undefined)} />);

    await user.click(saveAndTest());

    const failed = await screen.findByRole('alert');
    expect(failed).toHaveTextContent(tb().itemSaveFailed);
    expect(within(failed).queryByRole('button')).toBeNull();
    expect(navigateToChatWithInput).not.toHaveBeenCalled();
  });
});
