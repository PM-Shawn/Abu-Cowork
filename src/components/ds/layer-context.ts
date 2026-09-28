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

// Registers an open layer with the nearest LayerProvider. Returns the layer id, which
// the caller passes to <LayerScope> around its content.
export function useLayer(kind: LayerKind, open: boolean, setOpen: (open: boolean) => void, guard?: DialogGuard): string {
  const registry = useLayerRegistry();
  const ancestors = useContext(LayerScopeContext);
  const id = useId();
  const latest = useRef({ setOpen, guard });
  useLayoutEffect(() => { latest.current = { setOpen, guard }; });
  useLayoutEffect(() => {
    if (!open) return undefined;
    registry.register({
      id,
      kind,
      ancestors,
      close: () => latest.current.setOpen(false),
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
  return id;
}
