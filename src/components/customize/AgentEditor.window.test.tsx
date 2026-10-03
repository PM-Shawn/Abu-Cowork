// @vitest-environment happy-dom
/**
 * The expert editor is a window: it is named after what it does, asks before it
 * discards what was typed, saves once, and saves nothing while it fades out.
 * What a save writes is pinned by the other AgentEditor tests.
 */

import type { ReactElement } from 'react';
import { act, fireEvent, render as renderBare, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import type { SubagentDefinition } from '@/types';

const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });

vi.mock('@/utils/itemStorage', () => ({
  ITEM_EXISTS_CODE: 'ITEM_EXISTS',
  ITEM_NAME_INVALID_CODE: 'ITEM_NAME_INVALID',
  saveItemToAbuDir: vi.fn(async () => undefined),
}));

vi.mock('@/utils/navigation', () => ({ navigateToChatWithInput: vi.fn() }));

import { saveItemToAbuDir } from '@/utils/itemStorage';
import { navigateToChatWithInput } from '@/utils/navigation';
import { agentRegistry } from '@/core/agent/registry';
import { format, getI18n } from '@/i18n';
import AgentEditor from './AgentEditor';

const reviewer: SubagentDefinition = {
  name: 'reviewer',
  description: 'Reviews code',
  systemPrompt: 'You review code.',
  filePath: '/Users/tester/.abu/agents/reviewer/AGENT.md',
  tools: ['read_file'],
  background: false,
};

const tb = () => getI18n().toolbox;
const ds = () => getI18n().designSystem;
const nameInput = () => screen.getByPlaceholderText('my-agent') as HTMLInputElement;
const saveButton = () => screen.getByTestId('agent-editor-save') as HTMLButtonElement;
const savedText = () => vi.mocked(saveItemToAbuDir).mock.calls[0][3] as string;

