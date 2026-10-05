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
import { isTabbable } from './tabbable';

// eslint-disable-next-line no-restricted-syntax -- FullscreenSurface is the in-place full-window surface (a dialog cannot portal a live iframe)
const COVER = 'fixed inset-0';

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

// Shows its content over the whole window without moving it in the page: the content's elements
// stay the very same ones when it opens and closes, so a live iframe inside it is not reloaded
// (a Dialog portals its content, which rebuilds it). Closed, its element makes no box
// (`display: contents`) and `className` / `style` do not apply.
//
// Plain form: a layout state of a panel. It sits on the sticky level, under menus and dialogs,
// moves no focus, and Escape leaves it unless the key was pressed inside a design-system layer.
//
// `layer`: a dialog as far as the layer manager and the user can tell. One at a time (a dialog
// or an approval that opens replaces it, and it is turned away while an approval is on the page),
// the app hides what the page cannot paint over, the keyboard stays inside, it opens on the
// control `initialFocus` names (else its first control that is not a frame) and gives the focus
// back when it leaves. `scrim` puts the dialog scrim behind it; a press on the scrim leaves.
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
      if (event.key !== 'Escape') return;
      // An Escape pressed inside a menu, a popover or a question belongs to that layer.
      const within = event.target instanceof Element ? event.target.closest('[data-ds-layer]') : null;
      if (within && within !== rootRef.current) return;
      if (!layer) {
        exitRef.current();
        return;
      }
      // A layer above has used the key.
      if (event.defaultPrevented) return;
      event.preventDefault();
      registry.escapeTop();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [shown, layer, registry]);

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
        className={shown ? cn(COVER, layer ? 'z-dialog' : 'z-sticky', 'outline-none', className) : 'contents'}
        style={shown ? style : undefined}
        onKeyDown={(event) => scopeKeyDown.current?.(event)}
      >
        {content}
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
