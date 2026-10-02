import { useContext, useMemo, useRef, type ReactNode } from 'react';
import { LayerContext, LayerScopeContext, type LayerEntry, type LayerRegistry } from './layer-context';

// Keeps at most one dialog and one menu or popover open at a time (spec §6.4, flow 2).
// An alert stacks over an open dialog; a newer alert, a new dialog, or that dialog closing closes it.
// A layer opened inside another layer is its child and leaves that parent open.
// Also decides which DOM node floating layers portal into.
export function LayerProvider({ children, container }: { children: ReactNode; container?: HTMLElement | null }) {
  const layers = useRef<LayerEntry[]>([]);
  // Alert id → the dialog that was open when the alert was asked. The alert is a question
  // about that dialog, so it is answered with cancel when the dialog goes away for any reason.
  const askedOver = useRef(new Map<string, string>());
  const registry = useMemo<LayerRegistry>(() => {
    const remove = (id: string) => {
      layers.current = layers.current.filter((layer) => layer.id !== id);
      askedOver.current.delete(id);
      for (const layer of layers.current) {
        if (askedOver.current.get(layer.id) === id) dismiss(layer);
      }
    };
    function dismiss(layer: LayerEntry) {
      remove(layer.id);
      layer.close();
    }
    return {
      container: container ?? undefined,
      unregister: remove,
      register(entry) {
        // Layout effects run child-first, so a layer's own descendants may already be
        // registered when it registers; they stay open like its ancestors do.
        const others = layers.current.filter((layer) => (
          layer.id !== entry.id && !entry.ancestors.includes(layer.id) && !layer.ancestors.includes(entry.id)
        ));
        for (const layer of others) {
          if (layer.kind === 'popover') dismiss(layer);
          // A new alert replaces an older one; a new dialog answers an open alert with cancel.
          else if (layer.kind === 'alert' && entry.kind !== 'popover') dismiss(layer);
        }
        if (entry.kind === 'dialog') {
          const current = others.find((layer) => layer.kind === 'dialog');
          if (current?.isDirty()) {
            entry.close();
            current.confirmDiscard(() => {
              dismiss(current);
              entry.reopen();
            });
            return;
          }
          if (current) dismiss(current);
        }
        if (entry.kind === 'alert') {
          const dialog = layers.current.find((layer) => layer.kind === 'dialog');
          if (dialog) askedOver.current.set(entry.id, dialog.id);
        }
        layers.current = [...layers.current.filter((layer) => layer.id !== entry.id), entry];
      },
    };
  }, [container]);
  return <LayerContext.Provider value={registry}>{children}</LayerContext.Provider>;
}

export function LayerScope({ id, children }: { id: string; children: ReactNode }) {
  const parent = useContext(LayerScopeContext);
  const value = useMemo(() => [...parent, id], [parent, id]);
  return <LayerScopeContext.Provider value={value}>{children}</LayerScopeContext.Provider>;
}
