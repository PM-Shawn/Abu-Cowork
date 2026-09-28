// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installAppearanceAttributes } from '@/styles/appearance';
import { fakeMatchMedia } from '@/test/fakeMatchMedia';
import { DesignPreview } from './DesignPreview';
import { PREVIEW_SECTIONS } from './sections/sectionIds';

describe('DesignPreview', () => {
  let uninstall: (() => void) | null = null;
  const root = document.documentElement;

  beforeEach(() => {
    vi.spyOn(window, 'matchMedia').mockImplementation(fakeMatchMedia({}).matchMedia);
    uninstall = installAppearanceAttributes(root);
  });

  afterEach(() => {
    uninstall?.();
    uninstall = null;
    root.classList.remove('dark');
    vi.restoreAllMocks();
  });

  it('shows every section', () => {
    render(<DesignPreview />);
    for (const id of PREVIEW_SECTIONS) {
      expect(document.querySelector(`[data-preview-section="${id}"]`), id).not.toBeNull();
    }
  });

  it('forces dark and the three accessibility appearances, and restores them when closed', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<DesignPreview />);
    await user.click(within(screen.getByRole('group', { name: 'Appearance' })).getByRole('radio', { name: 'Dark' }));
    await user.click(screen.getByRole('switch', { name: 'Increase contrast' }));
    await user.click(screen.getByRole('switch', { name: 'Reduce transparency' }));
    await user.click(screen.getByRole('switch', { name: 'Reduce motion' }));
    expect(root).toHaveClass('dark');
    expect(root.getAttribute('data-contrast')).toBe('more');
    expect(root.getAttribute('data-transparency')).toBe('reduced');
    expect(root.getAttribute('data-motion')).toBe('reduced');
    unmount();
    expect(root).not.toHaveClass('dark');
    expect(root.hasAttribute('data-contrast')).toBe(false);
    expect(root.hasAttribute('data-transparency')).toBe(false);
    expect(root.hasAttribute('data-motion')).toBe(false);
  });
});
