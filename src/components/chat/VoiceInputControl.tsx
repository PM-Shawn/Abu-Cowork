import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Loader2, Mic, X } from 'lucide-react';
import { format, useI18n } from '@/i18n';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Recording } from '@/core/speech/recording';
import { transcribeSpeech } from '@/core/speech/speechBridge';
import { describeVoiceError, type VoiceDraftSnapshot } from '@/core/speech/voiceInputText';
import { openMicrophoneSettings } from '@/core/speech/microphoneBridge';
import { ensureSpeechStatus, selectSpeechReady, useSpeechStore } from '@/stores/speechStore';
import { useVoiceInputStore } from '@/stores/voiceInputStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { formatFileSize } from '@/utils/formatFileSize';
import { isMacOS, isWindows } from '@/utils/platform';

/** Recording stops by itself shortly before the host's audio limit. */
const MAX_RECORDING_SECONDS = 120;
const WAVE_BARS = 18;

type Phase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'recording' }
  | { kind: 'transcribing' }
  | { kind: 'setup' }
  | { kind: 'pending'; text: string }
  | { kind: 'error'; message: string; permission: boolean };

/**
 * Mic button for the composer toolbar. Idle it is one icon button; while
 * recording it expands into a pill with a live level meter, cancel and done.
 * Transcription only ever inserts into the draft — it never sends.
 *
 * `resetKey` (the draft key) changing — a conversation switch — cancels any
 * capture and drops late results, as does Escape or hiding the window.
 */
