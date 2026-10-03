import { describe, expect, it } from 'vitest';
import zhCN from '@/i18n/locales/zh-CN';
import enUS from '@/i18n/locales/en-US';
import { RecordingError } from './recording';
import { SpeechRequestError } from './speechBridge';
import {
  describeDownloadError,
  describeVoiceError,
  spaceForInsertion,
  speechLanguageOptions,
} from './voiceInputText';

const v = zhCN.voiceInput;

describe('voiceInputText', () => {
  describe('spaceForInsertion', () => {
    it('separates Latin words but not CJK', () => {
      expect(spaceForInsertion('hello', 'world')).toBe(' world');
      expect(spaceForInsertion('hello ', 'world')).toBe('world');
      expect(spaceForInsertion('你好', '世界')).toBe('世界');
      expect(spaceForInsertion('version 2', '3')).toBe(' 3');
      expect(spaceForInsertion('', 'Hi')).toBe('Hi');
      expect(spaceForInsertion('ok', '好的')).toBe('好的');
    });
  });

  describe('describeVoiceError', () => {
    it('flags permission failures so the UI can offer System Settings', () => {
      expect(describeVoiceError(v, new RecordingError('permission'))).toEqual({ message: v.errPermission, permission: true });
    });

    it('maps capture and host failures to their sentences', () => {
      expect(describeVoiceError(v, new RecordingError('no-device')).message).toBe(v.errNoDevice);
      expect(describeVoiceError(v, new RecordingError('empty')).message).toBe(v.errEmpty);
      expect(describeVoiceError(v, new RecordingError('interrupted')).message).toBe(v.errInterrupted);
      expect(describeVoiceError(v, new SpeechRequestError('busy', 'x')).message).toBe(v.errBusy);
      expect(describeVoiceError(v, new SpeechRequestError('runtime-missing', 'x')).message).toBe(v.runtimeMissing);
      expect(describeVoiceError(v, new Error('boom')).message).toBe(v.errTranscribe);
    });
  });

  describe('describeDownloadError', () => {
    it('names the source and status the host reported', () => {
      expect(describeDownloadError(v, { code: 'http', source: 'hf-mirror', status: 503 })).toBe('下载源返回错误 503（HF-Mirror 国内镜像）。可以换一个下载源重试。');
      expect(describeDownloadError(enUS.voiceInput, { code: 'network', source: 'huggingface' }))
        .toBe('Could not connect (Hugging Face). Try another download source.');
      expect(describeDownloadError(v, { code: 'integrity', file: 'tokens.txt' })).toContain('tokens.txt');
      expect(describeDownloadError(v, { code: 'storage' })).toBe(v.errStorage);
      expect(describeDownloadError(v, null)).toBe(v.errUnknown);
    });
  });

  describe('speechLanguageOptions', () => {
    it('lists every SenseVoice language hint once', () => {
      expect(speechLanguageOptions(v).map((option) => option.value)).toEqual(['auto', 'zh', 'en', 'yue', 'ja', 'ko']);
    });
  });
});
