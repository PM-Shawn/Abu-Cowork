// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
/**
 * The voice input settings page: a download starts only while the settings window is open, and a
 * delete asks first, names what it deletes, reads the model state again at answer time and runs
 * once per question.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import VoiceInputSection from './VoiceInputSection';
import { DesignSystemProvider } from '@/components/ds/provider';
import { format, getI18n } from '@/i18n';
import { ensureSpeechStatus, useSpeechStore } from '@/stores/speechStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useToastStore } from '@/stores/toastStore';
import type { SpeechStatus } from '@/core/speech/speechBridge';
import { formatFileSize } from '@/utils/formatFileSize';
import { passSettleInterval } from '@/test/dsWindows';

vi.mock('@/core/speech/microphoneBridge', () => ({
  getMicrophoneStatus: vi.fn(async () => 'granted'),
  openMicrophoneSettings: vi.fn(async () => true),
}));

const TOTAL_BYTES = 241_357_257;

function status(state: SpeechStatus['model']['state']): SpeechStatus {
  return {
    runtimeAvailable: true,
    model: { state, totalBytes: TOTAL_BYTES, download: null, error: null },
    downloadSources: ['auto', 'hf-mirror', 'huggingface'],
    languages: ['auto', 'zh', 'en', 'yue', 'ja', 'ko'],
    maxAudioSeconds: 150,
  };
}

const downloadModel = vi.fn(async () => {});
const cancelDownload = vi.fn(async () => {});
const deleteModel = vi.fn(async () => {});

function renderPage(state: SpeechStatus['model']['state']) {
  useSpeechStore.setState({ status: status(state), unavailable: false });
  return render(<VoiceInputSection />, { wrapper: DesignSystemProvider });
}

// Presses the page's delete button and returns the question it asks.
async function askToDelete() {
  await userEvent.click(screen.getByRole('button', { name: getI18n().voiceInput.deleteModel }));
  return screen.findByRole('alertdialog');
}

async function answerYes(question: HTMLElement) {
  // The question takes no pointer press for a moment after it appears: it has been read.
  passSettleInterval();
  await userEvent.click(within(question).getByRole('button', { name: getI18n().voiceInput.deleteModel }));
}

describe('VoiceInputSection', () => {
  beforeAll(() => {
    // The page asks the host for the status once; in this test the store is set by hand.
    ensureSpeechStatus();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    deleteModel.mockImplementation(async () => {});
    useSpeechStore.setState({ downloadModel, cancelDownload, deleteModel });
    useSettingsStore.setState({ systemSettingsOpen: true });
    useToastStore.setState({ toasts: [] });
  });

  afterEach(() => {
    cleanup();
  });

  describe('download', () => {
    it('starts with the chosen source while the settings window is open', async () => {
      renderPage('missing');
      await userEvent.click(screen.getByRole('button', { name: getI18n().voiceInput.download }));
      expect(downloadModel.mock.calls).toEqual([['auto']]);
    });

    it('does not start once the settings window is closing', async () => {
      renderPage('missing');
      useSettingsStore.setState({ systemSettingsOpen: false });
      await userEvent.click(screen.getByRole('button', { name: getI18n().voiceInput.download }));
      expect(downloadModel).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('asks first and names what it deletes', async () => {
      const v = getI18n().voiceInput;
      renderPage('ready');
      const question = await askToDelete();
      expect(deleteModel).not.toHaveBeenCalled();
      expect(within(question).getByText(format(v.modelDesc, { size: formatFileSize(TOTAL_BYTES) }))).toBeInTheDocument();
      expect(question).toHaveAccessibleName(v.deleteModel);
    });

    it('deletes after a yes and says so', async () => {
      renderPage('ready');
      await answerYes(await askToDelete());
      await vi.waitFor(() => expect(useToastStore.getState().toasts.map((toast) => toast.title)).toEqual([getI18n().voiceInput.deleted]));
      expect(deleteModel).toHaveBeenCalledTimes(1);
    });

    it('does nothing when the model has gone by the time the answer comes', async () => {
      renderPage('ready');
      const question = await askToDelete();
      useSpeechStore.setState({ status: status('missing') });
      await answerYes(question);
      await vi.waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      expect(deleteModel).not.toHaveBeenCalled();
      expect(useToastStore.getState().toasts).toEqual([]);
    });

    it('runs one delete when a second question is answered while the first delete is running', async () => {
      let finish: () => void = () => {};
      deleteModel.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
      renderPage('ready');
      await answerYes(await askToDelete());
      await vi.waitFor(() => expect(deleteModel).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      await answerYes(await askToDelete());
      await vi.waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      expect(deleteModel).toHaveBeenCalledTimes(1);
      finish();
      await vi.waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    });
  });
});
