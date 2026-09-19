/**
 * Lets a send guard ask the composer to open its model picker. The guard runs
 * from several places (composer, message actions, capability setup) and none
 * of them owns the picker's state.
 */
type Listener = () => void;

const listeners = new Set<Listener>();

export function requestModelPicker(): void {
  for (const listener of listeners) listener();
}

export function subscribeModelPickerRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
