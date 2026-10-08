// @vitest-environment happy-dom
/**
 * The message field with a skill tag: what the field is, what it hands to the send path, and
 * what it keeps. These cases pin the behaviour the editor had before it moved into `chat/`.
 *
 * happy-dom does no text editing and no layout: line breaks typed into a real text area, the
 * caret Chromium draws around the tag, and real heights are read in the Electron shell
 * (tests/e2e/chat-newline.spec.ts, tests/e2e/composer-team-chip-journey.spec.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render as renderBare, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { DesignSystemProvider } from '@/components/ds/provider';
import ChatInput from './ChatInput';
import { getI18n } from '@/i18n';
import { clearAllComposerDrafts } from '@/stores/composerDraftStore';
import { useChatStore } from '@/stores/chatStore';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useTeamStore } from '@/stores/teamStore';
import type { Skill } from '@/types';

const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });

const SKILLS: Skill[] = [{
  name: 'brief',
  description: 'Create a brief',
  content: '',
  filePath: '/skills/brief/SKILL.md',
  skillDir: '/skills/brief',
}];
const AGENTS = [{ name: 'publisher', description: 'Draft and edit public posts' }];

// The zero-width space the editor keeps on either side of the tag as a place for the caret.
const MARK = String.fromCharCode(0x200b);
const field = () => document.querySelector<HTMLElement>('[data-chat-composer]')!;
const tag = () => screen.queryByRole('button', { name: '/brief' });

function typeAtCaret(textarea: HTMLTextAreaElement, value: string, caret = value.length): void {
  fireEvent.change(textarea, { target: { value } });
  textarea.setSelectionRange(caret, caret);
  fireEvent.select(textarea);
}

/** The text of the field without the tag and its private caret marks. */
function body(): string {
  const input = field();
  if (input instanceof HTMLTextAreaElement) return input.value;
  const copy = input.cloneNode(true) as HTMLElement;
  copy.querySelectorAll<HTMLElement>('[data-skill-boundary]').forEach((node) => { node.textContent = node.dataset.skillBoundary === 'before' ? node.textContent!.replace(new RegExp(`${MARK}$`), '') : node.textContent!.replace(new RegExp(`^${MARK}`), ''); });
  copy.querySelectorAll('[data-inline-skill], [data-editor-tail]').forEach((node) => node.remove());
  return copy.textContent ?? '';
}

/** Types "/br" and picks the skill from the list: the field then holds the tag and no text. */
function pickTag(): void {
  typeAtCaret(field() as HTMLTextAreaElement, '/br');
  fireEvent.click(screen.getByRole('option', { name: /brief/ }));
}

/** Types `text`, then picks the skill from the + menu: the tag sits at `offset` in that text. */
async function pickTagInto(text: string, offset = 0): Promise<void> {
  typeAtCaret(field() as HTMLTextAreaElement, text, offset);
  fireEvent.pointerDown(screen.getByTestId('composer-plus'), { button: 0 });
  fireEvent.click(screen.getByTestId('composer-menu-skill'));
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Search' })).toHaveFocus());
  fireEvent.click(screen.getByRole('option', { name: /brief/ }));
}

