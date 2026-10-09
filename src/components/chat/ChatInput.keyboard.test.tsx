// @vitest-environment happy-dom
/**
 * Keyboard contract for the composer.
 *
 * Written after users reported "阿布的聊天框不能换行". Shift+Enter was in fact
 * working; what was missing was any coverage pinning it down, so nothing
 * stopped a future edit from swallowing it. These tests pin the four rules
 * the composer promises: Enter sends, Shift+Enter does not, Alt+Enter inserts
 * a newline itself, and an IME composition suppresses all of it.
 *
 * jsdom does not implement a textarea's own editing behavior, so "Shift+Enter
 * inserts \n" is asserted where it lives — natively, i.e. by proving we never
 * preventDefault. The real insertion is covered end-to-end in
 * tests/e2e/chat-newline.spec.ts against the actual Electron shell.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, cleanup, fireEvent, render as renderBare, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { DesignSystemProvider } from '@/components/ds/provider';
import ChatInput from './ChatInput';
import { COMPOSER_TYPING_MS, userIsWritingAMessage } from './composerActivity';
import { getI18n } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { clearAllComposerDrafts } from '@/stores/composerDraftStore';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useTeamStore } from '@/stores/teamStore';

const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });

const typeInto = (textarea: HTMLTextAreaElement, value: string) => {
  fireEvent.change(textarea, { target: { value } });
};

describe('ChatInput keyboard contract', () => {
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
    useSettingsStore.setState({ composerEnterBehavior: 'enter' });
    useChatStore.getState().createConversation();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  const setup = () => {
    const onSend = vi.fn();
    render(<ChatInput variant="chat" onSend={onSend} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    typeInto(textarea, 'hello');
    return { onSend, textarea };
  };

  it('sends on a plain Enter', () => {
    const { onSend, textarea } = setup();
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('does not send on Shift+Enter, and leaves the newline to the textarea', () => {
    const { onSend, textarea } = setup();
    const notPrevented = fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    // fireEvent returns false once something called preventDefault. We must
    // NOT prevent it: the default action is exactly the newline we want.
    expect(notPrevented).toBe(true);
  });

  it('inserts a newline at the caret on Alt+Enter without sending', () => {
    const { onSend, textarea } = setup();
    textarea.setSelectionRange(2, 2);
    fireEvent.keyDown(textarea, { key: 'Enter', altKey: true });
    expect(onSend).not.toHaveBeenCalled();
    expect(textarea.value).toBe('he\nllo');
    expect(textarea.selectionStart).toBe(3);
  });

  describe("behavior 'newline' — Enter starts a line instead of sending", () => {
    beforeEach(() => {
      useSettingsStore.setState({ composerEnterBehavior: 'newline' });
    });

    it('does not send on a bare Enter, and leaves the newline to the textarea', () => {
      const { onSend, textarea } = setup();
      const notPrevented = fireEvent.keyDown(textarea, { key: 'Enter' });
      expect(onSend).not.toHaveBeenCalled();
      expect(notPrevented).toBe(true);
    });

    it('sends on the platform send modifier instead', () => {
      const { onSend, textarea } = setup();
      // jsdom has no platform, so isMacOS() is false here and Ctrl is the
      // send modifier. The Mac/Windows split itself is covered exhaustively
      // in composerKeys.test.ts, where the platform is an explicit argument.
      fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
      expect(onSend).toHaveBeenCalledTimes(1);
    });

    it('still refuses to send while an IME is composing', () => {
      const { onSend, textarea } = setup();
      fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true, keyCode: 229 });
      expect(onSend).not.toHaveBeenCalled();
    });
  });

  describe('IME composition suppresses Enter', () => {
    it('while nativeEvent.isComposing is set', () => {
      const { onSend, textarea } = setup();
      fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true });
      expect(onSend).not.toHaveBeenCalled();
    });

    it('while a Windows IME reports keyCode 229', () => {
      // 搜狗 / 微信 / 微软拼音: the Enter that commits a candidate arrives as
      // keyCode 229 and may leave isComposing false. Sending here would fire
      // off half-typed pinyin.
      const { onSend, textarea } = setup();
      fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 229 });
      expect(onSend).not.toHaveBeenCalled();
    });

    it('between compositionstart and compositionend', () => {
      const { onSend, textarea } = setup();
      fireEvent.compositionStart(textarea);
      fireEvent.keyDown(textarea, { key: 'Enter' });
      expect(onSend).not.toHaveBeenCalled();
    });

    it('and Alt+Enter stays inert too, rather than splitting the candidate', () => {
      const { textarea } = setup();
      fireEvent.compositionStart(textarea);
      fireEvent.keyDown(textarea, { key: 'Enter', altKey: true });
      expect(textarea.value).toBe('hello');
    });
  });

  // A held Enter repeats. The field takes the focus by itself after some actions (start a
  // conversation with an expert, create a project), with the key that started them still down.
  describe('a held Enter sends once per press', () => {
    const repeatEnter = (textarea: HTMLTextAreaElement, more: Record<string, unknown> = {}) =>
      fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', repeat: true, ...more });

    it('sends nothing on the repeat of a held Enter, and adds no line', () => {
      const { onSend, textarea } = setup();
      // false: the default was prevented, so the field inserts nothing either.
      expect(repeatEnter(textarea)).toBe(false);
      expect(repeatEnter(textarea)).toBe(false);
      expect(onSend).not.toHaveBeenCalled();
      expect(textarea.value).toBe('hello');
    });

    it('sends on the first press and on nothing after it while the key stays down', () => {
      const { onSend, textarea } = setup();
      fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
      typeInto(textarea, 'hello again');
      for (let i = 0; i < 10; i += 1) repeatEnter(textarea);
      expect(onSend).toHaveBeenCalledTimes(1);
    });

    it('sends again once the key was released and pressed anew', () => {
      const { onSend, textarea } = setup();
      fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
      repeatEnter(textarea);
      fireEvent.keyUp(textarea, { key: 'Enter', code: 'Enter' });
      typeInto(textarea, 'hello again');
      fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
      expect(onSend).toHaveBeenCalledTimes(2);
    });

    it('sends nothing on the repeat of the send modifier with Enter', () => {
      useSettingsStore.setState({ composerEnterBehavior: 'newline' });
      const { onSend, textarea } = setup();
      expect(repeatEnter(textarea, { ctrlKey: true })).toBe(false);
      expect(onSend).not.toHaveBeenCalled();
    });

    it('keeps adding lines while Shift+Enter is held: the repeat is left to the field', () => {
      const { onSend, textarea } = setup();
      expect(repeatEnter(textarea, { shiftKey: true })).toBe(true);
      expect(repeatEnter(textarea, { shiftKey: true })).toBe(true);
      expect(onSend).not.toHaveBeenCalled();
    });

    it('keeps adding lines while Alt+Enter is held', () => {
      const { onSend, textarea } = setup();
      textarea.setSelectionRange(5, 5);
      repeatEnter(textarea, { altKey: true });
      repeatEnter(textarea, { altKey: true });
      expect(textarea.value).toBe('hello\n\n');
      expect(onSend).not.toHaveBeenCalled();
    });

    it("keeps adding lines while a bare Enter is held under behavior 'newline'", () => {
      useSettingsStore.setState({ composerEnterBehavior: 'newline' });
      const { onSend, textarea } = setup();
      expect(repeatEnter(textarea)).toBe(true);
      expect(onSend).not.toHaveBeenCalled();
    });

    it('leaves a repeating Enter to an input method that is composing', () => {
      const { onSend, textarea } = setup();
      expect(repeatEnter(textarea, { isComposing: true })).toBe(true);
      expect(repeatEnter(textarea, { keyCode: 229 })).toBe(true);
      fireEvent.compositionStart(textarea);
      expect(repeatEnter(textarea)).toBe(true);
      expect(onSend).not.toHaveBeenCalled();
    });

    describe('with the suggestion list open', () => {
      beforeEach(() => {
        useDiscoveryStore.setState({ skills: [], agents: [{ name: 'publisher', description: 'Draft and edit public posts' }], isLoading: false });
        useTeamStore.setState({ teams: [] });
        useSettingsStore.setState({ disabledAgents: [], disabledSkills: [] });
      });
      afterEach(() => { useDiscoveryStore.setState({ skills: [], agents: [], isLoading: false }); });

      const openList = () => {
        const onSend = vi.fn();
        render(<ChatInput variant="chat" onSend={onSend} />);
        const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
        fireEvent.change(textarea, { target: { value: '@pub' } });
        textarea.setSelectionRange(4, 4);
        fireEvent.select(textarea);
        expect(screen.getByRole('option', { name: /publisher/ })).toBeTruthy();
        return { onSend, textarea };
      };

      it('picks the suggestion on the first press of Enter', () => {
        const { onSend, textarea } = openList();
        fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
        expect(screen.getByRole('button', { name: '@publisher' })).toBeTruthy();
        expect(onSend).not.toHaveBeenCalled();
      });

      it('picks nothing on the repeat of an Enter that was already down', () => {
        const { onSend, textarea } = openList();
        expect(repeatEnter(textarea)).toBe(false);
        expect(screen.queryByRole('button', { name: '@publisher' })).toBeNull();
        expect(screen.getByRole('option', { name: /publisher/ })).toBeTruthy();
        expect(onSend).not.toHaveBeenCalled();
      });

      it('sends nothing with the Enter that picked the suggestion while it stays down', () => {
        const { onSend, textarea } = openList();
        fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
        for (let i = 0; i < 10; i += 1) repeatEnter(textarea);
        expect(onSend).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: '@publisher' })).toBeTruthy();
      });

      it('still walks the list while an arrow is held: every repeat moves the highlight one option on', () => {
        useDiscoveryStore.setState({
          skills: [],
          agents: [
            { name: 'publisher', description: 'Draft and edit public posts' },
            { name: 'publicist', description: 'Plan a launch' },
            { name: 'pubwatch', description: 'Watch what was published' },
          ],
          isLoading: false,
        });
        const { textarea } = openList();
        const highlighted = () => screen.getAllByRole('option').findIndex((option) => option.getAttribute('aria-selected') === 'true');
        expect(screen.getAllByRole('option')).toHaveLength(3);
        expect(highlighted()).toBe(0);

        expect(fireEvent.keyDown(textarea, { key: 'ArrowDown', code: 'ArrowDown' })).toBe(false);
        expect(highlighted()).toBe(1);
        expect(fireEvent.keyDown(textarea, { key: 'ArrowDown', code: 'ArrowDown', repeat: true })).toBe(false);
        expect(highlighted()).toBe(2);
        expect(fireEvent.keyDown(textarea, { key: 'ArrowUp', code: 'ArrowUp', repeat: true })).toBe(false);
        expect(highlighted()).toBe(1);
        expect(fireEvent.keyDown(textarea, { key: 'ArrowUp', code: 'ArrowUp', repeat: true })).toBe(false);
        expect(highlighted()).toBe(0);
      });
    });
  });

  // Send leaves under the focus once it has taken the message: it has nothing to send, or Stop
  // takes its place. It hands the focus to the field first, where a send with Enter leaves it.
  describe('the focus after a press on Send', () => {
    it('is in the message field once Send has taken the message', () => {
      const { onSend, textarea } = setup();
      const send = screen.getByRole('button', { name: getI18n().chat.sendTooltipEnterSends });
      act(() => send.focus());
      expect(send).toHaveFocus();

      fireEvent.click(send);
      expect(onSend).toHaveBeenCalledTimes(1);
      expect(textarea).toHaveFocus();
    });

    it('stays where it is when the message was sent with Enter from the field', () => {
      const { onSend, textarea } = setup();
      act(() => textarea.focus());
      fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
      expect(onSend).toHaveBeenCalledTimes(1);
      expect(textarea).toHaveFocus();
    });
  });

  // The agent's question dock leaves the focus with a user who is writing a message. The field
  // says so: it holds a draft, or a key went down in it within the last second.
  describe('what the field tells the question dock', () => {
    // Each test's fake clock starts from nothing again, and the last key is remembered across
    // tests: each test starts an hour later than the one before, long after every key pressed above.
    let start = 0;
    beforeEach(() => {
      // The clock that judges "the last second" moves only when a test moves it.
      vi.useFakeTimers();
      start += 3_600_000;
      vi.advanceTimersByTime(start);
    });
    afterEach(() => { vi.useRealTimers(); });

    const emptyField = () => {
      render(<ChatInput variant="chat" onSend={vi.fn()} />);
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
      act(() => textarea.focus());
      return textarea;
    };

    it('nothing while it is empty and no key was pressed in it', () => {
      emptyField();
      expect(userIsWritingAMessage()).toBe(false);
    });

    it('that a message is being written while it holds text, however long ago the last key was, and no longer once it is empty', () => {
      const textarea = emptyField();
      typeInto(textarea, 'hello');
      vi.advanceTimersByTime(60_000);
      expect(userIsWritingAMessage()).toBe(true);
      typeInto(textarea, '');
      expect(userIsWritingAMessage()).toBe(false);
    });

    it('that a message is being written for one second after a key went down in it', () => {
      const textarea = emptyField();
      fireEvent.keyDown(textarea, { key: 'Backspace', code: 'Backspace' });
      vi.advanceTimersByTime(COMPOSER_TYPING_MS - 1);
      expect(userIsWritingAMessage()).toBe(true);
      vi.advanceTimersByTime(1);
      expect(userIsWritingAMessage()).toBe(false);
    });

    it('nothing when the focus is not in it, whatever it holds', () => {
      const textarea = emptyField();
      typeInto(textarea, 'hello');
      act(() => textarea.blur());
      expect(userIsWritingAMessage()).toBe(false);
    });

    it('nothing more about its draft once it has left the page', () => {
      const textarea = emptyField();
      typeInto(textarea, 'hello');
      cleanup();
      const other = document.createElement('textarea');
      other.setAttribute('data-chat-composer', '');
      document.body.append(other);
      other.focus();
      expect(userIsWritingAMessage()).toBe(false);
      other.remove();
    });
  });
});
