/**
 * Renderer access to the voice-input host (electron/speechHost.cjs): model
 * status/download and transcription. The host returns `{ ok, value | error }`
 * so the error code survives IPC; this module turns failures into
 * {@link SpeechRequestError}.
 */

export type SpeechLanguage = 'auto' | 'zh' | 'en' | 'yue' | 'ja' | 'ko';
export type SpeechDownloadSource = 'auto' | 'hf-mirror' | 'huggingface';
export type SpeechModelState = 'checking' | 'missing' | 'downloading' | 'ready' | 'error';

export type SpeechErrorCode =
  | 'network'
  | 'http'
  | 'integrity'
  | 'storage'
  | 'cancelled'
  | 'not-ready'
  | 'runtime-missing'
  | 'busy'
  | 'timeout'
  | 'worker'
  | 'recognizer'
  | 'invalid'
  | 'unavailable'
  | 'unknown';

export interface SpeechDownloadProgress {
  file: string;
  fileIndex: number;
  fileCount: number;
  received: number;
  total: number;
  source: Exclude<SpeechDownloadSource, 'auto'> | null;
}

export interface SpeechStatus {
  runtimeAvailable: boolean;
  model: {
    state: SpeechModelState;
    totalBytes: number;
    download: SpeechDownloadProgress | null;
    error: { code: SpeechErrorCode; file?: string; source?: string; status?: number } | null;
  };
  downloadSources: SpeechDownloadSource[];
  languages: SpeechLanguage[];
  maxAudioSeconds: number;
}

export interface SpeechTranscript {
  text: string;
  audioSeconds: number;
  inferenceSeconds: number;
}

export class SpeechRequestError extends Error {
  readonly code: SpeechErrorCode;

  constructor(code: SpeechErrorCode, message: string) {
    super(message);
    this.name = 'SpeechRequestError';
    this.code = code;
  }
}

type SpeechAction = 'status' | 'prepare' | 'cancel' | 'delete' | 'transcribe';
type SpeechReply = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } };

interface SpeechShell {
  speech?: (action: SpeechAction, request?: Record<string, unknown>) => Promise<SpeechReply>;
  subscribeSpeechEvents?: (callback: (event: { type: 'status'; status: SpeechStatus }) => void) => () => void;
}

function shell(): SpeechShell | undefined {
  return (globalThis as typeof globalThis & { __ABU_SHELL__?: SpeechShell }).__ABU_SHELL__;
}

/** Whether this renderer runs inside the Electron host that provides voice input. */
export function isSpeechAvailable(): boolean {
  return typeof shell()?.speech === 'function';
}

async function call<T>(action: SpeechAction, request?: Record<string, unknown>): Promise<T> {
  const speech = shell()?.speech;
  if (!speech) throw new SpeechRequestError('unavailable', 'Voice input requires the Abu desktop app');
  const reply = await speech(action, request);
  if (!reply.ok) throw new SpeechRequestError(reply.error.code as SpeechErrorCode, reply.error.message);
  return reply.value as T;
}

export const getSpeechStatus = () => call<SpeechStatus>('status');
export const prepareSpeechModel = (source: SpeechDownloadSource = 'auto') => call<SpeechStatus>('prepare', { source });
export const cancelSpeechModelDownload = () => call<SpeechStatus>('cancel');
export const deleteSpeechModel = () => call<SpeechStatus>('delete');
export const transcribeSpeech = (audio: Uint8Array, language: SpeechLanguage) =>
  call<SpeechTranscript>('transcribe', { audio, language });

/** Subscribe to host status pushes; returns an unsubscribe (no-op outside Electron). */
export function subscribeSpeechStatus(callback: (status: SpeechStatus) => void): () => void {
  const subscribe = shell()?.subscribeSpeechEvents;
  if (!subscribe) return () => {};
  return subscribe((event) => {
    if (event && event.type === 'status') callback(event.status);
  });
}