// happy-dom reports no animation, so Radix removes a closed layer at once. With this, a closed
// layer has an exit animation: it stays on the page, as it does in the app while it fades out.
function keepClosingLayersOnScreen() {
  const real = window.getComputedStyle.bind(window);
  return vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element, pseudo?: string | null) => {
    const styles = real(element, pseudo);
    return new Proxy(styles, {
      get(target, prop) {
        if (prop === 'animationName') return element.getAttribute('data-state') === 'closed' ? 'exit' : 'enter';
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  });
}
const closingWindow = () => document.querySelector<HTMLElement>('[role="dialog"][data-state="closed"]')!;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(agentRegistry, 'getAvailableAgents').mockReturnValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AgentEditor · the window', () => {
  it('is a window named after what it does: a new expert, or an edit', () => {
    const view = render(<AgentEditor agent={null} onClose={vi.fn()} onSave={vi.fn(async () => undefined)} />);
    expect(screen.getByRole('dialog', { name: tb().agentEditorTitleNew })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: getI18n().common.close })).toBeInTheDocument();
    view.unmount();

    render(<AgentEditor agent={reviewer} onClose={vi.fn()} onSave={vi.fn(async () => undefined)} />);
    expect(screen.getByRole('dialog', { name: tb().agentEditorTitleEdit })).toBeInTheDocument();
  });

  it('names every field with its label', () => {
    render(<AgentEditor agent={reviewer} onClose={vi.fn()} onSave={vi.fn(async () => undefined)} />);
    expect(screen.getByLabelText(tb().agentEditorName)).toBe(nameInput());
    expect((screen.getByLabelText(tb().agentEditorDescription) as HTMLInputElement).value).toBe('Reviews code');
    expect((screen.getByLabelText(tb().agentTools) as HTMLInputElement).value).toBe('read_file');
    expect(screen.getByLabelText(tb().agentDisallowedTools)).toBeInTheDocument();
    expect(screen.getByLabelText(tb().agentSkills)).toBeInTheDocument();
    expect(screen.getByLabelText(tb().agentMaxTurns)).toHaveAttribute('type', 'number');
    expect(screen.getByLabelText(tb().agentIntro).tagName).toBe('TEXTAREA');
    expect(screen.getByLabelText(tb().agentExpertise).tagName).toBe('TEXTAREA');
    expect(screen.getByLabelText(tb().agentSamplePrompts).tagName).toBe('TEXTAREA');
    expect(screen.getByLabelText(tb().agentCategoryField)).toBeInTheDocument();
    expect(screen.getByLabelText(tb().agentTagsField)).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: tb().agentModel })).toHaveTextContent(tb().agentModelInherit);
    expect(screen.getByRole('combobox', { name: tb().agentMemory })).toHaveTextContent(tb().agentMemorySession);
    const prompt = screen.getByLabelText(tb().agentEditorContent) as HTMLTextAreaElement;
    expect(prompt.value).toBe('You review code.');
    expect(prompt).toHaveClass('font-code');
  });

  it('marks a name it cannot take on the field, with a mark beside the words', () => {
    vi.mocked(agentRegistry.getAvailableAgents).mockReturnValue([{ name: 'writer', description: '' }]);
    render(<AgentEditor agent={null} onClose={vi.fn()} onSave={vi.fn(async () => undefined)} />);
    expect(nameInput()).not.toHaveAttribute('aria-invalid');
    fireEvent.change(nameInput(), { target: { value: 'writer' } });
    expect(nameInput()).toHaveAttribute('aria-invalid', 'true');
    const hint = screen.getByText(tb().agentNameTakenHint);
    expect(hint.querySelector('svg')).not.toBeNull();
    expect(saveButton().disabled).toBe(true);
  });

  it('runs in the background by a switch; an arrow key changes nothing, Space does, and the save writes it', async () => {
    const user = userEvent.setup();
    render(<AgentEditor agent={reviewer} onClose={vi.fn()} onSave={vi.fn(async () => undefined)} />);
    const background = screen.getByRole('switch', { name: tb().agentBackground });
    expect(background).toHaveAttribute('aria-checked', 'false');
    background.focus();
    await user.keyboard('{ArrowRight}{ArrowLeft}');
    expect(background).toHaveAttribute('aria-checked', 'false');
    await user.keyboard(' ');
    expect(background).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(saveButton());
    await waitFor(() => expect(vi.mocked(saveItemToAbuDir)).toHaveBeenCalledTimes(1));
    expect(savedText()).toMatch(/background:\s*true/);
  });

  it('writes the model as inherit while the choice is to follow the global setting', async () => {
    render(<AgentEditor agent={reviewer} onClose={vi.fn()} onSave={vi.fn(async () => undefined)} />);
    fireEvent.click(saveButton());
    await waitFor(() => expect(vi.mocked(saveItemToAbuDir)).toHaveBeenCalledTimes(1));
    expect(savedText()).toMatch(/model:\s*inherit/);
  });

  it('warns about a tool pattern that matches no tool, in a message with a shape', () => {
    render(<AgentEditor agent={reviewer} onClose={vi.fn()} onSave={vi.fn(async () => undefined)} />);
    fireEvent.change(screen.getByLabelText(tb().agentTools), { target: { value: 'no_such_tool_at_all' } });
    const warning = screen.getByText(format(tb().agentUnknownToolsWarning, { tools: 'no_such_tool_at_all' }));
    const message = warning.closest('[role="status"]')!;
    expect(message).toHaveClass('bg-warning-soft');
    expect(message.querySelector('svg')).not.toBeNull();
  });

  it('says a failed save in an alert and keeps the window open', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(saveItemToAbuDir).mockRejectedValueOnce(new Error('EACCES: permission denied'));
    const onSave = vi.fn(async () => undefined);
    render(<AgentEditor agent={reviewer} onClose={vi.fn()} onSave={onSave} />);
    fireEvent.click(saveButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(tb().itemSaveFailed);
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: tb().agentEditorTitleEdit })).toBeInTheDocument();
  });

  it('shows the prompt as a preview on a button that says whether it is on', () => {
    render(<AgentEditor agent={reviewer} onClose={vi.fn()} onSave={vi.fn(async () => undefined)} />);
    const preview = screen.getByRole('button', { name: tb().agentEditorPreview });
    expect(preview).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(preview);
    expect(preview).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByLabelText(tb().agentEditorContent, { selector: 'textarea' })).toBeNull();
    expect(screen.getByText('You review code.')).toBeInTheDocument();
  });
});