describe('ChatInput with a skill tag', () => {
  beforeEach(() => {
    clearAllComposerDrafts();
    useEnterpriseStore.setState({ mode: { kind: 'personal' }, initialized: true });
    useChatStore.setState({
      conversations: {},
      conversationIndex: {},
      activeConversationId: null,
      pendingInput: null,
      pendingInputAppend: null,
      pendingReferences: [],
      pendingAttachmentRequests: [],
    });
    useDiscoveryStore.setState({ skills: SKILLS, agents: AGENTS, isLoading: false });
    useSettingsStore.setState({ composerEnterBehavior: 'enter', disabledAgents: [], disabledSkills: [] });
    useTeamStore.setState({ teams: [] });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useDiscoveryStore.setState({ skills: [], agents: [], isLoading: false });
  });

  describe('what the field is', () => {
    it.each([
      ['welcome', '2', ['flex-1', 'resize-none', 'bg-transparent', 'text-body', 'text-label', 'outline-none', 'placeholder:text-label-placeholder', 'min-h-[52px]', 'max-h-[180px]']],
      ['chat', '1', ['flex-1', 'resize-none', 'bg-transparent', 'text-body', 'text-label', 'outline-none', 'placeholder:text-label-placeholder', 'min-h-[24px]', 'max-h-[160px]', 'py-1', 'disabled:opacity-40']],
    ] as const)('without a tag, on the %s page: a text area with the composer mark, the placeholder and the list attributes', (variant, rows, classes) => {
      if (variant === 'chat') useChatStore.getState().createConversation();
      render(<ChatInput variant={variant} onSend={vi.fn()} />);
      const input = field();
      expect(input.tagName).toBe('TEXTAREA');
      expect(screen.getByRole('textbox')).toBe(input);
      expect(input).toHaveAttribute('data-chat-composer', 'true');
      expect(input).toHaveAttribute('placeholder', getI18n().chat.inputPlaceholder);
      expect(input).toHaveAttribute('rows', rows);
      expect(input).toHaveAttribute('aria-autocomplete', 'list');
      expect(input).toHaveAttribute('aria-expanded', 'false');
      expect(input).not.toHaveAttribute('aria-controls');
      expect(input).not.toHaveAttribute('aria-activedescendant');
      expect(input).not.toHaveAttribute('aria-invalid');
      expect(input).not.toBeDisabled();
      expect(input).toHaveClass('w-full');
      for (const name of classes) expect(input).toHaveClass(name);
    });

    it('with a tag: an editable text box named by the skill, the same mark, and the tag as a button that removes it', () => {
      render(<ChatInput variant="welcome" onSend={vi.fn()} />);
      pickTag();
      const input = field();
      expect(input.tagName).toBe('DIV');
      expect(screen.getByRole('textbox')).toBe(input);
      expect(input).toHaveAttribute('data-chat-composer', 'true');
      expect(input).toHaveAttribute('contenteditable', 'true');
      expect(input).toHaveAttribute('aria-multiline', 'true');
      expect(input).toHaveAttribute('aria-label', 'Create a brief');
      expect(input).toHaveAttribute('aria-autocomplete', 'list');
      expect(input).toHaveAttribute('aria-expanded', 'false');
      for (const name of ['w-full', 'whitespace-pre-wrap', 'break-words', 'overflow-y-auto', 'flex-1', 'text-body', 'text-label', 'min-h-[52px]', 'max-h-[180px]']) expect(input).toHaveClass(name);

      const atom = tag()!;
      expect(atom.tagName).toBe('BUTTON');
      expect(atom).toHaveAttribute('type', 'button');
      expect(atom).toHaveAttribute('data-inline-skill', 'brief');
      expect(atom).toHaveAttribute('contenteditable', 'false');
      expect(atom).toHaveAttribute('title', `${getI18n().common.close} /brief`);
      expect(atom.textContent).toBe('/brief ×');
      expect(atom.className).toBe('inline-block max-w-full cursor-pointer align-baseline rounded-control bg-fill px-1 mx-1 text-body font-medium text-label');
    });

    it('a field that takes no input: the text area is disabled and says so in its placeholder', () => {
      render(<ChatInput variant="welcome" onSend={vi.fn()} disabled />);
      expect(field()).toBeDisabled();
      expect(field()).toHaveAttribute('placeholder', getI18n().chat.inputPlaceholderBusy);
    });

    it('keeps the same text area on the page, with the focus, while the user types', () => {
      render(<ChatInput variant="welcome" onSend={vi.fn()} />);
      const input = field() as HTMLTextAreaElement;
      input.focus();
      for (const value of ['a', 'ab', 'abc']) typeAtCaret(input, value);
      expect(field()).toBe(input);
      expect(input).toHaveFocus();
      expect(input.value).toBe('abc');
    });

    // The two cases are a pair: the composer's paste handler reaches the text area (it takes a
    // paste that carries a file), and that same handler lets plain text through.
    it('takes a paste that carries a file for itself', async () => {
      render(<ChatInput variant="welcome" onSend={vi.fn()} />);
      let notPrevented = true;
      await act(async () => {
        notPrevented = fireEvent.paste(field(), { clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => null }] } });
      });
      expect(notPrevented).toBe(false);
      expect((field() as HTMLTextAreaElement).value).toBe('');
    });

    it('leaves a paste of plain text to the text area', () => {
      render(<ChatInput variant="welcome" onSend={vi.fn()} />);
      const notPrevented = fireEvent.paste(field(), { clipboardData: { items: [{ kind: 'string', type: 'text/plain' }], getData: () => 'pasted' } });
      expect(notPrevented).toBe(true);
    });
  });

  describe('how a tag enters and leaves', () => {
    it('picking from the list puts the tag in and keeps the focus in the field', () => {
      render(<ChatInput variant="welcome" onSend={vi.fn()} />);
      pickTag();
      expect(tag()).not.toBeNull();
      expect(body()).toBe('');
      expect(field()).toHaveFocus();
    });

    it('typing "/name " with a space selects the skill and keeps the rest as text', () => {
      render(<ChatInput variant="welcome" onSend={vi.fn()} />);
      typeAtCaret(field() as HTMLTextAreaElement, '/brief write this');
      expect(tag()).not.toBeNull();
      expect(body()).toBe('write this');
    });

    it('Backspace in a field with a tag and no text takes the tag out: a focused, empty text area is left', () => {
      render(<ChatInput variant="welcome" onSend={vi.fn()} />);
      pickTag();
      fireEvent.keyDown(field(), { key: 'Backspace' });
      expect(tag()).toBeNull();
      expect(field().tagName).toBe('TEXTAREA');
      expect(body()).toBe('');
      expect(field()).toHaveFocus();
    });

    it('a press on the tag takes it out, keeps the text and leaves the focus in the text area', async () => {
      render(<ChatInput variant="welcome" onSend={vi.fn()} />);
      await pickTagInto('keep this', 4);
      fireEvent.click(tag()!);
      expect(tag()).toBeNull();
      expect(field().tagName).toBe('TEXTAREA');
      expect(body()).toBe('keep this');
      expect(field()).toHaveFocus();
    });

    it('undo and redo in the plain field walk the typed states', () => {
      render(<ChatInput variant="welcome" onSend={vi.fn()} />);
      const input = field() as HTMLTextAreaElement;
      typeAtCaret(input, 'a');
      typeAtCaret(input, 'ab');
      fireEvent.keyDown(input, { key: 'z', ctrlKey: true });
      expect(input.value).toBe('a');
      fireEvent.keyDown(input, { key: 'z', ctrlKey: true, shiftKey: true });
      expect(input.value).toBe('ab');
      fireEvent.keyDown(input, { key: 'z', metaKey: true });
      expect(input.value).toBe('a');
      fireEvent.keyDown(input, { key: 'y', ctrlKey: true });
      expect(input.value).toBe('ab');
    });
  });

  describe('what is handed to the send path', () => {
    it('a tag alone sends "/name"', () => {
      const send = vi.fn();
      render(<ChatInput variant="welcome" onSend={send} />);
      pickTag();
      fireEvent.keyDown(field(), { key: 'Enter' });
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][0]).toBe('/brief');
      expect(send.mock.calls[0][1]).toBeUndefined();
    });

    it('a tag with text sends "/name", one space and the text exactly as typed', async () => {
      const send = vi.fn();
      render(<ChatInput variant="welcome" onSend={send} />);
      const typed = '  two  spaces\n second line ';
      await pickTagInto(typed);
      fireEvent.keyDown(field(), { key: 'Enter' });
      expect(send.mock.calls[0][0]).toBe(`/brief ${typed}`);
    });

    it('a tag with nothing but white space sends the tag alone', async () => {
      const send = vi.fn();
      render(<ChatInput variant="welcome" onSend={send} />);
      await pickTagInto('  \n ');
      fireEvent.keyDown(field(), { key: 'Enter' });
      expect(send.mock.calls[0][0]).toBe('/brief');
    });

    it('where the tag sits in the text does not change what is sent', async () => {
      const send = vi.fn();
      render(<ChatInput variant="welcome" onSend={send} />);
      await pickTagInto('before after', 7);
      fireEvent.keyDown(field(), { key: 'Enter' });
      expect(send.mock.calls[0][0]).toBe('/brief before after');
    });

    it('without a tag the text is sent as typed', () => {
      const send = vi.fn();
      render(<ChatInput variant="welcome" onSend={send} />);
      typeAtCaret(field() as HTMLTextAreaElement, ' plain\ntext ');
      fireEvent.keyDown(field(), { key: 'Enter' });
      expect(send.mock.calls[0][0]).toBe(' plain\ntext ');
    });

    it('on the welcome page the tag and the text are gone after the send', () => {
      render(<ChatInput variant="welcome" onSend={vi.fn()} />);
      pickTag();
      fireEvent.keyDown(field(), { key: 'Enter' });
      expect(tag()).toBeNull();
      expect(body()).toBe('');
    });

    it('inside a conversation the tag stays after the send and the text is emptied', async () => {
      useChatStore.getState().createConversation();
      const send = vi.fn();
      render(<ChatInput variant="chat" onSend={send} />);
      await pickTagInto('first message');
      fireEvent.keyDown(field(), { key: 'Enter' });
      expect(send.mock.calls[0][0]).toBe('/brief first message');
      expect(tag()).not.toBeNull();
      expect(body()).toBe('');
    });
  });

  describe('Enter in a field with a tag', () => {
    it('Shift+Enter sends nothing and adds a line break to the text', () => {
      const send = vi.fn();
      render(<ChatInput variant="welcome" onSend={send} />);
      pickTag();
      fireEvent.keyDown(field(), { key: 'Enter', shiftKey: true });
      expect(send).not.toHaveBeenCalled();
      expect(body()).toBe('\n');
      expect(tag()).not.toBeNull();
    });

    it("under 'newline' a bare Enter adds a line break and the send modifier sends", () => {
      useSettingsStore.setState({ composerEnterBehavior: 'newline' });
      const send = vi.fn();
      render(<ChatInput variant="welcome" onSend={send} />);
      pickTag();
      fireEvent.keyDown(field(), { key: 'Enter' });
      expect(send).not.toHaveBeenCalled();
      expect(body()).toBe('\n');
      fireEvent.keyDown(field(), { key: 'Enter', ctrlKey: true });
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][0]).toBe('/brief');
    });

    it('the repeat of a held Enter sends nothing and adds no line', () => {
      const send = vi.fn();
      render(<ChatInput variant="welcome" onSend={send} />);
      pickTag();
      const notPrevented = fireEvent.keyDown(field(), { key: 'Enter', code: 'Enter', repeat: true });
      expect(notPrevented).toBe(false);
      expect(send).not.toHaveBeenCalled();
      expect(body()).toBe('');
    });

    it.each([
      ['isComposing', { isComposing: true }],
      ['key code 229', { keyCode: 229 }],
    ])('an Enter that belongs to an input method (%s) sends nothing, adds no line and is left to the method', (_label, init) => {
      const send = vi.fn();
      render(<ChatInput variant="welcome" onSend={send} />);
      pickTag();
      const notPrevented = fireEvent.keyDown(field(), { key: 'Enter', ...init });
      expect(notPrevented).toBe(true);
      expect(send).not.toHaveBeenCalled();
      expect(body()).toBe('');
      expect(tag()).not.toBeNull();
    });

    it('between compositionstart and compositionend Enter sends nothing; after the end it sends', () => {
      vi.useFakeTimers();
      try {
        const send = vi.fn();
        render(<ChatInput variant="welcome" onSend={send} />);
        pickTag();
        fireEvent.compositionStart(field());
        fireEvent.keyDown(field(), { key: 'Enter' });
        expect(send).not.toHaveBeenCalled();
        fireEvent.compositionEnd(field());
        act(() => { vi.advanceTimersByTime(1); });
        fireEvent.keyDown(field(), { key: 'Enter' });
        expect(send).toHaveBeenCalledTimes(1);
        expect(send.mock.calls[0][0]).toBe('/brief');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('what the field keeps', () => {
    it('a draft with a tag comes back, tag and text, after a switch to another conversation and back', async () => {
      const a = useChatStore.getState().createConversation();
      const b = useChatStore.getState().createConversation();
      await useChatStore.getState().switchConversation(a);
      render(<ChatInput variant="chat" onSend={vi.fn()} />);
      await pickTagInto('draft of A', 5);
      expect(tag()).not.toBeNull();

      await act(async () => { await useChatStore.getState().switchConversation(b); });
      expect(tag()).toBeNull();
      expect(body()).toBe('');

      await act(async () => { await useChatStore.getState().switchConversation(a); });
      expect(tag()).not.toBeNull();
      expect(body()).toBe('draft of A');
      const range = document.createRange();
      range.selectNodeContents(field());
      range.setEndBefore(tag()!);
      expect(range.cloneContents().textContent!.replaceAll(MARK, '')).toBe('draft');
    });

    it('input handed over by another page lands in the field with the focus and the caret at its end', () => {
      render(<ChatInput variant="welcome" onSend={vi.fn()} />);
      act(() => useChatStore.getState().setPendingInput('@publisher draft the post'));
      const input = field() as HTMLTextAreaElement;
      expect(screen.getByRole('button', { name: '@publisher' })).toBeTruthy();
      expect(input.value).toBe('draft the post');
      expect(input).toHaveFocus();
      expect(input.selectionStart).toBe('draft the post'.length);
      expect(input.selectionEnd).toBe('draft the post'.length);
    });

    it('a skill handed over by another page becomes a tag, and the field has the focus', () => {
      render(<ChatInput variant="welcome" onSend={vi.fn()} />);
      act(() => useChatStore.getState().setPendingInput('/brief the launch'));
      expect(tag()).not.toBeNull();
      expect(body()).toBe('the launch');
      expect(field()).toHaveFocus();
    });
  });

  describe('height', () => {
    // The field grows with its text up to a limit: on every change of the text the height is
    // set to `auto`, the content height is read once, and the smaller of it and the limit is
    // written. Nothing is measured for a key that changes no text.
    const measure = (contentHeight: number) => {
      let reads = 0;
      vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => { reads += 1; return contentHeight; });
      return { reads: () => reads };
    };

    it.each([
      ['welcome', 100, '100px'],
      ['welcome', 500, '180px'],
      ['chat', 100, '100px'],
      ['chat', 500, '160px'],
    ] as const)('on the %s page a content height of %i gives %s', (variant, contentHeight, expected) => {
      if (variant === 'chat') useChatStore.getState().createConversation();
      measure(contentHeight);
      render(<ChatInput variant={variant} onSend={vi.fn()} />);
      typeAtCaret(field() as HTMLTextAreaElement, 'some text');
      expect(field().style.height).toBe(expected);
    });

    it('with a tag the editable box follows the same rule', () => {
      measure(500);
      render(<ChatInput variant="welcome" onSend={vi.fn()} />);
      pickTag();
      fireEvent.keyDown(field(), { key: 'Enter', shiftKey: true });
      expect(field().tagName).toBe('DIV');
      expect(field().style.height).toBe('180px');
    });

    it('measures once per change of the text and not at all for a key or a caret move', () => {
      const probe = measure(100);
      render(<ChatInput variant="welcome" onSend={vi.fn()} />);
      const input = field() as HTMLTextAreaElement;
      typeAtCaret(input, 'a');
      const before = probe.reads();
      fireEvent.change(input, { target: { value: 'ab' } });
      expect(probe.reads() - before).toBe(1);
      const afterChange = probe.reads();
      input.setSelectionRange(0, 0);
      fireEvent.select(input);
      fireEvent.keyDown(input, { key: 'ArrowLeft' });
      fireEvent.keyUp(input, { key: 'ArrowLeft' });
      expect(probe.reads() - afterChange).toBe(0);
    });
  });
});
