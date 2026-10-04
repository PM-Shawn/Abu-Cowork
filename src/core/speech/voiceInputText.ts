/**
 * Pure helpers shared by the composer's mic control and the voice-input
 * settings page: draft insertion spacing and user-facing error sentences.
 */

import { format } from '@/i18n';
import type { TranslationDict } from '@/i18n/types';
import { RecordingError } from './recording';
import { SpeechRequestError, type SpeechLanguage, type SpeechStatus } from './speechBridge';

type VoiceText = TranslationDict['voiceInput'];

/** Draft state captured when recording starts; the transcript lands here only if it is unchanged. */
export interface VoiceDraftSnapshot {
  text: string;
  start: number;
  end: number;
}

/**
 * Text to insert after `before` (the draft up to the caret): a Latin/digit
 * transcript butting against a Latin/digit character gets a separating space;
 * CJK needs none.
 */
export function spaceForInsertion(before: string, text: string): string {
  return /[A-Za-z0-9]$/.test(before) && /^[A-Za-z0-9]/.test(text) ? ` ${text}` : text;
}

/** User-facing sentence for a capture or transcription failure. */
export function describeVoiceError(v: VoiceText, error: unknown): { message: string; permission: boolean } {
  if (error instanceof RecordingError) {
    switch (error.kind) {
      case 'permission': return { message: v.errPermission, permission: true };
      case 'no-device': return { message: v.errNoDevice, permission: false };
      case 'empty': return { message: v.errEmpty, permission: false };
      case 'interrupted': return { message: v.errInterrupted, permission: false };
      case 'unavailable': return { message: v.unavailable, permission: false };
      default: return { message: v.errTranscribe, permission: false };
    }
  }
  if (error instanceof SpeechRequestError) {
    if (error.code === 'busy') return { message: v.errBusy, permission: false };
    if (error.code === 'runtime-missing') return { message: v.runtimeMissing, permission: false };
    if (error.code === 'unavailable') return { message: v.unavailable, permission: false };
  }
  return { message: v.errTranscribe, permission: false };
}

function sourceLabel(v: VoiceText, source: string | undefined | null): string {
  if (source === 'hf-mirror') return v.sourceMirror;
  if (source === 'huggingface') return v.sourceHuggingface;
  return v.sourceAuto;
}

/** User-facing sentence for a failed model download. */
export function describeDownloadError(v: VoiceText, error: SpeechStatus['model']['error']): string {
  if (!error) return v.errUnknown;
  const source = sourceLabel(v, error.source);
  switch (error.code) {
    case 'network':
      return format(v.errNetwork, { source });
    case 'http':
      return format(v.errHttp, { source, status: error.status ?? '?' });
    case 'integrity':
      return format(v.errIntegrity, { file: error.file ?? '' });
    case 'storage':
      return v.errStorage;
    default:
      return v.errUnknown;
  }
}

export function speechLanguageOptions(v: VoiceText): { value: SpeechLanguage; label: string }[] {
  return [
    { value: 'auto', label: v.langAuto },
    { value: 'zh', label: v.langZh },
    { value: 'en', label: v.langEn },
    { value: 'yue', label: v.langYue },
    { value: 'ja', label: v.langJa },
    { value: 'ko', label: v.langKo },
  ];
}
