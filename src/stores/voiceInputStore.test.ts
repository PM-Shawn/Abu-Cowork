// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_VOICE_INPUT, migrateVoiceInputState, useVoiceInputStore } from './voiceInputStore';

describe('voiceInputStore', () => {
  beforeEach(() => {
    useVoiceInputStore.setState({ ...DEFAULT_VOICE_INPUT });
  });

  describe('defaults', () => {
    it('is on with automatic language detection', () => {
      expect(DEFAULT_VOICE_INPUT).toEqual({ enabled: true, language: 'auto' });
    });
  });

  describe('actions', () => {
    it('toggles and sets a supported language', () => {
      useVoiceInputStore.getState().setEnabled(false);
      useVoiceInputStore.getState().setLanguage('yue');
      expect(useVoiceInputStore.getState()).toMatchObject({ enabled: false, language: 'yue' });
    });

    it('falls back to auto for an unsupported language', () => {
      useVoiceInputStore.getState().setLanguage('fr' as never);
      expect(useVoiceInputStore.getState().language).toBe('auto');
    });
  });

  describe('migrate', () => {
    it('keeps valid fields and repairs invalid ones', () => {
      expect(migrateVoiceInputState({ enabled: false, language: 'ja' })).toEqual({ enabled: false, language: 'ja' });
      expect(migrateVoiceInputState({ enabled: 'yes', language: 'xx' })).toEqual(DEFAULT_VOICE_INPUT);
      expect(migrateVoiceInputState(null)).toEqual(DEFAULT_VOICE_INPUT);
    });
  });

  describe('persist', () => {
    it('writes only the preferences under a versioned key', () => {
      useVoiceInputStore.getState().setLanguage('en');
      const raw = JSON.parse(localStorage.getItem('abu-voice-input') ?? '{}');
      expect(raw.version).toBe(1);
      expect(raw.state).toEqual({ enabled: true, language: 'en' });
    });
  });
});
