// Which elements the Tab key reaches inside a layer's box. Shared by Dialog and FullscreenSurface.

// Whether the Tab key reaches this element inside `content`: the test Radix makes for its own
// first focus target, with the check that nothing up to the box hides it.
export function isTabbable(element: HTMLElement, content: HTMLElement): boolean {
  if (!(element.tabIndex >= 0)) return false;
  const hiddenInput = element instanceof HTMLInputElement && element.type === 'hidden';
  if ((element as HTMLElement & { disabled?: boolean }).disabled || element.hidden || hiddenInput) return false;
  for (let node: HTMLElement | null = element; node && node !== content; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
  }
  return true;
}

export function firstTabbable(content: HTMLElement, skipLinks = false): HTMLElement | null {
  for (const element of content.querySelectorAll<HTMLElement>('*')) {
    if (skipLinks && element.tagName === 'A') continue;
    if (isTabbable(element, content)) return element;
  }
  return null;
}

export function lastTabbable(content: HTMLElement): HTMLElement | null {
  const all = content.querySelectorAll<HTMLElement>('*');
  for (let index = all.length - 1; index >= 0; index -= 1) {
    if (isTabbable(all[index], content)) return all[index];
  }
  return null;
}
