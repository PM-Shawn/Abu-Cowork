import { useContext, useMemo, useRef, type ReactNode } from 'react';
import { LayerContext, LayerScopeContext, type LayerEntry, type LayerRegistry } from './layer-context';

// A new dialog that is held back while the user decides about unsaved input.
interface Waiting {
  entry: LayerEntry;
  // The dialog it would replace, and the dialog that asks: that one, or a dialog opened inside it.
  holderId: string;
  askerId: string;
  withdraw: () => void;
}

// Keeps at most one dialog and one menu or popover open at a time (spec §6.4, flow 2).
// An alert stacks over an open dialog; a newer alert, a new dialog, or that dialog closing closes it.
// A layer opened inside another layer is its child and leaves that parent open.
// A new dialog replaces the open one. When the open one, or a dialog opened inside it, holds
// unsaved input, the new dialog is held while the user is asked: Discard closes the open
// dialog and shows the new one, keeping the input closes the new one. A confirmation that was
// open over that dialog is answered with cancel as soon as the new dialog arrives, held or not:
// the discard question has to be the top layer for the user to decide.
// Also decides which DOM node floating layers portal into.
export function LayerProvider({ children, container }: { children: ReactNode; container?: HTMLElement | null }) {
  const layers = useRef<LayerEntry[]>([]);
  // Alert id → the dialog that was open when the alert was asked. The alert is a question
  // about that dialog, so it is answered with cancel when the dialog goes away for any reason.
  const askedOver = useRef(new Map<string, string>());
  const waiting = useRef<Waiting | null>(null);
  const registry = useMemo<LayerRegistry>(() => {
    // Ends the wait without deciding: the question is taken back and the dialog is no longer held.
    const stopWaiting = () => {
      const held = waiting.current;
      waiting.current = null;
      if (!held) return;
      held.withdraw();
      held.entry.release();
    };
    const remove = (id: string) => {
      const removed = layers.current.find((layer) => layer.id === id);
      // Dialogs opened inside a dialog go with it.
      layers.current = layers.current.filter((layer) => (
        layer.id !== id && !(removed?.kind === 'dialog' && layer.kind === 'dialog' && layer.ancestors.includes(id))
      ));
      askedOver.current.delete(id);
      for (const layer of layers.current) {
        if (askedOver.current.get(layer.id) === id) dismiss(layer);
      }
      const held = waiting.current;
      if (!held) return;
      if (held.entry.id === id) {
        // The held dialog went away by itself (its request was withdrawn): nothing left to ask.
        stopWaiting();
      } else if (held.holderId === id || held.askerId === id) {
        // What it waited for has gone or changed: decide again against what is open now.
        stopWaiting();
        register(held.entry);
      }
    };
    function dismiss(layer: LayerEntry) {
      remove(layer.id);
      layer.close();
    }
    function register(entry: LayerEntry) {
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
        const dialogs = others.filter((layer) => layer.kind === 'dialog');
        // The open dialog: the one that is not inside another.
        const current = dialogs.find((dialog) => !dialogs.some((other) => dialog.ancestors.includes(other.id)));
        if (current) {
          // A dialog that was already waiting gives way to the newer one.
          const earlier = waiting.current;
          if (earlier && earlier.entry.id !== entry.id) {
            stopWaiting();
            earlier.entry.close();
          }
          // Unsaved input counts wherever it is: in the open dialog or in one opened inside it.
          // The innermost such dialog asks.
          const dirty = [...dialogs].reverse().find((dialog) => (
            (dialog.id === current.id || dialog.ancestors.includes(current.id)) && dialog.isDirty()
          ));
          if (dirty) {
            entry.hold();
            const held: Waiting = { entry, holderId: current.id, askerId: dirty.id, withdraw: () => undefined };
            waiting.current = held;
            held.withdraw = dirty.confirmDiscard(
              // Removing the open dialog releases the held one and registers it.
              () => { if (waiting.current === held) dismiss(current); },
              () => {
                if (waiting.current !== held) return;
                stopWaiting();
                entry.close();
              },
            );
            return;
          }
          dismiss(current);
        }
      }
      if (entry.kind === 'alert') {
        const dialog = layers.current.find((layer) => layer.kind === 'dialog');
        if (dialog) askedOver.current.set(entry.id, dialog.id);
      }
      layers.current = [...layers.current.filter((layer) => layer.id !== entry.id), entry];
    }
    return { container: container ?? undefined, unregister: remove, register };
  }, [container]);
  return <LayerContext.Provider value={registry}>{children}</LayerContext.Provider>;
}

export function LayerScope({ id, children }: { id: string; children: ReactNode }) {
  const parent = useContext(LayerScopeContext);
  const value = useMemo(() => [...parent, id], [parent, id]);
  return <LayerScopeContext.Provider value={value}>{children}</LayerScopeContext.Provider>;
}
