// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
/**
 * The composer's mic control: guides to setup when the model is missing,
 * records → transcribes → inserts into an unchanged draft, holds the text for
 * an explicit insert when the draft changed, and cancels on Escape or a
 * conversation switch without ever inserting late.
 */
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import VoiceInputControl from './VoiceInputControl';
import { Button } from '@/components/ds/button';
import { Menu, MenuItem } from '@/components/ds/menu';
import { Popover } from '@/components/ds/popover';
import { DesignSystemProvider } from '@/components/ds/provider';
import { TextArea } from '@/components/ds/text-area';
import { useSpeechStore } from '@/stores/speechStore';
import { useSettingsStore } from '@/stores/settingsStore';
import type { SpeechStatus } from '@/core/speech/speechBridge';
import { RecordingError } from '@/core/speech/recording';

const recordingMock = vi.hoisted(() => ({
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => new Uint8Array(46)),
  dispose: vi.fn(async () => {}),
  level: vi.fn(() => 0.2),
}));
const transcribeMock = vi.hoisted(() => vi.fn());

vi.mock('@/core/speech/recording', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/speech/recording')>();
  return {
    ...actual,
    Recording: vi.fn(function Recording() { return recordingMock; }),
  };
});

vi.mock('@/core/speech/speechBridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/speech/speechBridge')>();
  return {
    ...actual,
    transcribeSpeech: (...args: unknown[]) => transcribeMock(...args),
    isSpeechAvailable: () => false,
  };
});

function status(state: SpeechStatus['model']['state']): SpeechStatus {
  return {
    runtimeAvailable: true,
    model: { state, totalBytes: 241_357_257, download: null, error: null },
    downloadSources: ['auto', 'hf-mirror', 'huggingface'],
    languages: ['auto', 'zh', 'en', 'yue', 'ja', 'ko'],
    maxAudioSeconds: 150,
  };
}

function renderControl({ draft = { text: 'draft', start: 5, end: 5 }, unchanged = true, resetKey = 'conv-1' } = {}) {
  const insertIfUnchanged = vi.fn(() => unchanged);
  const insertAtCursor = vi.fn();
  const view = render(
    <VoiceInputControl
      resetKey={resetKey}
      getDraftSnapshot={() => draft}
      insertIfUnchanged={insertIfUnchanged}
      insertAtCursor={insertAtCursor}
    />,
    { wrapper: DesignSystemProvider },
  );
  return { ...view, insertIfUnchanged, insertAtCursor };
}

