/**
 * Voice input preferences: whether the composer shows the mic button and
 * which language hint the recognizer gets.
 *
 * Kept out of `abu-settings` on purpose: that store's storage layer has
 * version-pinned browser-permission recovery paths, and voice input has no
 * reason to touch them. Model/download state is NOT here — the host owns it
 * (see speechStore.ts).
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { SpeechLanguage } from '@/core/speech/speechBridge';

const LANGUAGES: readonly SpeechLanguage[] = ['auto', 'zh', 'en', 'yue', 'ja', 'ko'];

interface VoiceInputState {
  enabled: boolean;
  language: SpeechLanguage;
}

interface VoiceInputActions {
  setEnabled: (enabled: boolean) => void;
  setLanguage: (language: SpeechLanguage) => void;
}

type VoiceInputStore = VoiceInputState & VoiceInputActions;

export const DEFAULT_VOICE_INPUT: VoiceInputState = { enabled: true, language: 'auto' };

export function migrateVoiceInputState(persisted: unknown): VoiceInputState {
  const state = persisted && typeof persisted === 'object' ? persisted as Record<string, unknown> : {};
  return {
    enabled: typeof state.enabled === 'boolean' ? state.enabled : DEFAULT_VOICE_INPUT.enabled,
    language: LANGUAGES.includes(state.language as SpeechLanguage)
      ? state.language as SpeechLanguage
      : DEFAULT_VOICE_INPUT.language,
  };
}

export const useVoiceInputStore = create<VoiceInputStore>()(
  persist(
    (set) => ({
      ...DEFAULT_VOICE_INPUT,
      setEnabled: (enabled) => set({ enabled }),
      setLanguage: (language) => set({ language: LANGUAGES.includes(language) ? language : 'auto' }),
    }),
    {
      name: 'abu-voice-input',
      version: 1,
      migrate: (persisted) => migrateVoiceInputState(persisted),
      partialize: (state) => ({ enabled: state.enabled, language: state.language }),
    },
  ),
);
