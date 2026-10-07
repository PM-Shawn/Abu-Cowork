import { useSyncExternalStore } from 'react';

const APPEARANCE_ATTRIBUTES = ['class', 'data-contrast', 'data-transparency', 'data-motion'];

// The appearance switches change <html>'s dark class and data-* attributes.
function subscribeToAppearance(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: APPEARANCE_ATTRIBUTES });
  return () => observer.disconnect();
}

// Re-reads a computed style value whenever the appearance changes.
export function useComputedValue(read: () => string): string {
  return useSyncExternalStore(subscribeToAppearance, read);
}

export function readRootVariable(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
