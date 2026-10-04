import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type MouseEvent } from 'react';
import { format, useI18n } from '@/i18n';
import { Button, IconButton } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { InlineMessage } from '@/components/ds/inline-message';
import { Popover } from '@/components/ds/popover';
import { Spinner } from '@/components/ds/spinner';
import { FOCUS_RING } from '@/components/ds/styles';
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
/** The longest fade of a design-system layer: `duration-base` in src/styles/tokens.css. */
const LAYER_FADE_MS = 200;

type Phase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'recording' }
  | { kind: 'transcribing' }
  | { kind: 'setup' }
  | { kind: 'pending'; text: string }
  | { kind: 'error'; message: string; permission: boolean };

/** The phases that show a card over the mic button. */
type CardPhase = Extract<Phase, { kind: 'setup' | 'pending' | 'error' }>;

function focusIsOnWindow(): boolean {
  return !document.activeElement || document.activeElement === document.body;
}

/**
 * Mic button for the composer toolbar. Idle it is one icon button; while
 * recording it expands into a pill with a live level meter, cancel and done.
 * Transcription only ever inserts into the draft — it never sends.
 *
 * `resetKey` (the draft key) changing — a conversation switch — cancels any
 * capture and drops late results, as does Escape or hiding the window.
 *
 * Focus: the mic button and the pill replace each other, so when the control
 * held the keyboard focus it hands it on (mic → pill → 完成 → pill → mic)
 * and the focus is never left on the window.
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
  const rootRef = useRef<HTMLDivElement>(null);
  const micRef = useRef<HTMLButtonElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  // The keyboard focus was last inside this control (its buttons, the pill or a card).
  const heldFocusRef = useRef(false);
  // The card closed because its text went into the draft: the focus stays in the draft.
  const keepFocusInDraftRef = useRef(false);

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
      // Reduced motion: the meter stays still; the running time still shows that it is listening.
      if (document.documentElement.dataset.motion !== 'reduced') {
        setLevels((previous) => [...previous.slice(1), recording.level()]);
      }
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

  // The card over the mic button. It keeps its content while it fades out (`heldCard`).
  const cardPhase: CardPhase | null =
    phase.kind === 'setup' || phase.kind === 'pending' || phase.kind === 'error' ? phase : null;
  const [heldCard, setHeldCard] = useState<CardPhase | null>(cardPhase);
  if (cardPhase && heldCard !== cardPhase) setHeldCard(cardPhase);
  // The pill replaces the mic button and its card at once: no fade, nothing to keep.
  if (!cardPhase && phase.kind !== 'idle' && heldCard) setHeldCard(null);
  const shownCard = cardPhase ?? heldCard;

  // One menu or popover is open at a time, so the card closes when another layer opens. A held
  // transcript is the user's input: it stays held (`steppedAside`) and the card shows it again
  // once that layer has gone. Only the user's answer, Escape, a new recording or a conversation
  // switch ends it.
  const [steppedAside, setSteppedAside] = useState(false);
  if (steppedAside && phase.kind !== 'pending') setSteppedAside(false);
  // The card that is open now; its buttons act only on this one.
  const openCard = steppedAside ? null : cardPhase;
  useEffect(() => {
    if (!steppedAside) return;
    // The other layer joins the page in the commit that closed the card and leaves it later:
    // every change of the page after that is checked for an open layer. When none is left the
    // card waits one fade and looks again, so a layer that hands over to another one (a menu
    // item that opens a window) does not bring the card back in between.
    let waiting: number | null = null;
    const anotherLayerIsOpen = () => document.querySelector('[data-ds-layer][data-state="open"]') !== null;
    const returnWhenAlone = () => {
      if (anotherLayerIsOpen() || waiting !== null) return;
      waiting = window.setTimeout(() => {
        waiting = null;
        if (!anotherLayerIsOpen()) setSteppedAside(false);
      }, LAYER_FADE_MS);
    };
    const observer = new MutationObserver(returnWhenAlone);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-state'] });
    return () => {
      observer.disconnect();
      if (waiting !== null) window.clearTimeout(waiting);
    };
  }, [steppedAside]);

  // What had the focus before the card took it. The card opens by itself when a transcript
  // arrives, often while the user is typing in the draft: Escape and a conversation switch give
  // the focus back there. Read in a layout effect, which runs before the card's content mounts.
  const cardIsOpen = openCard !== null;
  const beforeCardRef = useRef<{ element: HTMLElement | null; inControl: boolean }>({ element: null, inControl: false });
  const closedByButtonRef = useRef(false);
  useLayoutEffect(() => {
    if (!cardIsOpen) return;
    const focused = document.activeElement;
    const element = focused instanceof HTMLElement && focused !== document.body ? focused : null;
    beforeCardRef.current = { element, inControl: element !== null && rootRef.current?.contains(element) === true };
    closedByButtonRef.current = false;
  }, [cardIsOpen]);

  // Conversation switch: nothing recorded for the old draft may land in the new one,
  // and the card that fades out shows nothing of it.
  useEffect(() => {
    cancel();
    setHeldCard(null);
  }, [resetKey, cancel]);

  // Release the microphone when the composer goes away.
  useEffect(() => () => abort(), [abort]);

  const active = phase.kind === 'starting' || phase.kind === 'recording' || phase.kind === 'transcribing';
  useEffect(() => {
    // While the card has stepped aside for another layer, Escape belongs to that layer.
    if (phase.kind === 'idle' || steppedAside) return;
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
  }, [cancel, phase.kind, steppedAside]);

  useEffect(() => {
    if (!active) return;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden' && phase.kind !== 'transcribing') cancel();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [active, cancel, phase.kind]);

  // The mic button and the pill replace each other. When the control held the focus and the
  // focused element has just left the page, the focus moves on inside the control.
  // A card that closes is not part of this: where the focus goes then is `settleFocusAfterCard`.
  const pillWasShownRef = useRef(false);
  useEffect(() => {
    const pillWasShown = pillWasShownRef.current;
    pillWasShownRef.current = active;
    if (!heldFocusRef.current) return;
    if (phase.kind === 'recording' && (focusIsOnWindow() || document.activeElement === barRef.current)) {
      doneRef.current?.focus();
    } else if (active && focusIsOnWindow()) {
      barRef.current?.focus();
    } else if (phase.kind === 'idle' && pillWasShown && focusIsOnWindow()) {
      micRef.current?.focus();
    }
  }, [active, phase.kind]);

  const noteFocus = () => { heldFocusRef.current = true; };
  const noteBlur = (event: FocusEvent) => {
    // The focus went to another control (the draft, another button): it is no longer ours.
    // No related target means the focused element left the page; the effect above handles that.
    const next = event.relatedTarget;
    if (next instanceof Node && !rootRef.current?.contains(next)) heldFocusRef.current = false;
  };

  // Later and Discard: a button of the card closes it.
  const closeCard = () => {
    if (!openCard) return;
    closedByButtonRef.current = true;
    setPhase({ kind: 'idle' });
  };
  // Another layer opened and the layer registry closed the card. Nothing else closes it this
  // way: its buttons and Escape set the phase, and a press outside or on the mic leaves it open.
  const cardClosedForAnotherLayer = () => {
    if (openCard?.kind === 'pending') setSteppedAside(true);
    else if (openCard) setPhase({ kind: 'idle' });
  };
  // Where the focus goes once the card has left the page.
  const settleFocusAfterCard = (event: Event) => {
    const before = beforeCardRef.current;
    const byButton = closedByButtonRef.current;
    beforeCardRef.current = { element: null, inControl: false };
    closedByButtonRef.current = false;
    if (keepFocusInDraftRef.current) {
      event.preventDefault();
    } else if (byButton || before.inControl) {
      // The user was in the control: the mic button takes the focus when the control still holds it.
      if (!heldFocusRef.current) event.preventDefault();
    } else {
      // Escape or a conversation switch closed a card that opened by itself. The focus goes back
      // to where the user was and never to the mic button, where a key would start the microphone.
      event.preventDefault();
      if (before.element?.isConnected && focusIsOnWindow()) before.element.focus();
    }
    keepFocusInDraftRef.current = false;
  };
  const openVoiceSettings = () => {
    if (!openCard) return;
    closedByButtonRef.current = true;
    setPhase({ kind: 'idle' });
    useSettingsStore.getState().openSystemSettings('voice-input');
  };
  const insertHeldText = () => {
    if (openCard?.kind !== 'pending') return;
    // insertAtCursor puts the focus in the draft; the closing card must not take it back.
    keepFocusInDraftRef.current = true;
    insertAtCursor(openCard.text);
    setPhase({ kind: 'idle' });
  };
  const openMicSettings = () => {
    if (!openCard) return;
    closedByButtonRef.current = true;
    void openMicrophoneSettings();
    setPhase({ kind: 'idle' });
  };
  const startFromMic = (event: MouseEvent) => {
    // The mic button is also the card's anchor: a press starts (or restarts) voice input
    // and must not be read as "toggle the card".
    event.preventDefault();
    keepFocusInDraftRef.current = false;
    void start();
  };

  const sizeText = formatFileSize(status?.model.totalBytes ?? 241_357_257);
  const downloading = status?.model.state === 'downloading';
  const canOpenMicSettings = isMacOS() || isWindows();
  const transcribing = phase.kind === 'transcribing';

  return (
    <div ref={rootRef} className="flex shrink-0 items-center" onFocusCapture={noteFocus} onBlurCapture={noteBlur}>
      {active ? (
        <div
          ref={barRef}
          tabIndex={-1}
          role="group"
          aria-label={transcribing ? v.transcribing : v.recording}
          data-testid="voice-recording-bar"
          className={cn('flex h-7 shrink-0 items-center gap-2 rounded-control bg-fill pl-2 pr-1', FOCUS_RING)}
        >
          {transcribing ? (
            <Spinner size="sm" label={v.transcribing} />
          ) : (
            <>
              <span className="sr-only">{v.recording}</span>
              {/* Listening is shown by the microphone shape, the moving bars and the running time, in
                  the neutral text color. The bars are the input level, set per frame from the
                  recorder (no CSS animation). */}
              <span className="flex items-center gap-1 text-label" aria-hidden="true">
                <Icon icon={AppIcons.microphone} size="sm" />
                <span className="flex h-4 items-center gap-0.5">
                  {levels.map((level, index) => (
                    <span
                      key={index}
                      className="w-0.5 rounded-full bg-current"
                      style={{ height: `${Math.max(2, Math.min(16, 2 + level * 60))}px` }}
                    />
                  ))}
                </span>
              </span>
              <span className="w-8 text-right text-caption tabular-nums text-label-tertiary">
                {`${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`}
              </span>
            </>
          )}
          <IconButton size="sm" icon={AppIcons.close} label={v.cancelRecording} onClick={cancel} />
          {!transcribing && (
            <IconButton
              ref={doneRef}
              size="sm"
              variant="secondary"
              icon={AppIcons.done}
              label={v.stop}
              disabled={phase.kind !== 'recording'}
              onClick={() => void stop()}
            />
          )}
        </div>
      ) : (
        <Popover
          open={openCard !== null}
          onOpenChange={(open) => { if (!open) cardClosedForAnotherLayer(); }}
          onCloseAutoFocus={(event) => {
            settleFocusAfterCard(event);
            // The card has left the page: nothing of it stays in state.
            setHeldCard(null);
          }}
          staysOnOutsidePress
          side="top"
          align="end"
          trigger={<IconButton ref={micRef} icon={AppIcons.microphone} label={v.start} onClick={startFromMic} />}
        >
          {shownCard?.kind === 'setup' && (
            <>
              <p className="text-ui font-medium text-label">{v.setupTitle}</p>
              <p className="mt-1 text-ui-sm text-label-secondary">
                {downloading ? v.setupDownloading : format(v.setupBody, { size: sizeText })}
              </p>
              <div className="mt-3 flex justify-end gap-2">
                <Button variant="plain" size="sm" onClick={closeCard}>{v.later}</Button>
                <Button variant="primary" size="sm" autoFocus onClick={openVoiceSettings}>{v.setupGoto}</Button>
              </div>
            </>
          )}

          {shownCard?.kind === 'pending' && (
            <>
              <p className="text-ui-sm text-label-secondary">{v.pendingHint}</p>
              <p className="mt-2 line-clamp-4 text-ui text-label">{shownCard.text}</p>
              <div className="mt-3 flex justify-end gap-2">
                <Button variant="plain" size="sm" onClick={closeCard}>{v.discard}</Button>
                <Button variant="primary" size="sm" autoFocus onClick={insertHeldText}>{v.insert}</Button>
              </div>
            </>
          )}

          {shownCard?.kind === 'error' && (
            <>
              <InlineMessage tone="danger">{shownCard.message}</InlineMessage>
              <div className="mt-3 flex justify-end gap-2">
                <Button variant="plain" size="sm" onClick={closeCard}>{v.later}</Button>
                {shownCard.permission && canOpenMicSettings && (
                  <Button variant="primary" size="sm" onClick={openMicSettings}>{v.openSystemSettings}</Button>
                )}
              </div>
            </>
          )}
        </Popover>
      )}
    </div>
  );
}
