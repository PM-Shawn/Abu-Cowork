// Helpers for tests of windows built on the design-system Dialog: the fade a window keeps
// rendering through, and an approval that arrives while the window is open.
import { createElement, type ReactElement } from 'react';
import { act, fireEvent, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { Button } from '@/components/ds/button';
import { Dialog } from '@/components/ds/dialog';
import { getI18n } from '@/i18n';

// happy-dom reports no animation, so Radix removes a closed layer at once. With this, a closed
// layer has an exit animation: it stays on the page, as it does in the app while it fades out,
// until the test ends the animation.
export function keepClosingLayersOnScreen() {
  const real = window.getComputedStyle.bind(window);
  return vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element, pseudo?: string | null) => {
    const styles = real(element, pseudo);
    return new Proxy(styles, {
      get(target, prop) {
        if (prop === 'animationName') return element.getAttribute('data-state') === 'closed' ? 'exit' : 'enter';
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  });
}

// The window that is fading out.
export function closingWindow(): HTMLElement {
  const closing = document.querySelector<HTMLElement>('[role="dialog"][data-state="closed"]');
  if (!closing) throw new Error('No window is closing');
  return closing;
}

// Ends the fade: the window leaves the page, and what it does once it has gone runs (one timer tick later).
export function finishClosing() {
  vi.useFakeTimers();
  const ended = new Event('animationend', { bubbles: true });
  Object.defineProperty(ended, 'animationName', { value: 'exit' });
  act(() => { closingWindow().dispatchEvent(ended); });
  act(() => { vi.runOnlyPendingTimers(); });
  vi.useRealTimers();
}

// The box of a window that is in the page, on screen or hidden, found by its title.
export function windowBox(title: string): HTMLElement | null {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]'))
    .find((element) => element.querySelector('h2')?.textContent === title) ?? null;
}

export const APPROVAL_TITLE = 'Confirm Action';

// Stands in for a command approval: the same kind of layer, answered only by its owner.
export function approvalProbe(shown: boolean, onAnswer: (open: boolean) => void): ReactElement {
  return createElement(Dialog, {
    open: shown,
    onOpenChange: onAnswer,
    layer: 'approval',
    role: 'alertdialog',
    outsidePress: 'ignore',
    title: APPROVAL_TITLE,
    footer: createElement(Button, null, 'Cancel the command'),
  });
}

// The question a window asks before it drops what was typed.
export const discardQuestion = {
  box: () => windowBox(getI18n().designSystem.discardTitle),
  keepEditing: () => fireEvent.click(screen.getByRole('button', { name: getI18n().designSystem.keepEditing })),
  discard: () => fireEvent.click(screen.getByRole('button', { name: getI18n().designSystem.discard })),
};
