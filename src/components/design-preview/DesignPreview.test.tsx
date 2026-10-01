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

  it('shows every color token with a value that follows the appearance', async () => {
    const user = userEvent.setup();
    root.style.setProperty('--ds-focus', '#111111');
    try {
      render(<DesignPreview />);
      for (const name of ['on-emphasis', 'brand-ink', 'separator', 'control-border', 'focus', 'surface', 'label', 'danger-soft', 'page-canvas']) {
        expect(document.querySelector(`[data-token="${name}"]`), name).not.toBeNull();
      }
      expect(document.querySelector('[data-preview-selection] [data-token="selection"] [data-token-value]')).not.toBeNull();
      for (const name of ['syntax-comment', 'syntax-keyword', 'syntax-string', 'syntax-number', 'syntax-function', 'syntax-property']) {
        expect(document.querySelector(`[data-preview-syntax] [data-token="${name}"] [data-token-value]`), name).not.toBeNull();
      }
      const focusValue = () => document.querySelector('[data-token="focus"] [data-token-value]')?.textContent;
      expect(focusValue()).toBe('#111111');
      root.style.setProperty('--ds-focus', '#222222');
      await user.click(within(screen.getByRole('group', { name: 'Appearance' })).getByRole('radio', { name: 'Dark' }));
      expect(focusValue()).toBe('#222222');
    } finally {
      root.style.removeProperty('--ds-focus');
    }
  });

  it('lists the layer, duration, easing, corner and elevation scales', () => {
    render(<DesignPreview />);
    const tokens = within(document.querySelector('[data-preview-section="tokens"]') as HTMLElement);
    const table = tokens.getByRole('table', { name: 'Scales' });
    for (const name of ['z-sticky', 'z-popover', 'z-dialog', 'z-toast', 'z-tooltip', 'duration-fast', 'duration-base', 'duration-slow', 'ease-enter', 'ease-exit', 'rounded-window', 'rounded-panel', 'rounded-control', 'shadow-panel', 'shadow-float', 'shadow-dialog', 'shadow-composer']) {
      expect(within(table).getByText(name), name).toBeInTheDocument();
    }
  });

  it('shows the disabled, invalid and size variants', () => {
    render(<DesignPreview />);
    expect(screen.getByRole('textbox', { name: 'Disabled field' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Disabled notes' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Notes with an error' })).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('checkbox', { name: 'Disabled checkbox' })).toBeDisabled();
    expect(screen.getByRole('slider', { name: 'Disabled volume' })).toHaveAttribute('data-disabled');
    expect(screen.getByRole('combobox', { name: 'Disabled model' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Disabled model search' })).toBeDisabled();
    expect(within(screen.getByRole('radiogroup', { name: 'Density' })).getByRole('radio', { name: 'Spacious (not available)' })).toBeDisabled();
    expect(screen.getByRole('radiogroup', { name: 'Sort order' })).toHaveAttribute('aria-orientation', 'horizontal');
    const view = within(screen.getByRole('group', { name: 'View' }));
    expect(view.getByRole('radio', { name: 'Files' }).querySelector('svg')).not.toBeNull();
    expect(view.getByRole('radio', { name: 'Tasks' }).querySelector('svg')).not.toBeNull();
    expect(screen.getByRole('combobox', { name: 'Model (not chosen)' })).toHaveTextContent('Choose a model');
    expect(screen.getByRole('tab', { name: 'History' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Small dialog' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Large dialog' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm (default tone)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Renew' })).toBeInTheDocument();
    const basics = within(document.querySelector('[data-preview-section="basics"]') as HTMLElement);
    expect(basics.getAllByRole('separator').map((node) => node.getAttribute('aria-orientation') ?? 'horizontal').sort()).toEqual(['horizontal', 'vertical']);
    expect(basics.getByRole('img', { name: 'Sam' })).toBeInTheDocument();
    const statusWith = (text: string) => screen.getAllByRole('status').find((node) => node.textContent === text) as HTMLElement;
    expect(statusWith('Saving').querySelector('svg')).toHaveAttribute('width', '14');
    expect(statusWith('Loading the task').querySelector('svg')).toHaveAttribute('width', '20');
    expect(within(statusWith('Syncing')).getByText('Syncing')).toHaveClass('sr-only');
    const icons = document.querySelector('[data-preview-icons]') as HTMLElement;
    expect(icons.querySelectorAll('svg[width="14"]').length).toBeGreaterThan(0);
    expect(icons.querySelectorAll('svg[width="20"]').length).toBeGreaterThan(0);
  });
});