describe('VoiceInputControl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recordingMock.start.mockImplementation(async () => {});
    transcribeMock.mockResolvedValue({ text: ' 你好世界 ', audioSeconds: 1, inferenceSeconds: 0.1 });
    useSpeechStore.setState({ status: status('ready'), unavailable: false });
    useSettingsStore.setState({ systemSettingsOpen: false });
  });

  afterEach(() => {
    cleanup();
  });

  describe('setup', () => {
    it('guides to the settings page instead of recording when the model is missing', async () => {
      useSpeechStore.setState({ status: status('missing') });
      renderControl();
      await userEvent.click(screen.getByRole('button', { name: 'Voice' }));
      expect(screen.getByText('Download the voice model first')).toBeInTheDocument();
      expect(recordingMock.start).not.toHaveBeenCalled();
      await userEvent.click(screen.getByRole('button', { name: 'Go to download' }));
      expect(useSettingsStore.getState().activeSystemTab).toBe('voice-input');
      expect(useSettingsStore.getState().systemSettingsOpen).toBe(true);
    });
  });

  describe('recording', () => {
    it('records, transcribes and inserts the trimmed text into the unchanged draft', async () => {
      const { insertIfUnchanged, insertAtCursor } = renderControl();
      await userEvent.click(screen.getByRole('button', { name: 'Voice' }));
      expect(await screen.findByTestId('voice-recording-bar')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Done' }));
      await vi.waitFor(() => expect(insertIfUnchanged).toHaveBeenCalledWith('你好世界', { text: 'draft', start: 5, end: 5 }));
      expect(transcribeMock).toHaveBeenCalledWith(expect.any(Uint8Array), 'auto');
      expect(insertAtCursor).not.toHaveBeenCalled();
      expect(screen.queryByTestId('voice-recording-bar')).not.toBeInTheDocument();
    });

    it('holds the transcript for an explicit insert when the draft changed', async () => {
      const { insertAtCursor } = renderControl({ unchanged: false });
      await userEvent.click(screen.getByRole('button', { name: 'Voice' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Done' }));
      expect(await screen.findByText('你好世界')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Insert' }));
      expect(insertAtCursor).toHaveBeenCalledWith('你好世界');
    });

    it('reports silence instead of inserting an empty string', async () => {
      transcribeMock.mockResolvedValue({ text: '   ', audioSeconds: 1, inferenceSeconds: 0.1 });
      const { insertIfUnchanged } = renderControl();
      await userEvent.click(screen.getByRole('button', { name: 'Voice' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Done' }));
      expect(await screen.findByText('No speech was recognized.')).toBeInTheDocument();
      expect(insertIfUnchanged).not.toHaveBeenCalled();
    });

    it('offers System Settings when microphone access is denied', async () => {
      recordingMock.start.mockRejectedValue(new RecordingError('permission'));
      renderControl();
      await userEvent.click(screen.getByRole('button', { name: 'Voice' }));
      expect(await screen.findByText('No microphone access.')).toBeInTheDocument();
    });
  });

  describe('cancel', () => {
    it('Escape discards the recording without transcribing', async () => {
      renderControl();
      await userEvent.click(screen.getByRole('button', { name: 'Voice' }));
      await screen.findByTestId('voice-recording-bar');
      await userEvent.keyboard('{Escape}');
      expect(screen.queryByTestId('voice-recording-bar')).not.toBeInTheDocument();
      expect(recordingMock.dispose).toHaveBeenCalled();
      expect(transcribeMock).not.toHaveBeenCalled();
    });

    it('a conversation switch drops a transcript that arrives late', async () => {
      let finish: (value: unknown) => void = () => {};
      transcribeMock.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
      const { insertIfUnchanged, rerender } = renderControl();
      await userEvent.click(screen.getByRole('button', { name: 'Voice' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Done' }));
      await screen.findByText('Transcribing…');
      rerender(
        <VoiceInputControl
          resetKey="conv-2"
          getDraftSnapshot={() => ({ text: '', start: 0, end: 0 })}
          insertIfUnchanged={insertIfUnchanged}
          insertAtCursor={vi.fn()}
        />,
      );
      await act(async () => { finish({ text: 'late', audioSeconds: 1, inferenceSeconds: 1 }); });
      expect(insertIfUnchanged).not.toHaveBeenCalled();
      expect(screen.queryByText('late')).not.toBeInTheDocument();
    });
  });

  describe('the held transcript card', () => {
    // The control beside a draft field and another layer of the page (a menu).
    function renderBesideDraft() {
      const insertAtCursor = vi.fn(() => { screen.getByRole('textbox', { name: 'Draft' }).focus(); });
      const page = (resetKey: string) => (
        <DesignSystemProvider>
          <TextArea aria-label="Draft" />
          <Menu trigger={<Button>Other</Button>}><MenuItem>Rename</MenuItem></Menu>
          <VoiceInputControl
            resetKey={resetKey}
            getDraftSnapshot={() => ({ text: 'draft', start: 5, end: 5 })}
            insertIfUnchanged={() => false}
            insertAtCursor={insertAtCursor}
          />
        </DesignSystemProvider>
      );
      const view = render(page('conv-1'));
      return { insertAtCursor, switchConversation: () => view.rerender(page('conv-2')) };
    }

    async function holdTranscript() {
      await userEvent.click(screen.getByRole('button', { name: 'Voice' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Done' }));
      await screen.findByText('你好世界');
    }

    async function openAndCloseTheMenu() {
      await userEvent.click(screen.getByRole('button', { name: 'Other' }));
      expect(await screen.findByRole('menu')).toBeInTheDocument();
      await userEvent.keyboard('{Escape}');
      await vi.waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    }

    it('leaves the focus in the draft when Escape closes it, and the next Space starts no recording', async () => {
      renderBesideDraft();
      await holdTranscript();
      await userEvent.click(screen.getByRole('textbox', { name: 'Draft' }));
      await userEvent.keyboard('{Escape}');
      await vi.waitFor(() => expect(screen.queryByRole('button', { name: 'Insert' })).toBeNull());
      expect(screen.getByRole('textbox', { name: 'Draft' })).toHaveFocus();
      recordingMock.start.mockClear();
      await userEvent.keyboard(' ');
      expect(recordingMock.start).not.toHaveBeenCalled();
      expect(screen.getByRole('textbox', { name: 'Draft' })).toHaveValue(' ');
    });

    it('leaves the focus in the draft when a conversation switch closes it, and the next Space starts no recording', async () => {
      const { switchConversation } = renderBesideDraft();
      await holdTranscript();
      await userEvent.click(screen.getByRole('textbox', { name: 'Draft' }));
      switchConversation();
      await vi.waitFor(() => expect(screen.queryByRole('button', { name: 'Insert' })).toBeNull());
      expect(screen.getByRole('textbox', { name: 'Draft' })).toHaveFocus();
      recordingMock.start.mockClear();
      await userEvent.keyboard(' ');
      expect(recordingMock.start).not.toHaveBeenCalled();
      expect(screen.getByRole('textbox', { name: 'Draft' })).toHaveValue(' ');
    });

    // The transcript arrives while the user is typing in the draft: the card takes the focus by itself.
    async function holdTranscriptWhileTypingInTheDraft() {
      let finish: (value: unknown) => void = () => {};
      transcribeMock.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
      await userEvent.click(screen.getByRole('button', { name: 'Voice' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Done' }));
      await screen.findByText('Transcribing…');
      await userEvent.click(screen.getByRole('textbox', { name: 'Draft' }));
      await userEvent.keyboard('more');
      await act(async () => { finish({ text: '你好世界', audioSeconds: 1, inferenceSeconds: 0.1 }); });
      await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Insert' })).toHaveFocus());
    }

    it('returns the focus to the draft it took it from when Escape closes it, and the next Space starts no recording', async () => {
      renderBesideDraft();
      await holdTranscriptWhileTypingInTheDraft();
      await userEvent.keyboard('{Escape}');
      await vi.waitFor(() => expect(screen.queryByRole('button', { name: 'Insert' })).toBeNull());
      expect(screen.getByRole('textbox', { name: 'Draft' })).toHaveFocus();
      recordingMock.start.mockClear();
      await userEvent.keyboard(' ');
      expect(recordingMock.start).not.toHaveBeenCalled();
      expect(screen.getByRole('textbox', { name: 'Draft' })).toHaveValue('more ');
    });

    it('returns the focus to the draft it took it from when a conversation switch closes it, and the next Space starts no recording', async () => {
      const { switchConversation } = renderBesideDraft();
      await holdTranscriptWhileTypingInTheDraft();
      switchConversation();
      await vi.waitFor(() => expect(screen.queryByRole('button', { name: 'Insert' })).toBeNull());
      // The focus is settled once the card has left the page, one timer tick after it closed.
      await vi.waitFor(() => expect(screen.getByRole('textbox', { name: 'Draft' })).toHaveFocus());
      recordingMock.start.mockClear();
      await userEvent.keyboard(' ');
      expect(recordingMock.start).not.toHaveBeenCalled();
      expect(screen.getByRole('textbox', { name: 'Draft' })).toHaveValue('more ');
    });

    it('stays away while one layer hands over to another, and returns once the last has gone', async () => {
      let setLayer: (layer: 'a' | 'b' | null) => void = () => {};
      function TwoLayers() {
        const [layer, set] = useState<'a' | 'b' | null>(null);
        setLayer = set;
        return (
          <>
            <Popover open={layer === 'a'} trigger={<Button>A</Button>}>First</Popover>
            <Popover open={layer === 'b'} trigger={<Button>B</Button>}>Second</Popover>
          </>
        );
      }
      const insertAtCursor = vi.fn();
      render(
        <DesignSystemProvider>
          <TwoLayers />
          <VoiceInputControl
            resetKey="conv-1"
            getDraftSnapshot={() => ({ text: 'draft', start: 5, end: 5 })}
            insertIfUnchanged={() => false}
            insertAtCursor={insertAtCursor}
          />
        </DesignSystemProvider>,
      );
      await holdTranscript();
      vi.useFakeTimers();
      try {
        const settle = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
        act(() => setLayer('a'));
        await settle(1000);
        expect(screen.getByText('First')).toBeInTheDocument();
        expect(screen.queryByText('你好世界')).toBeNull();
        // A closes; B opens on the next event, before one fade has passed.
        act(() => setLayer(null));
        await settle(50);
        expect(screen.queryByText('你好世界')).toBeNull();
        act(() => setLayer('b'));
        await settle(1000);
        expect(screen.getByText('Second')).toBeInTheDocument();
        expect(screen.queryByText('你好世界')).toBeNull();
        act(() => setLayer(null));
        await settle(1000);
        expect(screen.getByText('你好世界')).toBeInTheDocument();
        expect(insertAtCursor).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    // The card comes back by itself, one fade after the other layer has gone. By then the user may
    // be typing in the draft again: the returning card does not take the keyboard from them.
    it('leaves the focus in the draft when it returns after another layer has gone, and takes it again when it opens anew', async () => {
      const insertAtCursor = vi.fn();
      const page = (otherOpen: boolean) => (
        <DesignSystemProvider>
          <TextArea aria-label="Draft" />
          <Popover open={otherOpen} trigger={<Button>Other</Button>}>Other layer</Popover>
          <VoiceInputControl
            resetKey="conv-1"
            getDraftSnapshot={() => ({ text: 'draft', start: 5, end: 5 })}
            insertIfUnchanged={() => false}
            insertAtCursor={insertAtCursor}
          />
        </DesignSystemProvider>
      );
      const view = render(page(false));
      await holdTranscript();
      // Shown for the first time, the card opens on Insert.
      await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Insert' })).toHaveFocus());
      const draft = screen.getByRole('textbox', { name: 'Draft' });
      const focused: string[] = [];
      const onFocusIn = (event: FocusEvent) => {
        if (event.target instanceof HTMLElement) focused.push(event.target.getAttribute('aria-label') ?? event.target.textContent ?? '');
      };
      vi.useFakeTimers();
      try {
        const settle = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
        view.rerender(page(true));
        await settle(1000);
        expect(screen.getByText('Other layer')).toBeInTheDocument();
        expect(screen.queryByText('你好世界')).toBeNull();
        view.rerender(page(false));
        await settle(50);
        act(() => draft.focus());
        document.addEventListener('focusin', onFocusIn);
        await settle(1000);
        document.removeEventListener('focusin', onFocusIn);
        expect(screen.getByText('你好世界')).toBeInTheDocument();
        expect(draft).toHaveFocus();
        expect(focused).toEqual([]);
        // Its buttons act as before.
        act(() => { fireEvent.click(screen.getByRole('button', { name: 'Discard' })); });
        await settle(1000);
        expect(screen.queryByText('你好世界')).toBeNull();
        expect(insertAtCursor).not.toHaveBeenCalled();
      } finally {
        document.removeEventListener('focusin', onFocusIn);
        vi.useRealTimers();
      }
      // A new transcript: this card has not been away, so it opens on Insert again.
      await holdTranscript();
      await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Insert' })).toHaveFocus());
    });

    it('is offered again after another layer has opened and closed, and Insert inserts exactly that text', async () => {
      const { insertAtCursor } = renderBesideDraft();
      await holdTranscript();
      await userEvent.click(screen.getByRole('button', { name: 'Other' }));
      expect(await screen.findByRole('menu')).toBeInTheDocument();
      expect(insertAtCursor).not.toHaveBeenCalled();
      // Escape belongs to the menu while the card has stepped aside.
      await userEvent.keyboard('{Escape}');
      await vi.waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
      expect(await screen.findByText('你好世界')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Insert' }));
      expect(insertAtCursor.mock.calls).toEqual([['你好世界']]);
    });

    it('is dropped by Escape', async () => {
      const { insertAtCursor } = renderBesideDraft();
      await holdTranscript();
      await userEvent.keyboard('{Escape}');
      await vi.waitFor(() => expect(screen.queryByText('你好世界')).toBeNull());
      await openAndCloseTheMenu();
      expect(screen.queryByText('你好世界')).toBeNull();
      expect(insertAtCursor).not.toHaveBeenCalled();
    });

    it('is dropped by Discard', async () => {
      const { insertAtCursor } = renderBesideDraft();
      await holdTranscript();
      await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
      await vi.waitFor(() => expect(screen.queryByText('你好世界')).toBeNull());
      await openAndCloseTheMenu();
      expect(screen.queryByText('你好世界')).toBeNull();
      expect(insertAtCursor).not.toHaveBeenCalled();
    });

    it('is dropped by a conversation switch, also while another layer is open', async () => {
      const { insertAtCursor, switchConversation } = renderBesideDraft();
      await holdTranscript();
      await userEvent.click(screen.getByRole('button', { name: 'Other' }));
      expect(await screen.findByRole('menu')).toBeInTheDocument();
      switchConversation();
      await userEvent.keyboard('{Escape}');
      await vi.waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
      expect(screen.queryByText('你好世界')).toBeNull();
      expect(insertAtCursor).not.toHaveBeenCalled();
    });

    it('stays while the user goes back to the draft to place the caret', async () => {
      renderBesideDraft();
      await userEvent.click(screen.getByRole('button', { name: 'Voice' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Done' }));
      await screen.findByText('你好世界');
      await userEvent.click(screen.getByRole('textbox', { name: 'Draft' }));
      await userEvent.keyboard('more');
      expect(screen.getByText('你好世界')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Insert' })).toBeInTheDocument();
    });

    it('leaves the focus in the draft after Insert', async () => {
      const { insertAtCursor } = renderBesideDraft();
      await userEvent.click(screen.getByRole('button', { name: 'Voice' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Done' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Insert' }));
      expect(insertAtCursor).toHaveBeenCalledWith('你好世界');
      await vi.waitFor(() => expect(screen.queryByRole('button', { name: 'Insert' })).toBeNull());
      expect(screen.getByRole('textbox', { name: 'Draft' })).toHaveFocus();
    });

    it('gives the focus back to the mic button after Discard', async () => {
      renderBesideDraft();
      await userEvent.click(screen.getByRole('button', { name: 'Voice' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Done' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Discard' }));
      await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Voice' })).toHaveFocus());
    });
  });

  describe('a card that is fading out', () => {
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

    it('keeps its text and takes no press', async () => {
      const spy = keepClosingLayersOnScreen();
      try {
        useSpeechStore.setState({ status: status('missing') });
        renderControl();
        await userEvent.click(screen.getByRole('button', { name: 'Voice' }));
        const later = screen.getByRole('button', { name: 'Later' });
        const goTo = screen.getByRole('button', { name: 'Go to download' });
        fireEvent.click(later);
        expect(goTo.closest('[data-state="closed"]')).not.toBeNull();
        expect(screen.getByText('Download the voice model first')).toBeInTheDocument();
        fireEvent.click(goTo);
        expect(useSettingsStore.getState().systemSettingsOpen).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('a card that fades out after a conversation switch', () => {
    it('paints no transcript of the conversation that was left', async () => {
      const real = window.getComputedStyle.bind(window);
      const spy = vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element, pseudo?: string | null) => {
        const styles = real(element, pseudo);
        return new Proxy(styles, {
          get(target, prop) {
            if (prop === 'animationName') return element.getAttribute('data-state') === 'closed' ? 'exit' : 'enter';
            const value = Reflect.get(target, prop);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      });
      try {
        const { insertIfUnchanged, rerender } = renderControl({ unchanged: false });
        await userEvent.click(screen.getByRole('button', { name: 'Voice' }));
        await userEvent.click(await screen.findByRole('button', { name: 'Done' }));
        await screen.findByText('你好世界');
        rerender(
          <VoiceInputControl
            resetKey="conv-2"
            getDraftSnapshot={() => ({ text: '', start: 0, end: 0 })}
            insertIfUnchanged={insertIfUnchanged}
            insertAtCursor={vi.fn()}
          />,
        );
        expect(document.querySelector('[data-ds-layer][data-state="closed"]')).not.toBeNull();
        expect(screen.queryByText('你好世界')).toBeNull();
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('keyboard focus', () => {
    it('moves from the mic button to 完成, to the pill while transcribing, and back to the mic button', async () => {
      let finish: (value: unknown) => void = () => {};
      transcribeMock.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
      const { insertIfUnchanged } = renderControl();
      screen.getByRole('button', { name: 'Voice' }).focus();
      await userEvent.keyboard('{Enter}');
      const done = await screen.findByRole('button', { name: 'Done' });
      await vi.waitFor(() => expect(done).toHaveFocus());
      await userEvent.keyboard('{Enter}');
      await screen.findByText('Transcribing…');
      await vi.waitFor(() => expect(screen.getByTestId('voice-recording-bar')).toHaveFocus());
      // The host puts the text in the draft without taking the focus in this test, so it returns to the mic button.
      await act(async () => { finish({ text: 'done', audioSeconds: 1, inferenceSeconds: 1 }); });
      expect(insertIfUnchanged).toHaveBeenCalled();
      await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Voice' })).toHaveFocus());
    });

    it('does not take the focus when the control never had it', async () => {
      render(
        <DesignSystemProvider>
          <TextArea aria-label="Draft" />
          <VoiceInputControl
            resetKey="conv-1"
            getDraftSnapshot={() => ({ text: '', start: 0, end: 0 })}
            insertIfUnchanged={() => true}
            insertAtCursor={vi.fn()}
          />
        </DesignSystemProvider>,
      );
      screen.getByRole('textbox', { name: 'Draft' }).focus();
      fireEvent.click(screen.getByRole('button', { name: 'Voice' }));
      await screen.findByTestId('voice-recording-bar');
      expect(screen.getByRole('textbox', { name: 'Draft' })).toHaveFocus();
    });
  });

  describe('the level meter', () => {
    afterEach(() => { delete document.documentElement.dataset.motion; });

    it('is drawn in the neutral text color, not in a status color', async () => {
      renderControl();
      await userEvent.click(screen.getByRole('button', { name: 'Voice' }));
      const meter = (await screen.findByTestId('voice-recording-bar')).querySelector('[aria-hidden="true"]');
      expect(meter).toHaveClass('text-label');
      expect(meter).not.toHaveClass('text-danger');
    });

    it('follows the input level', async () => {
      renderControl();
      await userEvent.click(screen.getByRole('button', { name: 'Voice' }));
      await screen.findByRole('button', { name: 'Done' });
      await vi.waitFor(() => expect(recordingMock.level).toHaveBeenCalled());
    });

    it('stays still under reduced motion while the recording goes on', async () => {
      document.documentElement.dataset.motion = 'reduced';
      const frames = vi.spyOn(window, 'requestAnimationFrame');
      renderControl();
      await userEvent.click(screen.getByRole('button', { name: 'Voice' }));
      await screen.findByRole('button', { name: 'Done' });
      await vi.waitFor(() => expect(frames.mock.calls.length).toBeGreaterThan(3));
      expect(recordingMock.level).not.toHaveBeenCalled();
      frames.mockRestore();
    });
  });
});
