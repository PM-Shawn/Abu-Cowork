import { createContext, useCallback, useContext, useId, useLayoutEffect, useRef, useState } from 'react';

// An alert is a question about whatever is on screen, so it stacks over an open dialog.
export type LayerKind = 'dialog' | 'popover' | 'alert';

export interface DialogGuard {
  isDirty: () => boolean;
  confirmDiscard: (onDiscard: () => void) => void;
}

export interface LayerEntry {
  id: string;
  kind: LayerKind;
  // Ids of the layers this one was opened inside; those stay open.
  ancestors: readonly string[];
  close: () => void;
  reopen: () => void;
  isDirty: () => boolean;
  confirmDiscard: (onDiscard: () => void) => void;
}

export interface LayerRegistry {
  container: HTMLElement | undefined;
  register: (entry: LayerEntry) => void;
  unregister: (id: string) => void;
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
}

// Registers an open layer with the nearest LayerProvider.
export function useLayer(kind: LayerKind, open: boolean, setOpen: (open: boolean) => void, guard?: DialogGuard): LayerHandle {
  const registry = useLayerRegistry();
  const ancestors = useContext(LayerScopeContext);
  const id = useId();
  const latest = useRef({ setOpen, guard });
  const closedByRegistry = useRef(false);
  useLayoutEffect(() => { latest.current = { setOpen, guard }; });
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
      reopen: () => latest.current.setOpen(true),
      isDirty: () => latest.current.guard?.isDirty() ?? false,
      confirmDiscard: (onDiscard) => {
        const current = latest.current.guard;
        if (!current) throw new Error('Only a dialog can ask to discard its content');
        current.confirmDiscard(onDiscard);
      },
    });
    return () => registry.unregister(id);
  }, [open, kind, id, ancestors, registry]);
  const onCloseAutoFocus = useCallback((event: Event) => {
    if (closedByRegistry.current) event.preventDefault();
    closedByRegistry.current = false;
  }, []);
  return { id, onCloseAutoFocus };
}
