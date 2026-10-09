import { FocusScope } from 'radix-ui/internal';
import {
  useCallback, useContext, useEffect, useLayoutEffect, useRef, useState,
  type CSSProperties, type KeyboardEventHandler, type ReactNode, type Ref,
} from 'react';
import { cn } from '@/lib/utils';
import type { DataAttributes } from './dialog';
import { lastInputWasPointer } from './input-modality';
import { LayerScope } from './layer';
import { InDialogContext, useLayer, useLayerRegistry } from './layer-context';
import { firstTabbable, isTabbable, lastTabbable } from './tabbable';

// eslint-disable-next-line no-restricted-syntax -- FullscreenSurface is the in-place full-window surface (a dialog cannot portal a live iframe)
const COVER = 'fixed inset-0';
// The surface lies over its scrim. Its own box takes no pointer input and each of its children
// does, so a press beside the content reaches the scrim under it.
const SEE_THROUGH = 'pointer-events-none *:pointer-events-auto';

// Radix FocusScope keeps the keyboard inside the element it renders. The surface's element is
// already on the page with the content in it, and a new element around that content would rebuild
// it. So FocusScope renders this stand-in, which hands what FocusScope gives its element (the ref
// and the Tab handler) to the surface's own element and renders nothing.
function ScopeHost({ ref, onKeyDown, host, onScope }: {
  ref?: Ref<HTMLDivElement>;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  // Given by FocusScope for its element; the surface sets its own.
  tabIndex?: number;
  // The surface's element, on the page.
  host: HTMLDivElement;
  // Hears the Tab handler while the scope is mounted, and null when it has gone.
  onScope: (onKeyDown: KeyboardEventHandler<HTMLDivElement> | null) => void;
}) {
  const scopeRef = useRef(ref);
  useLayoutEffect(() => {
    scopeRef.current = ref;
    onScope(onKeyDown ?? null);
  });
  useLayoutEffect(() => {
    const give = (element: HTMLDivElement | null) => {
      const target = scopeRef.current;
      if (typeof target === 'function') target(element);
      else if (target) target.current = element;
    };
    give(host);
    return () => {
      give(null);
      onScope(null);
    };
  }, [host, onScope]);
  return null;
}

// The first control Tab reaches that is not a frame: a frame that has the focus keeps every key,
// Escape included.
function firstControl(surface: HTMLElement): HTMLElement | null {
  for (const element of surface.querySelectorAll<HTMLElement>('*')) {
    if (element.tagName !== 'IFRAME' && isTabbable(element, surface)) return element;
  }
  return null;
}

// The plain surface's two Tab stops, before and after its content, never seen and never pressed.
const GUARD = 'pointer-events-none fixed opacity-0 outline-none';
const isGuard = (element: Element | null) => element?.hasAttribute('data-ds-focus-guard') === true;
// A modal layer that is shown: a window, a question or an approval. A popover's box has the same
// role and is told apart by `data-ds-popover`.
const WINDOW_ON_THE_PAGE = '[data-ds-layer][data-state="open"]:is([role="dialog"], [role="alertdialog"]):not([data-ds-popover]):not([hidden])';

// The first and the last control Tab reaches in the plain surface, its own two stops aside.
function tabEnds(surface: HTMLElement): { first: HTMLElement; last: HTMLElement } | null {
  const all = surface.querySelectorAll<HTMLElement>('*');
  let first: HTMLElement | null = null;
  let last: HTMLElement | null = null;
  for (let index = 0; index < all.length && !first; index += 1) {
    if (!isGuard(all[index]) && isTabbable(all[index], surface)) first = all[index];
  }
  for (let index = all.length - 1; index >= 0 && !last; index -= 1) {
    if (!isGuard(all[index]) && isTabbable(all[index], surface)) last = all[index];
  }
  return first && last ? { first, last } : null;
}

// False while the surface or an element around it is taken off the page (a panel's tab that is
// not the one in view keeps its fullscreen state under `hidden`).
function isDisplayed(surface: HTMLElement): boolean {
  for (let node: HTMLElement | null = surface; node; node = node.parentElement) {
    if (node.hidden || getComputedStyle(node).display === 'none') return false;
  }
  return true;
}

// The notice list is drawn over the surface and is no layer: it takes no focus by itself, and a
// notice's action lasts a few seconds. Its buttons follow the surface's controls in the round Tab
// makes, so the keyboard reaches them. The first and the last control Tab reaches in the list, or
// null while it shows no notice.
function noticeEnds(): { list: HTMLElement; first: HTMLElement; last: HTMLElement } | null {
  const list = document.querySelector<HTMLElement>('[data-ds-toasts]');
  const first = list ? firstTabbable(list) : null;
  const last = list ? lastTabbable(list) : null;
  return list && first && last ? { list, first, last } : null;
}

