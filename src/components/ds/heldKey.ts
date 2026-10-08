import { useLayoutEffect, useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';

// A key that is held down repeats. The browser makes a click from every Enter key-down on a
// button that is not default-prevented, and from the key-up of a Space that went down on it, so a
// key still down when the focus is handed to another control, or when a layer appears with the
// focus on one of its buttons, would press what the user has not read.
//
// Three rules, all about repeats only (`event.repeat`). The first press of a key always acts.
//   - A control that acts at once (a button, a switch, a link) acts once per press of Enter or
//     Space: `dropsHeldRepeat`, `oncePerPress`. A text field drops a repeating Enter only:
//     `dropsHeldEnter`.
//   - A layer drops the repeats of a key that was already down when the layer was shown:
//     `useHeldKeys`. Such a key, of whatever kind, does nothing in the layer until it is released
//     and pressed again. Keys pressed inside the layer repeat as its controls define (arrows in a
//     list, Tab, Backspace in a field).
//   - A layer acts once per press of Escape: `dropsHeldEscape`. An Escape still down when an
//     approval arrives would refuse it unread, and one that has closed a layer would go on to
//     close the layer under it.

interface HeldKeyEvent {
  key: string;
  code: string;
  repeat: boolean;
  preventDefault: () => void;
}

interface TextKeyEvent extends HeldKeyEvent {
  keyCode: number;
  nativeEvent: { isComposing: boolean };
}

// A key is known by its place on the keyboard: under an input method the key-down says
// `Process`, and a Shift released first changes what the key-up says. An event that names no
// place (assistive technology) is known by what it types.
const codeOf = (event: { key: string; code: string }) => event.code || event.key;

// The key press is the user talking to an input method (see chat/composerKeys.ts).
const composing = (event: TextKeyEvent) => event.nativeEvent.isComposing || event.keyCode === 229;

const activates = (event: HeldKeyEvent) => event.key === 'Enter' || event.key === ' '
  || event.code === 'Enter' || event.code === 'NumpadEnter' || event.code === 'Space';

// For the key-down of a control that acts at once. True when the event was the repeat of a held
// Enter or Space: its default is prevented, so the browser makes no click from it.
export function dropsHeldRepeat(event: HeldKeyEvent): boolean {
  if (!event.repeat || !activates(event)) return false;
  event.preventDefault();
  return true;
}

// For the key-down of a one-line text field: a repeating Enter submits nothing a second time.
// Every other key repeats (Space types spaces, Backspace deletes), and a key that belongs to an
// input method is left alone.
export function dropsHeldEnter(event: TextKeyEvent): boolean {
  if (!event.repeat || event.key !== 'Enter' || composing(event)) return false;
  event.preventDefault();
  return true;
}

// For whatever acts on Escape: a layer's `onEscapeKeyDown` (Radix hears the key on the document,
// before any handler on the layer's content, and asks the top layer there), and a listener of its
// own. True when the event was the repeat of a held Escape: its default is prevented, which is
// what tells Radix, and every listener after it, that the key is used up. So the Escape that was
// down when a layer appeared, was uncovered or came back does nothing to it, and the Escape that
// closed one layer does not go on to the next: one press, one thing closed, refused or asked.
// It reads `repeat` alone and keeps nothing, so it also holds for an Escape whose first press the
// page never heard, and no lost key-up can leave Escape without effect: a new press is no repeat.
export function dropsHeldEscape(event: { repeat: boolean; preventDefault: () => void }): boolean {
  if (!event.repeat) return false;
  event.preventDefault();
  return true;
}

// The key-down handler of a control that acts at once: the caller's handler hears every key but
// the dropped repeats.
export function oncePerPress<E extends HeldKeyEvent>(handler?: (event: E) => void): (event: E) => void {
  return (event) => {
    if (dropsHeldRepeat(event)) return;
    handler?.(event);
  };
}

// The keys that are down, as far as this page heard them go down: code → the number of that
// press among all presses (later presses have higher numbers). A key leaves at its key-up. All
// leave when the window loses the focus or the page is hidden: the key-up of a key released
// elsewhere never arrives, and a key that goes down elsewhere (another application, a frame, a
// native view) is never heard. A repeat is no press: a key whose first key-down was not heard is
// not in here.
export const keysDown = new Map<string, number>();
let presses = 0;
let users = 0;

function onKeyDown(event: KeyboardEvent) {
  if (event.repeat) return;
  presses += 1;
  keysDown.set(codeOf(event), presses);
}
function onKeyUp(event: KeyboardEvent) {
  keysDown.delete(codeOf(event));
}
// Focus moving between two elements raises `blur` on the element; only the window's own counts.
function onWindowBlur(event: Event) {
  if (event.target === event.currentTarget) keysDown.clear();
}
function onVisibilityChange() {
  if (document.visibilityState === 'hidden') keysDown.clear();
}

// Listens on the document; returns the function that stops listening (LayerProvider calls it).
export function trackKeysDown(): () => void {
  if (users === 0) {
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('keyup', onKeyUp, true);
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('blur', onWindowBlur);
  }
  users += 1;
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    users -= 1;
    if (users > 0) return;
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('keyup', onKeyUp, true);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('blur', onWindowBlur);
    keysDown.clear();
  };
}

// For a layer. `mark()` is called at the moment the layer is shown — by itself each time `shown`
// turns true — and again whenever the layer can be used again (it is uncovered, it returns after
// standing aside, its buttons changed their meaning). `handlers` go on the layer's content: the
// repeat of a key that was down at the last mark is dropped, and goes no further. So the key that
// opened the layer, and a key that was down when the layer appeared by itself, do nothing in it
// until they are pressed again. Nothing stays dropped for good: a new press is never a repeat,
// and it counts as pressed after the mark even when the key-up before it was never heard. Before
// the first mark the repeat of every key that is down is dropped.
//
// A key the page does not know to be down is left alone: the page cannot tell whether it was
// held before the layer. That is a key that went down where the page hears nothing (a frame, a
// native view, another window), and every key after the window lost the focus. Enter and Space
// are still dropped by the controls themselves and by the lists below.
//
// Escape is left alone here: Radix handles it on the document before these handlers run. Its
// repeats are dropped where the layer hears of the key (`dropsHeldEscape`).
//
// `chooses`: the layer is a list whose rows act on the key-down of these keys (a menu and a
// select list choose on Enter and Space, a list with a search box on Enter). Their repeats are
// dropped whenever the key went down, so one press chooses once: a row that is leaving with its
// list, or that stays (a multiple choice), is not chosen again by the same press.
export function useHeldKeys(shown = false, chooses: 'nothing' | 'enter' | 'enter-space' = 'nothing') {
  const shownAt = useRef(Number.POSITIVE_INFINITY);
  const held = useMemo(() => ({
    mark: () => { shownAt.current = presses; },
    handlers: {
      onKeyDownCapture: (event: ReactKeyboardEvent<HTMLElement>) => {
        if (!event.repeat || event.key === 'Escape' || composing(event)) return;
        const choosing = chooses !== 'nothing' && activates(event) && (chooses === 'enter-space' || event.key === 'Enter');
        const pressed = keysDown.get(codeOf(event));
        // Not known to be down, or pressed since the mark: the layer's own key.
        if (!choosing && (pressed === undefined || pressed > shownAt.current)) return;
        event.preventDefault();
        event.stopPropagation();
      },
    },
  }), [chooses]);
  useLayoutEffect(() => {
    if (shown) held.mark();
  }, [shown, held]);
  return held;
}
