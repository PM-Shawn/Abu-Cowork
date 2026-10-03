// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
/**
 * The composer's mic control: guides to setup when the model is missing,
 * records → transcribes → inserts into an unchanged draft, holds the text for
 * an explicit insert when the draft changed, and cancels on Escape or a
 * conversation switch without ever inserting late.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import VoiceInputControl from './VoiceInputControl';
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
});