const comesAfter = (element: Element, other: Element) => (other.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

// Tab pressed inside a frame never reaches the page. When the focus comes out of a frame at
// either end of the surface it arrives on one of the two stops, which sends it on: to the notice
// list when it shows a notice, else round to the surface's other end.
function turnRound(stop: HTMLElement, to: 'first' | 'last') {
  const surface = stop.parentElement;
  const ends = noticeEnds() ?? (surface ? tabEnds(surface) : null);
  ends?.[to].focus();
}

// Shows its content over the whole window without moving it in the page: the content's elements
// stay the very same ones when it opens and closes, so a live iframe inside it is not reloaded
// (a Dialog portals its content, which rebuilds it). Closed, its element makes no box
// (`display: contents`) and `className` / `style` do not apply.
//
// Plain form: a layout state of a panel. It sits on a level of its own (`z-fullscreen`): above
// what the page pins, the window's title-bar controls included, and under menus, dialogs, toasts
// and tooltips. The caller passes no stacking class. It moves no focus when it opens or closes,
// and Escape leaves it unless the key was pressed inside a design-system layer or something else
// has used the key (a window over the panel that closed on it, an approval that it refused).
// The page it covers cannot be seen, so Tab stays among the surface's own controls and goes
// round from the last to the first and back; pressed on the covered page, it comes in. While
// the notice list shows a notice, its buttons come after the surface's last control in that
// round and before its first. A
// design-system layer opened over the surface (a menu, a window, an approval) keeps its own
// keyboard handling, and the rest of the page is not made inert: layers are portaled there.
//
// `layer`: a dialog as far as the layer manager and the user can tell. One at a time (a dialog
// or an approval that opens replaces it, and it is turned away while an approval is on the page),
// the app hides what the page cannot paint over, the keyboard stays inside, it opens on the
// control `initialFocus` names (else its first control that is not a frame) and gives the focus
// back when it leaves. `scrim` puts the dialog scrim behind it, and a press on the scrim leaves.
// The surface covers the scrim, so with `scrim` the surface's own box lets pointer input through
// and its direct children take it: what the caller lays out as empty room around the content
// (padding, gaps) is where the scrim can be pressed. The caller adds no pointer-events classes.
//
// `onExit` must close it: the owner sets `open` to false.
export function FullscreenSurface({
  open, onExit, label, children, layer = false, scrim = false, scrimProps, initialFocus, className, style,
}: {
  open: boolean;
  onExit: () => void;
  // The accessible name of the surface while it is open.
  label: string;
  children: ReactNode;
  layer?: boolean;
  // With `layer` only.
  scrim?: boolean;
  // data-* attributes for the scrim (a test id).
  scrimProps?: DataAttributes;
  // With `layer` only. Returning null leaves the first control.
  initialFocus?: (surface: HTMLElement) => HTMLElement | null;
  className?: string;
  style?: CSSProperties;
}) {
  const registry = useLayerRegistry();
  const insideDialog = useContext(InDialogContext);
  // The surface's element: in a ref for handlers, and in state so that the focus scope mounts
  // only once the element is on the page.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [surface, setSurface] = useState<HTMLDivElement | null>(null);
  const attach = useCallback((element: HTMLDivElement | null) => {
    rootRef.current = element;
    setSurface(element);
  }, []);
  const exitRef = useRef(onExit);
  const initialFocusRef = useRef(initialFocus);
  useLayoutEffect(() => {
    exitRef.current = onExit;
    initialFocusRef.current = initialFocus;
  });

  const { id, held, admitted, returnFocus: returnFocusRef, onCloseAutoFocus } = useLayer('dialog', layer && open, (next) => { if (!next) onExit(); }, {
    isDirty: () => false,
    isBusy: () => false,
    // It has no fade: once it is closed its element is no surface any more.
    isPainted: () => rootRef.current?.hasAttribute('data-ds-layer') === true,
    confirmDiscard: () => () => undefined,
    escape: onExit,
  });
  // A layer joins the page once the manager has heard of it and does not hold it back.
  const shown = layer ? open && admitted && !held : open;
  const trapped = layer && shown;

  useEffect(() => {
    if (!shown) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      // One press of Escape leaves one thing: the repeats of a held Escape (down when the surface
      // opened, or the press that closed a layer over it) leave the surface open (heldKey.ts).
      if (event.key !== 'Escape' || event.repeat) return;
      // An Escape pressed inside a menu, a popover or a question belongs to that layer.
      const within = event.target instanceof Element ? event.target.closest('[data-ds-layer]') : null;
      if (within && within !== rootRef.current) return;
      // A layer above has used the key (it closed on it, or refused an approval), wherever the
      // focus was: one press, one thing closed.
      if (event.defaultPrevented) return;
      if (!layer) {
        exitRef.current();
        return;
      }
      event.preventDefault();
      registry.escapeTop();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [shown, layer, registry]);

  // The plain surface keeps Tab among its own controls and the notice list's. The `layer` form
  // has a focus scope.
  const guarded = shown && !layer;
  useEffect(() => {
    if (!guarded) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const element = rootRef.current;
      // A surface that is open and not displayed covers nothing: Tab is the page's.
      if (!element || !isDisplayed(element)) return;
      // Inside a menu, a popover, a window or an approval that is open over the surface, Tab is
      // that layer's.
      if (event.target instanceof Element && event.target.closest('[data-ds-layer]')) return;
      // A window, a question or an approval over the surface holds the keyboard wherever the
      // focus is (on the window itself after a press on its scrim): the surface takes no Tab
      // for a control under it.
      if (document.querySelector(WINDOW_ON_THE_PAGE)) return;
      const ends = tabEnds(element);
      const notices = noticeEnds();
      const active = document.activeElement;
      const back = event.shiftKey;
      if (notices && active && notices.list.contains(active)) {
        // Between two buttons of the list the browser moves the focus.
        const leavesTheList = back
          ? active === notices.first || comesAfter(notices.first, active)
          : active === notices.last || comesAfter(active, notices.last);
        if (!leavesTheList) return;
        event.preventDefault();
        // Back into the surface; the list alone is gone round when the surface holds no control.
        (back ? (ends ?? notices).last : (ends ?? notices).first).focus();
        return;
      }
      if (!ends) {
        event.preventDefault();
        if (notices) (back ? notices.last : notices.first).focus();
        return;
      }
      const inside = active !== null && element.contains(active) && !isGuard(active);
      const leavesAtTheEnd = active === (back ? ends.first : ends.last);
      // Between two of its own controls the browser moves the focus.
      if (inside && !leavesAtTheEnd) return;
      event.preventDefault();
      // From its last control on to the notice list; from the covered page, in.
      const next = inside && notices ? notices : ends;
      (back ? next.last : next.first).focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [guarded]);

  // The focus scope's Tab handler, called from the surface's element.
  const scopeKeyDown = useRef<KeyboardEventHandler<HTMLDivElement> | null>(null);
  const [scopeReady, setScopeReady] = useState(false);
  const onScope = useCallback((handler: KeyboardEventHandler<HTMLDivElement> | null) => {
    scopeKeyDown.current = handler;
    setScopeReady(handler !== null);
  }, []);
  // Runs after the focus scope has started to listen, so the scope knows the control the surface
  // opens on and brings the focus back to it.
  useEffect(() => {
    const element = rootRef.current;
    if (!scopeReady || !element) return;
    if (returnFocusRef.current === null) {
      returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    const target = initialFocusRef.current?.(element) ?? firstControl(element) ?? element;
    target.focus({ preventScroll: true, ...(lastInputWasPointer() ? { focusVisible: false } : {}) });
  }, [scopeReady, returnFocusRef]);
  // The surface has left the page: the manager hears it, and the focus goes back to where it was
  // unless another layer has taken it.
  const onLeft = (event: Event) => {
    onCloseAutoFocus(event);
    const element = returnFocusRef.current;
    returnFocusRef.current = null;
    if (event.defaultPrevented) return;
    event.preventDefault();
    if (element?.isConnected) element.focus();
  };

  const surfaceProps = !shown ? {} : layer
    ? { 'data-ds-layer': '', 'data-state': 'open', 'data-electron-no-drag': '', role: 'dialog', 'aria-modal': true, 'aria-label': label, tabIndex: -1 }
    : { 'data-electron-no-drag': '', role: 'group', 'aria-label': label };
  const content = layer
    ? <LayerScope id={id}><InDialogContext.Provider value={insideDialog || shown}>{children}</InDialogContext.Provider></LayerScope>
    : children;
  return (
    <>
      {trapped && scrim && (
        <div {...scrimProps} data-electron-no-drag aria-hidden="true" className={cn(COVER, 'z-dialog bg-scrim')} onClick={() => exitRef.current()} />
      )}
      <div
        ref={attach}
        {...surfaceProps}
        className={shown ? cn(COVER, layer ? 'z-dialog' : 'z-fullscreen', 'outline-none', className, trapped && scrim && SEE_THROUGH) : 'contents'}
        style={shown ? style : undefined}
        onKeyDown={(event) => scopeKeyDown.current?.(event)}
      >
        {/* Each of the three keeps its place among the children, so the content is never rebuilt. */}
        {guarded && <span tabIndex={0} data-ds-focus-guard="" className={GUARD} onFocus={(event) => turnRound(event.currentTarget, 'last')} />}
        {content}
        {guarded && <span tabIndex={0} data-ds-focus-guard="" className={GUARD} onFocus={(event) => turnRound(event.currentTarget, 'first')} />}
        {trapped && surface && (
          <FocusScope.FocusScope
            asChild
            trapped
            loop
            onMountAutoFocus={(event) => event.preventDefault()}
            onUnmountAutoFocus={onLeft}
          >
            <ScopeHost host={surface} onScope={onScope} />
          </FocusScope.FocusScope>
        )}
      </div>
    </>
  );
}
