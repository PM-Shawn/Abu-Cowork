import { AlertDialog as AlertDialogPrimitive, Dialog as DialogPrimitive, VisuallyHidden } from 'radix-ui';
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { isMacOS } from '@/utils/platform';
import { Button, IconButton } from './button';
import { dropsHeldEscape, useHeldKeys } from './heldKey';
import { AppIcons } from './icons';
import { lastInputWasPointer } from './input-modality';
import { LayerScope } from './layer';
import { InDialogContext, useLayer, useLayerContainer, useLayerRegistry, useOpenState } from './layer-context';
import { DIALOG_BOX, DIALOG_CLOSING, DIALOG_MOTION, DIALOG_PAGE, DIALOG_VIEWER, FOCUS_RING, SCRIM_MOTION, SETTLING_BOX, TOAST_SETTLE_MS } from './styles';
import { firstTabbable, lastTabbable } from './tabbable';

const WIDTH = { sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-2xl', xl: 'max-w-3xl' } as const;
interface PendingDiscard { onDiscard: () => void; onKeep?: () => void }
// Hooks for tests and for the window-drag guard; nothing else reaches the dialog box.
export type DataAttributes = { [key: `data-${string}`]: string | undefined };
// `top` keeps the top edge still while the content grows or shrinks (search as you type).
// Its height limit counts from that edge, so the dialog still ends 48px above the window's bottom.
const PLACEMENT = { center: '', top: 'top-1/7 translate-y-0 max-h-[calc(100dvh*6/7-3rem)]' } as const;

// True when the dialog has a close button and nothing else the Tab key can reach. Every element
// is asked the way Radix asks when it looks for the first focus target, so an editable box, a
// summary, a frame or a media player counts as a control like a button does.
// A description that scrolls is a Tab stop and no control.
function hasOnlyCloseButton(content: HTMLElement, description: Element | null): boolean {
  const close = content.querySelector('[data-ds-dialog-close]');
  if (!close) return false;
  return Array.from(content.querySelectorAll<HTMLElement>('*')).every((element) => {
    if (close.contains(element) || element === description) return true;
    const hiddenInput = element instanceof HTMLInputElement && element.type === 'hidden';
    if ((element as HTMLElement & { disabled?: boolean }).disabled || element.hidden || hiddenInput) return true;
    return !(element.tabIndex >= 0);
  });
}

// Tab pressed while focus is on the dialog box itself (after a press on an empty part of it, or
// in a dialog that opened with focus on its box): the first control, or the last with Shift.
function tabFromBox(event: { key: string; shiftKey: boolean; target: EventTarget; currentTarget: HTMLElement; preventDefault: () => void }) {
  if (event.key !== 'Tab' || event.target !== event.currentTarget) return;
  const next = event.shiftKey ? lastTabbable(event.currentTarget) : firstTabbable(event.currentTarget);
  if (!next) return;
  event.preventDefault();
  next.focus();
}

// After a pointer press, the control a layer opens on gets focus without its ring; after a key
// press the default stands (Radix focuses it and the ring shows).
function focusQuietlyAfterPointer(event: Event, pick: (content: HTMLElement) => HTMLElement | null) {
  const content = event.currentTarget;
  if (!lastInputWasPointer() || !(content instanceof HTMLElement)) return;
  const target = pick(content);
  if (!target) return;
  event.preventDefault();
  target.focus({ preventScroll: true, focusVisible: false });
  if (target instanceof HTMLInputElement) target.select();
}

// A layer that appears by itself, or whose answering button sits where the button just pressed
// was, takes no pointer press that began before it could be read: an approval, a question, and a
// window's question about unsaved input. A press on its way to what was at that spot a moment ago
// (the window of the request before, a question's confirming button, the button that asked) would
// land on a button of this layer.
//
// The box holds presses back for TOAST_SETTLE_MS, counted from the moment it is on the page (for
// an approval that is when the layer registry lets it show, not when the request was made), and
// again whenever it can be pressed again or its buttons have changed their meaning: `restart`.
// While something keeps it from being pressed at all (another layer over it, standing aside) it
// is held with no end: `hold(reason)`, until `free(reason)` starts the count. A reason that was
// not set starts nothing, so the count begins again only on a real change.
//
// The start of a press counts: one that began early was aimed at what was there before, wherever
// and whenever it ends. Such a press starts nothing in the box, does not move the focus (it stays
// on the cancelling button the layer opened on) and its click reaches no control. The keyboard is
// never held: a click raised by Enter or Space reports detail 0, and the focus says which button
// is meant. It is a guard, not a state: nothing looks disabled.
//
// The box carries `data-ds-settling` for as long as it holds presses back. The mark and the
// presses are judged by one clock (`performance.now()`, time that only moves forward), so the mark
// is gone exactly when a press is taken; tests and E2E wait for it.
function useSettling(settles: boolean) {
  const box = useRef<HTMLElement | null>(null);
  // Not on the page: nothing to press.
  const heldUntil = useRef(Number.POSITIVE_INFINITY);
  const reasons = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressBeganEarly = useRef(false);
  return useMemo(() => {
    const stop = () => {
      if (timer.current === null) return;
      clearTimeout(timer.current);
      timer.current = null;
    };
    // A timer can run a few milliseconds early: the mark stays for the rest.
    const look = () => {
      timer.current = null;
      const rest = heldUntil.current - performance.now();
      if (rest > 0) {
        if (Number.isFinite(rest)) timer.current = setTimeout(look, Math.ceil(rest));
        return;
      }
      box.current?.removeAttribute('data-ds-settling');
    };
    const count = () => {
      stop();
      const node = box.current;
      if (!node) return;
      node.setAttribute('data-ds-settling', '');
      if (reasons.current.size > 0) {
        heldUntil.current = Number.POSITIVE_INFINITY;
        return;
      }
      heldUntil.current = performance.now() + TOAST_SETTLE_MS;
      timer.current = setTimeout(look, TOAST_SETTLE_MS);
    };
    const tooEarly = () => performance.now() < heldUntil.current;
    // Events of a layer opened inside this one (a portal) pass through React's tree here too:
    // they are that layer's, not this box's.
    const inBox = (event: MouseEvent<HTMLElement>) => event.target instanceof Node && event.currentTarget.contains(event.target);
    // The style of a settling box keeps the pointer off everything inside it, so an early press
    // lands on the box. One that reaches a control anyway goes no further.
    const onControl = (event: MouseEvent<HTMLElement>) => event.target !== event.currentTarget;
    const handlers = {
      onPointerDownCapture: (event: PointerEvent<HTMLElement>) => {
        if (!inBox(event)) return;
        pressBeganEarly.current = tooEarly();
        if (pressBeganEarly.current && onControl(event)) event.stopPropagation();
      },
      onMouseDownCapture: (event: MouseEvent<HTMLElement>) => {
        if (!inBox(event) || !(pressBeganEarly.current || tooEarly())) return;
        // A mouse-down moves the focus to what it lands on unless it is told not to.
        event.preventDefault();
        if (onControl(event)) event.stopPropagation();
      },
      onClickCapture: (event: MouseEvent<HTMLElement>) => {
        if (!inBox(event)) return;
        const early = pressBeganEarly.current;
        pressBeganEarly.current = false;
        if (event.detail === 0 || !(early || tooEarly())) return;
        event.preventDefault();
        event.stopPropagation();
      },
    };
    return {
      // The box joined the page. Radix gives its content a new ref callback with every render, so
      // this hears the same box again and again, and `null` in between: only a new box counts.
      attach: (node: HTMLElement | null) => {
        if (!node || node === box.current) return;
        box.current = node;
        if (settles) count();
      },
      // The box left the page (<WhenGone> inside it says so).
      detach: () => {
        box.current = null;
        stop();
        heldUntil.current = Number.POSITIVE_INFINITY;
        pressBeganEarly.current = false;
      },
      restart: () => { if (settles) count(); },
      hold: (reason: string) => {
        if (!settles) return;
        reasons.current.add(reason);
        count();
      },
      free: (reason: string) => { if (reasons.current.delete(reason) && settles) count(); },
      handlers: settles ? handlers : {},
    };
  }, [settles]);
}

// Rendered inside a box: runs `run` when the box leaves the page.
function WhenGone({ run }: { run: () => void }) {
  useLayoutEffect(() => run, [run]);
  return null;
}

export function DialogClose(props: ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close {...props} />;
}

// An approval decides whether Abu does something. The layer registry never closes one, shows
// one at a time, and `urgent` puts one at the front of those that wait their turn; a plain
// dialog has no such line, so it takes no `urgent`.
type DialogLayer = { layer?: 'dialog'; urgent?: never } | { layer: 'approval'; urgent?: boolean };

// One dialog at a time (LayerProvider). Escape, the scrim, the close button and DialogClose
// all close it, except while `dirty`: then the user is asked whether to discard what they typed.
// With `dismissible={false}` only the dialog's own buttons and DialogClose close it.
// Content taller than the window scrolls inside the dialog; the title, the header and the footer stay put.
export function Dialog({
  title, description, header, children, footer, trigger, open, defaultOpen = false, onOpenChange,
  dirty = false, busy = false, size = 'md', placement = 'center', role = 'dialog', titleHidden = false,
  closeButton: closeButtonAsked = false, dismissible = true, outsidePress = 'close', contentProps,
  onCloseAutoFocus: callerCloseAutoFocus, onFocusUnplaced, initialFocus, layer = 'dialog', urgent = false, settleKey,
}: DialogLayer & {
  title: ReactNode;
  // Keeps the title as the accessible name without showing it.
  titleHidden?: boolean;
  description?: ReactNode;
  // Stays put above the scrolling content: the name row of a detail window.
  header?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  trigger?: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  dirty?: boolean;
  // Closing the dialog now would cancel work it has in flight (a sign-in round trip, an install,
  // a save). When an approval arrives it steps aside, untouched, and comes back afterwards.
  busy?: boolean;
  // `page` is the settings window: it fills a fixed box and its content does its own scrolling.
  // `viewer` fills the window up to a 24px margin and gives its whole box to the content.
  size?: keyof typeof WIDTH | 'page' | 'viewer';
  placement?: keyof typeof PLACEMENT;
  role?: 'dialog' | 'alertdialog';
  // A close button in the top right corner; data attributes given here go on that button.
  closeButton?: boolean | DataAttributes;
  // false: only the dialog's own buttons (and DialogClose) close it. Escape and a press outside
  // do nothing and there is no close button; the scrim still blocks the window behind it. For a
  // one-time question that a stray key or click must not skip. The layer registry can still
  // close it: when the dialog it was asked over goes away, or another dialog takes its place.
  dismissible?: boolean;
  // `ignore`: a press outside the dialog does nothing; Escape and the close button still close it.
  outsidePress?: 'close' | 'ignore';
  contentProps?: DataAttributes;
  // Runs after the layer's own handler once the dialog has gone; call event.preventDefault()
  // there to put focus somewhere other than where it was before the dialog opened. When
  // event.defaultPrevented is already true, another dialog has taken the focus: leave it alone.
  onCloseAutoFocus?: (event: Event) => void;
  // Runs once the dialog has gone and the focus is its to give back, but the place it would
  // return to is no control on the page: nothing had the focus when the dialog appeared, or that
  // control has left since. The owner names where the focus goes; without it the focus stays on
  // the window. Not called when the registry, the caller's `onCloseAutoFocus` or a trigger has
  // placed the focus.
  onFocusUnplaced?: () => void;
  // The control the dialog opens on, when that is not its first one (the current page of a
  // window with navigation). Returning null leaves the first control.
  initialFocus?: (content: HTMLElement) => HTMLElement | null;
  // For an approval or a question whose buttons change their meaning inside one window (the
  // allowing button turns into the one that grants for good): when this value changes, the window
  // holds pointer presses back again, as it did when it appeared (see useSettling).
  settleKey?: unknown;
}) {
  const { t } = useI18n();
  const container = useLayerContainer();
  const [isOpen, setOpen] = useOpenState(open, defaultOpen, onOpenChange);
  // The discard question that is on screen. The ref is what the handlers read: Discard and
  // the question's own close arrive in one event, and only the first of them may answer.
  const [discardAsked, setDiscardAsked] = useState(false);
  const pendingDiscard = useRef<PendingDiscard | null>(null);
  const dirtyRef = useRef(dirty);
  const busyRef = useRef(busy);
  useLayoutEffect(() => {
    dirtyRef.current = dirty;
    busyRef.current = busy;
  });

  const takePendingDiscard = () => {
    const pending = pendingDiscard.current;
    pendingDiscard.current = null;
    setDiscardAsked(false);
    return pending;
  };
  // Returns a function that takes this question back without answering it.
  const askToDiscard = (onDiscard: () => void, onKeep?: () => void) => {
    const pending = { onDiscard, onKeep };
    pendingDiscard.current = pending;
    setDiscardAsked(true);
    return () => { if (pendingDiscard.current === pending) takePendingDiscard(); };
  };
  const requestClose = () => {
    if (dirtyRef.current) askToDiscard(() => setOpen(false));
    else setOpen(false);
  };
  // The question stays on the page while it fades out: a later activation finds nothing pending.
  const discard = () => { takePendingDiscard()?.onDiscard(); };
  // Keep editing, Escape, or anything else that closes the question without discarding.
  const keep = () => { takePendingDiscard()?.onKeep?.(); };

  const registry = useLayerRegistry();
  const kind = layer === 'approval' ? 'approval' : role === 'alertdialog' ? 'alert' : 'dialog';
  const contentRef = useRef<HTMLDivElement | null>(null);
  // A description taller than its box scrolls. The keyboard has to reach it to scroll it (a long
  // address in a question is read whole before it is answered), so it is then a Tab stop named
  // after the dialog's title; one that fits adds no stop. Holds the title's id while it scrolls.
  const descriptionRef = useRef<HTMLParagraphElement | null>(null);
  const [scrollingDescriptionName, setScrollingDescriptionName] = useState<string | null>(null);
  const measureDescription = useCallback(() => {
    const box = descriptionRef.current;
    const scrolls = box !== null && box.scrollHeight > box.clientHeight;
    setScrollingDescriptionName(scrolls ? box.closest('[data-ds-layer]')?.getAttribute('aria-labelledby') ?? '' : null);
  }, []);
  // Measured when the description joins the page (the portal draws it after this component has
  // rendered) and after every render that may have changed its words.
  const holdDescription = useCallback((box: HTMLParagraphElement | null) => {
    descriptionRef.current = box;
    measureDescription();
  }, [measureDescription]);
  useLayoutEffect(measureDescription);
  // An approval and a question hold pointer presses back when they appear; an ordinary window,
  // which the user opened and whose buttons are new to the spot, does not. The window's own
  // question about unsaved input always does.
  const settling = useSettling(kind !== 'dialog');
  const questionSettling = useSettling(true);
  // A key that was down before the window could be used does nothing in it until it is pressed
  // again: the Enter that opened it, a key held while an approval arrives (the focus is on its
  // cancelling button, which the browser would press for every repeat), the key that answered the
  // layer before. Every kind of window, and its question about unsaved input, which share one
  // mark. Marked wherever the settle interval starts, and when the question is answered: the
  // window is in use again. Keys pressed inside repeat as their controls define (heldKey.ts).
  // Escape is not among them: its repeats are dropped whenever the key went down, where Radix
  // asks the window about the key (`onEscapeKeyDown` below, through the layer's handler).
  const heldKeys = useHeldKeys();
  const {
    id, onCloseAutoFocus, held, aside, admitted, returnFocus: returnTo, onEscapeKeyDown: passEscapeWhileClosing,
  } = useLayer(kind, isOpen, setOpen, {
    isDirty: () => dirtyRef.current,
    isBusy: () => busyRef.current,
    // The box is on the page until its fade has ended. One that stepped aside is hidden: not painted.
    isPainted: () => contentRef.current?.isConnected === true && !contentRef.current.hidden,
    confirmDiscard: askToDiscard,
    escape: () => { if (dismissible) requestClose(); },
    // The layer registry says when a question or a window is over an approval, and when the last
    // of them has left the page.
    onCovered: () => settling.hold('covered'),
    onUncovered: () => {
      settling.free('covered');
      heldKeys.mark();
    },
  }, urgent);
  const holdContent = useCallback((node: HTMLDivElement | null) => {
    contentRef.current = node;
    settling.attach(node);
  }, [settling]);
  // On the page again in the box it had: closed and opened again inside its own fade.
  const onPage = isOpen && admitted && (!held || aside);
  useLayoutEffect(() => {
    if (!onPage) return;
    settling.restart();
    heldKeys.mark();
  }, [onPage, settling, heldKeys]);
  // Off the page for an approval, hidden; back when no approval is left, at the spot where the
  // approval's buttons were.
  useLayoutEffect(() => {
    if (aside) {
      settling.hold('aside');
      questionSettling.hold('aside');
      return;
    }
    settling.free('aside');
    questionSettling.free('aside');
    heldKeys.mark();
  }, [aside, settling, questionSettling, heldKeys]);
  // Under its own question about unsaved input, and when that question has been answered.
  useLayoutEffect(() => {
    heldKeys.mark();
    if (discardAsked) {
      settling.hold('question');
      // Asked again while the question before still fades: the same box.
      questionSettling.restart();
      return;
    }
    settling.free('question');
  }, [discardAsked, settling, questionSettling, heldKeys]);
  const lastSettleKey = useRef(settleKey);
  useLayoutEffect(() => {
    if (Object.is(lastSettleKey.current, settleKey)) return;
    lastSettleKey.current = settleKey;
    settling.restart();
    heldKeys.mark();
  }, [settleKey, settling, heldKeys]);

  // A dialog that steps aside for an approval stays mounted and hidden: Radix still has it open,
  // under the approval, which is the top layer for Escape, presses and the focus trap. When it
  // returns nothing mounts, so no focus moves by itself: it goes back to the control that had it,
  // or to the dialog's first control when focus would otherwise be left on a layer that is leaving.
  // The dialog's own discard question is hidden with it and returns with it, unanswered.
  const questionRef = useRef<HTMLDivElement | null>(null);
  const holdQuestion = useCallback((node: HTMLDivElement | null) => {
    questionRef.current = node;
    questionSettling.attach(node);
  }, [questionSettling]);
  const focusedInside = useRef<HTMLElement | null>(null);
  const wasAside = useRef(false);
  const initialFocusRef = useRef(initialFocus);
  useLayoutEffect(() => { initialFocusRef.current = initialFocus; });
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (aside) {
      wasAside.current = true;
      const active = document.activeElement;
      const inside = active instanceof HTMLElement && (content?.contains(active) || questionRef.current?.contains(active));
      focusedInside.current = inside ? active : null;
      return;
    }
    if (!wasAside.current) return;
    wasAside.current = false;
    const kept = focusedInside.current;
    focusedInside.current = null;
    if (!content) return;
    const quiet = { preventScroll: true, ...(lastInputWasPointer() ? { focusVisible: false } : {}) };
    const opening = () => (initialFocusRef.current?.(content) ?? firstTabbable(content, true, descriptionRef.current) ?? content).focus(quiet);
    // After a group has returned the focus is inside its top layer.
    // A question is that top layer, whatever returned with it, and it returns the way it opened,
    // on the control it names: the approval took the focus by itself, and a key still being
    // pressed for it must not land on the answer the user had moved to, nor in the window below.
    if (kind === 'alert') {
      opening();
      return;
    }
    // A question on the page is over this window (its own discard question, or one that was
    // asked over it and returns with it): the focus is the question's.
    const question = Array.from(document.querySelectorAll<HTMLElement>('[data-ds-layer][role="alertdialog"][data-state="open"]:not([hidden])'))
      .find((layer) => layer !== content);
    // A window returns to the control that had the focus (the field being typed in).
    if (kept?.isConnected && (!question || question.contains(kept))) {
      kept.focus(quiet);
      return;
    }
    if (question) return;
    // Another layer that is on the page has the focus (a dialog opened inside this one).
    if (document.activeElement?.closest('[data-ds-layer][data-state="open"]:not([hidden])')) return;
    opening();
  }, [aside, kind]);
  // The discard question is on the page (not while it is hidden with a dialog that stepped aside).
  const discardShown = discardAsked && !aside;
  useLayoutEffect(() => {
    if (!discardShown) return;
    registry.discardQuestion(id, true);
    return () => registry.discardQuestion(id, false);
  }, [discardShown, id, registry]);
  // The owner closed the dialog while the discard question was on screen (a save that was in
  // flight landed): nothing is left to discard, so the question goes unanswered.
  useLayoutEffect(() => {
    if (isOpen || !pendingDiscard.current) return;
    pendingDiscard.current = null;
    setDiscardAsked(false);
  }, [isOpen]);

  // Radix gives focus back only to a Dialog.Trigger. A dialog opened by code (search,
  // useConfirm(), the discard question) has none, so it would leave focus on the page
  // body; these give focus back to whatever had it when the dialog opened. A dialog that comes
  // back after it stepped aside keeps the element of its first opening, and an approval keeps
  // the one the layer registry gave it.
  const discardReturnTo = useRef<HTMLElement | null>(null);
  const remember = (target: { current: HTMLElement | null }) => {
    if (target.current !== null) return;
    target.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  };
  const giveFocusBack = (target: { current: HTMLElement | null }, event: Event, hasTrigger: boolean, unplaced?: () => void) => {
    const element = target.current;
    target.current = null;
    // A caller or the layer registry that already chose where focus goes keeps its choice.
    if (event.defaultPrevented || hasTrigger) return;
    event.preventDefault();
    // The page body is what the browser reports when no control has the focus.
    if (element?.isConnected && element !== element.ownerDocument.body) element.focus();
    else unplaced?.();
  };

  const closeButton = dismissible && closeButtonAsked;
  // Radix asks before it dismisses; a prevented event leaves the dialog open.
  const stay = dismissible ? undefined : (event: Event) => event.preventDefault();
  const page = size === 'page';
  const viewer = size === 'viewer';
  const box = page
    ? cn(DIALOG_PAGE, isMacOS() ? 'top-12' : 'top-6')
    : viewer ? DIALOG_VIEWER : cn(DIALOG_BOX, WIDTH[size], PLACEMENT[placement]);

  return (
    <>
      {/* Mounted once the layer registry has heard of this opening and does not hold it back: a
          dialog held before it was shown is open as far as its owner knows, and not on the page.
          One that stepped aside stays mounted, hidden. */}
      <DialogPrimitive.Root open={isOpen && admitted && (!held || aside)} onOpenChange={(next) => (next ? setOpen(true) : requestClose())}>
        {trigger && <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger>}
        <DialogPrimitive.Portal container={container}>
          {/* eslint-disable-next-line no-restricted-syntax -- Dialog owns the app's only scrim */}
          <DialogPrimitive.Overlay hidden={aside} data-ds-motion data-electron-no-drag className={cn('fixed inset-0 z-dialog bg-scrim', SCRIM_MOTION)} />
          <DialogPrimitive.Content
            {...contentProps}
            {...settling.handlers}
            {...heldKeys.handlers}
            ref={holdContent}
            hidden={aside}
            data-ds-layer
            data-ds-motion
            data-electron-no-drag
            role={role}
            onEscapeKeyDown={(event) => { passEscapeWhileClosing(event); stay?.(event); }}
            onInteractOutside={(event) => {
              // A press on a notification (its Close, an action such as Undo) is not a press outside
              // the dialog: the notification list is drawn over every dialog and is no part of the page behind.
              const onNotification = event.target instanceof Element && event.target.closest('[data-ds-toasts]') !== null;
              if (!dismissible || outsidePress === 'ignore' || onNotification) event.preventDefault();
            }}
            onKeyDown={tabFromBox}
            onOpenAutoFocus={(event) => {
              remember(returnTo);
              const content = event.currentTarget;
              if (!(content instanceof HTMLElement)) return;
              // The close button is the only control (an enlarged image): focus goes to the box.
              // On the button it would show the button's tooltip the moment the dialog opens.
              // Tab still reaches the button.
              if (hasOnlyCloseButton(content, descriptionRef.current)) {
                event.preventDefault();
                content.focus();
                return;
              }
              const named = initialFocus?.(content) ?? null;
              if (named) {
                event.preventDefault();
                named.focus({ preventScroll: true, ...(lastInputWasPointer() ? { focusVisible: false } : {}) });
                return;
              }
              // A description that scrolls is the first Tab stop in the box: the dialog opens on
              // the control after it (the cancelling button of a question), never on the text.
              const description = descriptionRef.current;
              if (description && firstTabbable(content, true) === description) {
                event.preventDefault();
                (firstTabbable(content, true, description) ?? content).focus({ preventScroll: true, ...(lastInputWasPointer() ? { focusVisible: false } : {}) });
                return;
              }
              // Radix's own choice, links aside as it does.
              focusQuietlyAfterPointer(event, (box) => firstTabbable(box, true));
            }}
            onCloseAutoFocus={(event) => {
              // The layer's handler first: it prevents the default when the registry
              // closed this dialog to make room for another. Then the caller's choice.
              onCloseAutoFocus(event);
              callerCloseAutoFocus?.(event);
              giveFocusBack(returnTo, event, trigger !== undefined, onFocusUnplaced);
            }}
            {...(description ? {} : { 'aria-describedby': undefined })}
            className={cn(box, DIALOG_MOTION, DIALOG_CLOSING, SETTLING_BOX)}
          >
            <WhenGone run={settling.detach} />
            <LayerScope id={id}>
              <InDialogContext.Provider value>
                {titleHidden ? (
                  // Still the dialog's accessible name, for a dialog whose content says what it is (search).
                  <VisuallyHidden.Root asChild>
                    <DialogPrimitive.Title>{title}</DialogPrimitive.Title>
                  </VisuallyHidden.Root>
                ) : (
                  // With a close button the title stops short of the corner the button sits in.
                  <DialogPrimitive.Title className={cn('text-title text-label', closeButton && 'pr-8')}>{title}</DialogPrimitive.Title>
                )}
                {description && (
                  // A line break in the words is kept: a question names what it acts on on a line of its own.
                  // Words longer than the dialog (a path, an address) break, and many lines scroll.
                  <DialogPrimitive.Description
                    ref={holdDescription}
                    {...(scrollingDescriptionName === null ? {} : { tabIndex: 0, role: 'group', 'aria-labelledby': scrollingDescriptionName })}
                    className={cn('mt-1 max-h-60 overflow-y-auto whitespace-pre-line break-words text-ui text-label-secondary', scrollingDescriptionName !== null && cn('rounded-control', FOCUS_RING))}
                  >
                    {description}
                  </DialogPrimitive.Description>
                )}
                {/* With a hidden title the header is the top row: it stops short of the close button's corner. */}
                {header && <div className={cn('shrink-0', !titleHidden && 'mt-4', titleHidden && closeButton && 'pr-8')}>{header}</div>}
                {children && (page ? (
                  <div className="min-h-0 flex-1 text-ui text-label">{children}</div>
                ) : viewer ? (
                  <div className="flex min-h-0 flex-1 flex-col text-ui text-label">{children}</div>
                ) : (
                  <div className={cn('flex min-h-0 flex-col', (!titleHidden || header) && 'mt-4')}>
                    {/* The 4px of padding keeps focus rings from being cut off by the scroll box. */}
                    <div className="-m-1 min-h-0 overflow-y-auto p-1 text-ui text-label">{children}</div>
                  </div>
                ))}
                {footer && <div className="mt-6 flex shrink-0 justify-end gap-2">{footer}</div>}
                {/* Last in the content, so the dialog opens with focus on its first control. */}
                {closeButton && (
                  <span data-ds-dialog-close className="absolute right-3 top-3 flex">
                    <DialogPrimitive.Close asChild>
                      <IconButton icon={AppIcons.close} label={t.common.close} {...(closeButton === true ? {} : closeButton)} />
                    </DialogPrimitive.Close>
                  </span>
                )}
              </InDialogContext.Provider>
            </LayerScope>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
      <AlertDialogPrimitive.Root open={discardAsked} onOpenChange={(next) => { if (!next) keep(); }}>
        <AlertDialogPrimitive.Portal container={container}>
          <AlertDialogPrimitive.Content
            {...questionSettling.handlers}
            {...heldKeys.handlers}
            ref={holdQuestion}
            hidden={aside}
            data-ds-layer
            data-ds-motion
            data-electron-no-drag
            // One press of Escape asks, the next one takes the question back: the repeats of the
            // press that asked leave it on the page (heldKey.ts). While the question fades out the
            // key goes to the top open layer, as for any closing layer.
            onEscapeKeyDown={(event) => {
              if (dropsHeldEscape(event) || discardAsked) return;
              event.preventDefault();
              registry.escapeTop();
            }}
            onOpenAutoFocus={(event) => {
              remember(discardReturnTo);
              // The first button is the one that keeps editing, which Radix focuses too.
              focusQuietlyAfterPointer(event, (box) => firstTabbable(box));
            }}
            onCloseAutoFocus={(event) => {
              // Discarded: the dialog is leaving too. Its own fade decides where focus goes; a
              // control of a dialog that is closing is no place to send it.
              if (!isOpen) event.preventDefault();
              giveFocusBack(discardReturnTo, event, false);
            }}
            className={cn(DIALOG_BOX, WIDTH.sm, DIALOG_MOTION, DIALOG_CLOSING, SETTLING_BOX)}
          >
            <WhenGone run={questionSettling.detach} />
            <AlertDialogPrimitive.Title className="text-title text-label">{t.designSystem.discardTitle}</AlertDialogPrimitive.Title>
            <AlertDialogPrimitive.Description className="mt-1 text-ui text-label-secondary">
              {t.designSystem.discardMessage}
            </AlertDialogPrimitive.Description>
            <div className="mt-6 flex justify-end gap-2">
              <AlertDialogPrimitive.Cancel asChild>
                <Button variant="secondary">{t.designSystem.keepEditing}</Button>
              </AlertDialogPrimitive.Cancel>
              <AlertDialogPrimitive.Action asChild>
                <Button variant="danger" onClick={discard}>{t.designSystem.discard}</Button>
              </AlertDialogPrimitive.Action>
            </div>
          </AlertDialogPrimitive.Content>
        </AlertDialogPrimitive.Portal>
      </AlertDialogPrimitive.Root>
    </>
  );
}