export default function VoiceInputControl({
  resetKey,
  getDraftSnapshot,
  insertIfUnchanged,
  insertAtCursor,
}: {
  resetKey: string;
  getDraftSnapshot: () => VoiceDraftSnapshot;
  /** Insert at the snapshot's selection when the draft still equals it; false otherwise. */
  insertIfUnchanged: (text: string, snapshot: VoiceDraftSnapshot) => boolean;
  /** Explicit insert of a held transcript at the current caret. */
  insertAtCursor: (text: string) => void;
}) {
  const { t } = useI18n();
  const v = t.voiceInput;
  const language = useVoiceInputStore((s) => s.language);
  const ready = useSpeechStore(selectSpeechReady);
  const status = useSpeechStore((s) => s.status);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [levels, setLevels] = useState<number[]>(() => new Array(WAVE_BARS).fill(0));
  const [elapsed, setElapsed] = useState(0);
  const recordingRef = useRef<Recording | null>(null);
  const snapshotRef = useRef<VoiceDraftSnapshot | null>(null);
  const generationRef = useRef(0);
  const frameRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);
  const stopRef = useRef<() => void>(() => {});

  useEffect(() => { ensureSpeechStatus(); }, []);

  const stopMeter = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  }, []);

  /** Drop the current capture and any result still in flight. */
  const abort = useCallback(() => {
    generationRef.current += 1;
    stopMeter();
    const recording = recordingRef.current;
    recordingRef.current = null;
    void recording?.dispose().catch(() => undefined);
  }, [stopMeter]);

  const fail = useCallback((error: unknown) => {
    abort();
    setPhase({ kind: 'error', ...describeVoiceError(v, error) });
  }, [abort, v]);

  const start = useCallback(async () => {
    if (!ready) {
      setPhase({ kind: 'setup' });
      return;
    }
    abort();
    const generation = generationRef.current;
    const recording = new Recording();
    recordingRef.current = recording;
    snapshotRef.current = getDraftSnapshot();
    setPhase({ kind: 'starting' });
    try {
      await recording.start((error) => {
        if (generationRef.current === generation) fail(error);
      });
    } catch (error) {
      if (generationRef.current === generation) fail(error);
      return;
    }
    if (generationRef.current !== generation) return;
    startedAtRef.current = performance.now();
    setElapsed(0);
    setPhase({ kind: 'recording' });
    const tick = () => {
      if (generationRef.current !== generation) return;
      const seconds = (performance.now() - startedAtRef.current) / 1000;
      setElapsed(Math.floor(seconds));
      setLevels((previous) => [...previous.slice(1), recording.level()]);
      if (seconds >= MAX_RECORDING_SECONDS) {
        stopRef.current();
        return;
      }
      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);
  }, [abort, fail, getDraftSnapshot, ready]);

  const stop = useCallback(async () => {
    const recording = recordingRef.current;
    if (!recording) return;
    const generation = generationRef.current;
    stopMeter();
    setPhase({ kind: 'transcribing' });
    try {
      const wave = await recording.stop(MAX_RECORDING_SECONDS);
      if (generationRef.current !== generation) return;
      const result = await transcribeSpeech(wave, language);
      if (generationRef.current !== generation) return;
      recordingRef.current = null;
      const text = result.text.trim();
      if (!text) {
        setPhase({ kind: 'error', message: v.errNoSpeech, permission: false });
        return;
      }
      const snapshot = snapshotRef.current;
      if (snapshot && insertIfUnchanged(text, snapshot)) {
        setPhase({ kind: 'idle' });
      } else {
        setPhase({ kind: 'pending', text });
      }
    } catch (error) {
      if (generationRef.current === generation) fail(error);
    }
  }, [fail, insertIfUnchanged, language, stopMeter, v]);
  useEffect(() => {
    stopRef.current = () => { void stop(); };
  }, [stop]);

  const cancel = useCallback(() => {
    abort();
    setPhase({ kind: 'idle' });
  }, [abort]);

  // Conversation switch: nothing recorded for the old draft may land in the new one.
  useEffect(() => {
    cancel();
  }, [resetKey, cancel]);

  // Release the microphone when the composer goes away.
  useEffect(() => () => abort(), [abort]);

  const active = phase.kind === 'starting' || phase.kind === 'recording' || phase.kind === 'transcribing';
  useEffect(() => {
    if (phase.kind === 'idle') return;
    // Capture phase + stopPropagation: Escape here must not also reach the
    // composer (which can stop a streaming reply) or close an outer view.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [cancel, phase.kind]);

  useEffect(() => {
    if (!active) return;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden' && phase.kind !== 'transcribing') cancel();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [active, cancel, phase.kind]);

  const openVoiceSettings = () => {
    setPhase({ kind: 'idle' });
    useSettingsStore.getState().openSystemSettings('voice-input');
  };

  const sizeText = formatFileSize(status?.model.totalBytes ?? 241_357_257);
  const downloading = status?.model.state === 'downloading';
  const canOpenMicSettings = isMacOS() || isWindows();

  if (phase.kind === 'starting' || phase.kind === 'recording' || phase.kind === 'transcribing') {
    const transcribing = phase.kind === 'transcribing';
    return (
      <div
        data-testid="voice-recording-bar"
        className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-[var(--abu-border)] bg-[var(--abu-bg-muted)] pl-2 pr-0.5"
      >
        {transcribing ? (
          <span className="flex items-center gap-1.5 text-minor text-[var(--abu-text-secondary)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {v.transcribing}
          </span>
        ) : (
          <>
            <span className="sr-only">{v.recording}</span>
            <div className="flex h-4 items-center gap-[2px]" aria-hidden="true">
              {levels.map((level, index) => (
                <span
                  key={index}
                  className="w-[2px] rounded-full bg-[var(--abu-clay)]"
                  style={{ height: `${Math.max(2, Math.min(16, 2 + level * 60))}px` }}
                />
              ))}
            </div>
            <span className="w-8 text-right text-caption tabular-nums text-[var(--abu-text-muted)]">
              {`${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`}
            </span>
          </>
        )}
        <Button
          size="icon"
          variant="ghost"
          onClick={cancel}
          aria-label={v.cancelRecording}
          title={v.cancelRecording}
          className="h-6 w-6 rounded-md text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)]"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
        {!transcribing && (
          <Button
            size="icon"
            onClick={() => void stop()}
            disabled={phase.kind !== 'recording'}
            aria-label={v.stop}
            title={v.stop}
            className="h-6 w-6 rounded-md bg-[var(--abu-clay)] text-white hover:bg-[var(--abu-clay-hover)]"
          >
            <Check className="h-3.5 w-3.5" strokeWidth={2.5} />
          </Button>
        )}
      </div>
    );
  }

  const card = (children: ReactNode) => (
    <div
      role="dialog"
      className="absolute bottom-full right-0 z-50 mb-2 w-72 rounded-xl border border-[var(--abu-border)] bg-[var(--abu-bg-base)] p-3 shadow-lg"
    >
      {children}
    </div>
  );

  return (
    <div className="relative shrink-0">
      <Button
        size="icon"
        variant="ghost"
        onClick={() => void start()}
        aria-label={v.start}
        title={v.start}
        className="h-7 w-7 rounded-lg text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)]"
      >
        <Mic className="h-4 w-4" />
      </Button>

      {phase.kind === 'setup' && card(
        <>
          <p className="text-h-xs text-[var(--abu-text-primary)]">{v.setupTitle}</p>
          <p className="mt-1 text-minor text-[var(--abu-text-muted)]">
            {downloading ? v.setupDownloading : format(v.setupBody, { size: sizeText })}
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setPhase({ kind: 'idle' })}>{v.later}</Button>
            <Button size="sm" autoFocus onClick={openVoiceSettings}>{v.setupGoto}</Button>
          </div>
        </>,
      )}

      {phase.kind === 'pending' && card(
        <>
          <p className="text-minor text-[var(--abu-text-muted)]">{v.pendingHint}</p>
          <p className="mt-1.5 line-clamp-4 text-body text-[var(--abu-text-primary)]">{phase.text}</p>
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setPhase({ kind: 'idle' })}>{v.discard}</Button>
            <Button
              size="sm"
              autoFocus
              onClick={() => {
                insertAtCursor(phase.text);
                setPhase({ kind: 'idle' });
              }}
            >
              {v.insert}
            </Button>
          </div>
        </>,
      )}

      {phase.kind === 'error' && card(
        <>
          <p className={cn('text-minor text-[var(--abu-danger)]')}>{phase.message}</p>
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setPhase({ kind: 'idle' })}>{v.later}</Button>
            {phase.permission && canOpenMicSettings && (
              <Button size="sm" onClick={() => { void openMicrophoneSettings(); setPhase({ kind: 'idle' }); }}>
                {v.openSystemSettings}
              </Button>
            )}
          </div>
        </>,
      )}
    </div>
  );
}
