import { createContext, useCallback, useContext, useId, useLayoutEffect, useRef, useState } from 'react';

// An alert is a question about whatever is on screen, so it stacks over an open dialog.
export type LayerKind = 'dialog' | 'popover' | 'alert';

export interface DialogGuard {
  isDirty: () => boolean;
  // Asks whether to discard the unsaved input. `onKeep` runs when the question closes any
  // other way than Discard. Returns a function that takes the question back unanswered.
  confirmDiscard: (onDiscard: () => void, onKeep?: () => void) => () => void;
  // What Escape does to the dialog: it asks before discarding input, and does nothing to a
  // dialog only its own buttons may close.
  escape: () => void;
}

export interface LayerEntry {
  id: string;
  kind: LayerKind;
  // Ids of the layers this one was opened inside; those stay open.
  ancestors: readonly string[];
  close: () => void;
  // What the Escape key does to this layer.
  escape: () => void;
  // Held: open as far as its owner knows, but not on the page. The registry holds a new
  // dialog while the user decides about unsaved input in the dialog it would replace.
  hold: () => void;
  release: () => void;
  isDirty: () => boolean;
  confirmDiscard: (onDiscard: () => void, onKeep?: () => void) => () => void;
}

export interface LayerRegistry {
  container: HTMLElement | undefined;
  register: (entry: LayerEntry) => void;
  unregister: (id: string) => void;
  // Escape reached a layer that is fading out: the key acts on the top open layer instead.
  escapeTop: () => void;
}

export const LayerContext = createContext<LayerRegistry | null>(null);
export const LayerScopeContext = createContext<readonly string[]>([]);

// True inside a Dialog. A menu, select or popover opened there sits on the dialog's level:
// it joins the page after the dialog, so it paints above it. Elsewhere it sits on the popover level.
export const InDialogContext = createContext(false);

export function useFloatingLevel(): 'z-dialog' | 'z-popover' {
  return useContext(InDialogContext) ? 'z-dialog' : 'z-popover';
}

export function useLayerRegistry(): LayerRegistry {
  const registry = useContext(LayerContext);
  if (!registry) throw new Error('Design-system components must render inside <DesignSystemProvider>.');
  return registry;
}

export function useLayerContainer(): HTMLElement | undefined {
  return useLayerRegistry().container;
}

export function useOpenState(
  open: boolean | undefined,
  defaultOpen: boolean,
  onOpenChange?: (open: boolean) => void,
): [boolean, (open: boolean) => void] {
  const [uncontrolled, setUncontrolled] = useState(defaultOpen);
  const controlled = open !== undefined;
  const onChange = useRef(onOpenChange);
  useLayoutEffect(() => { onChange.current = onOpenChange; });
  const setOpen = useCallback((next: boolean) => {
    if (!controlled) setUncontrolled(next);
    onChange.current?.(next);
  }, [controlled]);
  return [controlled ? open : uncontrolled, setOpen];
}

export interface LayerHandle {
  // Passed to <LayerScope> around the layer's content.
  id: string;
  // Passed to the Radix Content: when the registry closes this layer to make room for
  // another, focus stays where the new layer put it.
  onCloseAutoFocus: (event: Event) => void;
  // True while the registry holds this layer back; the layer renders as closed.
  held: boolean;
  // Passed to the Radix Content. A layer stays on the page while it fades out and Radix still
  // counts it as the top layer: an Escape that reaches it then goes to the top open layer.
  onEscapeKeyDown: (event: Event) => void;
}

// Registers an open layer with the nearest LayerProvider.
export function useLayer(kind: LayerKind, open: boolean, setOpen: (open: boolean) => void, guard?: DialogGuard): LayerHandle {
  const registry = useLayerRegistry();
  const ancestors = useContext(LayerScopeContext);
  const id = useId();
  const latest = useRef({ setOpen, guard, open });
  const closedByRegistry = useRef(false);
  const [held, setHeld] = useState(false);
  useLayoutEffect(() => { latest.current = { setOpen, guard, open }; });
  useLayoutEffect(() => {
    if (!open) return undefined;
    closedByRegistry.current = false;
    registry.register({
      id,
      kind,
      ancestors,
      close: () => {
        closedByRegistry.current = true;
        latest.current.setOpen(false);
      },
      escape: () => {
        const current = latest.current;
        if (current.guard) current.guard.escape();
        else current.setOpen(false);
      },
      hold: () => setHeld(true),
      release: () => setHeld(false),
      isDirty: () => latest.current.guard?.isDirty() ?? false,
      confirmDiscard: (onDiscard, onKeep) => {
        const current = latest.current.guard;
        if (!current) throw new Error('Only a dialog can ask to discard its content');
        return current.confirmDiscard(onDiscard, onKeep);
      },
    });
    return () => registry.unregister(id);
  }, [open, kind, id, ancestors, registry]);
  const onCloseAutoFocus = useCallback((event: Event) => {
    if (closedByRegistry.current) event.preventDefault();
    closedByRegistry.current = false;
  }, []);
  const onEscapeKeyDown = useCallback((event: Event) => {
    if (latest.current.open) return;
    // Radix would use the key up on this layer, which is already closing.
    event.preventDefault();
    registry.escapeTop();
  }, [registry]);
  return { id, onCloseAutoFocus, held, onEscapeKeyDown };
}