describe('AgentEditor · closing', () => {
  it('closes at once on Escape, on 取消 and on the close button while nothing was changed', () => {
    const onClose = vi.fn();
    render(<AgentEditor agent={reviewer} onClose={onClose} onSave={vi.fn(async () => undefined)} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: getI18n().common.cancel }));
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: getI18n().common.close }));
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it.each([
    ['the name', () => fireEvent.change(nameInput(), { target: { value: 'renamed' } })],
    ['the description', () => fireEvent.change(screen.getByLabelText(tb().agentEditorDescription), { target: { value: 'Other' } })],
    ['the tools', () => fireEvent.change(screen.getByLabelText(tb().agentTools), { target: { value: 'read_file, write_file' } })],
    ['the system prompt', () => fireEvent.change(screen.getByLabelText(tb().agentEditorContent), { target: { value: 'New prompt' } })],
    ['the background switch', () => fireEvent.click(screen.getByRole('switch', { name: tb().agentBackground }))],
    ['the avatar', () => {
      fireEvent.click(screen.getByTestId('avatar-picker-trigger'));
      fireEvent.click(screen.getByTestId('avatar-icon-code'));
      // The picker closes first: one Escape, one layer.
      fireEvent.keyDown(document, { key: 'Escape' });
    }],
  ] as const)('asks before discarding once %s was changed', async (_what, change) => {
    const onClose = vi.fn();
    render(<AgentEditor agent={reviewer} onClose={onClose} onSave={vi.fn(async () => undefined)} />);
    change();
    fireEvent.keyDown(document, { key: 'Escape' });
    const question = await screen.findByRole('alertdialog', { name: ds().discardTitle });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(within(question).getByRole('button', { name: ds().discard }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('asks on 取消 too, and keeps what was typed when the answer is to keep editing', async () => {
    const onClose = vi.fn();
    render(<AgentEditor agent={null} onClose={onClose} onSave={vi.fn(async () => undefined)} />);
    fireEvent.change(nameInput(), { target: { value: 'fresh' } });
    fireEvent.click(screen.getByRole('button', { name: getI18n().common.cancel }));
    const question = await screen.findByRole('alertdialog', { name: ds().discardTitle });
    fireEvent.click(within(question).getByRole('button', { name: ds().keepEditing }));
    expect(onClose).not.toHaveBeenCalled();
    expect(nameInput().value).toBe('fresh');
  });

  it('does not ask once a change was taken back', () => {
    const onClose = vi.fn();
    render(<AgentEditor agent={reviewer} onClose={onClose} onSave={vi.fn(async () => undefined)} />);
    fireEvent.change(nameInput(), { target: { value: 'renamed' } });
    fireEvent.change(nameInput(), { target: { value: 'reviewer' } });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('AgentEditor · saving', () => {
  it('saves once: both buttons stay focusable and take no press while the save runs', async () => {
    let finish: () => void = () => {};
    vi.mocked(saveItemToAbuDir).mockImplementationOnce(() => new Promise<undefined>((resolve) => { finish = () => resolve(undefined); }));
    const onSave = vi.fn(async () => undefined);
    render(<AgentEditor agent={reviewer} onClose={vi.fn()} onSave={onSave} />);
    const andTest = screen.getByRole('button', { name: tb().agentSaveAndTest });
    fireEvent.click(saveButton());
    await waitFor(() => expect(saveButton()).toHaveAttribute('aria-disabled', 'true'));
    expect(andTest).toHaveAttribute('aria-disabled', 'true');
    expect(saveButton()).not.toBeDisabled();
    expect(andTest).not.toBeDisabled();
    fireEvent.click(saveButton());
    fireEvent.click(andTest);
    await act(async () => { finish(); });
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(vi.mocked(saveItemToAbuDir)).toHaveBeenCalledTimes(1);
    expect(navigateToChatWithInput).not.toHaveBeenCalled();
  });

  it('saves and then starts a conversation that tries the expert', async () => {
    const onSave = vi.fn(async () => undefined);
    render(<AgentEditor agent={reviewer} onClose={vi.fn()} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: tb().agentSaveAndTest }));
    await waitFor(() => expect(navigateToChatWithInput).toHaveBeenCalledWith(format(tb().agentTestPrompt, { name: 'reviewer' })));
    expect(vi.mocked(saveItemToAbuDir)).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(navigateToChatWithInput).mock.invocationCallOrder[0]);
  });

  it.each([
    ['保存', () => saveButton()],
    ['保存并测试', () => within(closingWindow()).getByRole('button', { name: tb().agentSaveAndTest })],
  ] as const)('writes nothing on %s from a window that is closing', async (_what, button) => {
    const onSave = vi.fn(async () => undefined);
    const view = render(<AgentEditor open agent={reviewer} onClose={vi.fn()} onSave={onSave} />);
    keepClosingLayersOnScreen();
    view.rerender(<AgentEditor open={false} agent={reviewer} onClose={vi.fn()} onSave={onSave} />);
    const closing = closingWindow();
    // The window still shows the expert it held.
    expect((within(closing).getByPlaceholderText('my-agent') as HTMLInputElement).value).toBe('reviewer');
    fireEvent.click(button());
    await act(async () => { for (let turn = 0; turn < 5; turn += 1) await Promise.resolve(); });
    expect(vi.mocked(saveItemToAbuDir)).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
    expect(navigateToChatWithInput).not.toHaveBeenCalled();

    // The fade ends: the window leaves the page.
    vi.useFakeTimers();
    try {
      const ended = new Event('animationend', { bubbles: true });
      Object.defineProperty(ended, 'animationName', { value: 'exit' });
      act(() => { closing.dispatchEvent(ended); });
      act(() => { vi.runOnlyPendingTimers(); });
    } finally {
      vi.useRealTimers();
    }
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
