/**
 * Speech store — the voice-input host's live status (model download state,
 * runtime availability) for the settings page and the composer's mic button.
 *
 * Purely ephemeral (no persist): the host owns the truth (files on disk), so
 * every launch re-reads it. `ensureSpeechStatus()` starts one host
 * subscription for the whole renderer; later callers reuse it.
 */

import { create } from 'zustand';
import {
  cancelSpeechModelDownload,
  deleteSpeechModel,
  getSpeechStatus,
  isSpeechAvailable,
  prepareSpeechModel,
  subscribeSpeechStatus,
  type SpeechDownloadSource,
  type SpeechStatus,
} from '@/core/speech/speechBridge';

interface SpeechState {
  /** Null until the first host reply (or outside the desktop app). */
  status: SpeechStatus | null;
  /** The host is unreachable (browser preview) or the status call failed. */
  unavailable: boolean;
}

interface SpeechActions {
  setStatus: (status: SpeechStatus) => void;
  downloadModel: (source: SpeechDownloadSource) => Promise<void>;
  cancelDownload: () => Promise<void>;
  deleteModel: () => Promise<void>;
}

type SpeechStore = SpeechState & SpeechActions;

export const useSpeechStore = create<SpeechStore>()((set) => ({
  status: null,
  unavailable: false,

  setStatus: (status) => set({ status, unavailable: false }),

  downloadModel: async (source) => {
    set({ status: await prepareSpeechModel(source) });
  },

  cancelDownload: async () => {
    set({ status: await cancelSpeechModelDownload() });
  },

  deleteModel: async () => {
    set({ status: await deleteSpeechModel() });
  },
}));

let started = false;

/** Load the host status once and keep it current; safe to call from any component. */
export function ensureSpeechStatus(): void {
  if (started) return;
  started = true;
  if (!isSpeechAvailable()) {
    useSpeechStore.setState({ unavailable: true });
    return;
  }
  subscribeSpeechStatus((status) => useSpeechStore.getState().setStatus(status));
  getSpeechStatus().then(
    (status) => useSpeechStore.getState().setStatus(status),
    () => useSpeechStore.setState({ unavailable: true }),
  );
}

/** Test hook: forget the one-time subscription. */
export function resetSpeechStatusForTest(): void {
  started = false;
}

/** The model is on disk, verified, and the native runtime is present. */
export const selectSpeechReady = (state: SpeechState): boolean =>
  !!state.status && state.status.runtimeAvailable && state.status.model.state === 'ready';
