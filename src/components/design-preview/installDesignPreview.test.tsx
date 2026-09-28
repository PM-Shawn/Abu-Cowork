// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { act } from '@testing-library/react';
import { installDesignPreview } from './installDesignPreview';

function press(init: KeyboardEventInit) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
  });
}

const OPEN = { key: 'D', code: 'KeyD', altKey: true, shiftKey: true, metaKey: true, ctrlKey: true };

describe('installDesignPreview', () => {
  let uninstall: (() => void) | null = null;

  afterEach(() => {
    uninstall?.();
    uninstall = null;
    document.querySelectorAll('[data-design-preview-host]').forEach((n) => n.remove());
  });

  it('opens the preview on the shortcut and closes it on the same shortcut', () => {
    uninstall = installDesignPreview();
    press(OPEN);
    expect(document.querySelector('[data-design-preview-root]')).not.toBeNull();
    press(OPEN);
    expect(document.querySelector('[data-design-preview-root]')).toBeNull();
  });

  it('closes the preview on Escape', () => {
    uninstall = installDesignPreview();
    press(OPEN);
    press({ key: 'Escape', code: 'Escape' });
    expect(document.querySelector('[data-design-preview-root]')).toBeNull();
  });

  it('ignores the letter without every modifier', () => {
    uninstall = installDesignPreview();
    press({ key: 'D', code: 'KeyD', shiftKey: true });
    expect(document.querySelector('[data-design-preview-root]')).toBeNull();
  });
});
