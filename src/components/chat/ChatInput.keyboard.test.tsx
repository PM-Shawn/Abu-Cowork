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
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ChatInput from './ChatInput';
import { useChatStore } from '@/stores/chatStore';
import { clearAllComposerDrafts } from '@/stores/composerDraftStore';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
import { useSettingsStore } from '@/stores/settingsStore';

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
});
