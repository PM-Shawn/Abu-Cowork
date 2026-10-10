// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render as renderBare, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { DesignSystemProvider } from '@/components/ds/provider';
import { getI18n } from '@/i18n';
import { useSettingsStore } from '@/stores/settingsStore';
import DisclaimerBanner from './DisclaimerBanner';

const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });
const t = () => getI18n();

function show() {
  render(<DisclaimerBanner />);
  return screen.getByText(t().about.disclaimerTitle).closest<HTMLElement>('.fixed')!;
}

const levelClasses = (element: HTMLElement) => [...element.classList].filter((name) => name.startsWith('z-'));
const settings = () => useSettingsStore.getState();

const reset = () => useSettingsStore.setState({ hasAcknowledgedDisclaimer: false, systemSettingsOpen: false, activeSystemTab: 'usage' });

beforeEach(reset);

afterEach(() => {
  cleanup();
  reset();
});

describe('DisclaimerBanner', () => {
  describe('when it shows', () => {
    it('shows until the notice has been acknowledged', () => {
      const banner = show();
      expect(banner).toBeInTheDocument();
    });

    it('shows nothing once the notice has been acknowledged', () => {
      useSettingsStore.setState({ hasAcknowledgedDisclaimer: true });
      render(<DisclaimerBanner />);
      expect(screen.queryByText(t().about.disclaimerTitle)).toBeNull();
      expect(screen.queryAllByRole('button')).toHaveLength(0);
    });
  });

  describe('what it shows', () => {
    it('shows the title, the three lines and its two worded buttons', () => {
      const banner = show();
      expect(banner).toHaveTextContent(t().about.disclaimerTitle);
      const lines = [...banner.querySelectorAll('li')].map((line) => line.textContent);
      expect(lines).toEqual([t().disclaimerBanner.line1, t().disclaimerBanner.line2, t().disclaimerBanner.line3]);
      expect(screen.getByRole('button', { name: t().disclaimerBanner.dismiss })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: t().disclaimerBanner.viewFull })).toBeInTheDocument();
      expect(screen.getAllByRole('button')).toHaveLength(3);
    });
  });

  describe('what its buttons do', () => {
    it('acknowledges from the corner button and opens nothing', () => {
      show();
      fireEvent.click(screen.getAllByRole('button')[0]);
      expect(settings().hasAcknowledgedDisclaimer).toBe(true);
      expect(settings().systemSettingsOpen).toBe(false);
      expect(settings().activeSystemTab).toBe('usage');
      expect(screen.queryByText(t().about.disclaimerTitle)).toBeNull();
    });

    it('acknowledges from the dismiss button and opens nothing', () => {
      show();
      fireEvent.click(screen.getByRole('button', { name: t().disclaimerBanner.dismiss }));
      expect(settings().hasAcknowledgedDisclaimer).toBe(true);
      expect(settings().systemSettingsOpen).toBe(false);
      expect(screen.queryByText(t().about.disclaimerTitle)).toBeNull();
    });

    it('acknowledges and opens the about page of the settings from the full-text button', () => {
      show();
      fireEvent.click(screen.getByRole('button', { name: t().disclaimerBanner.viewFull }));
      expect(settings().hasAcknowledgedDisclaimer).toBe(true);
      expect(settings().systemSettingsOpen).toBe(true);
      expect(settings().activeSystemTab).toBe('about');
    });
  });

  describe('where it sits', () => {
    it('keeps its corner and its width', () => {
      expect(show()).toHaveClass('fixed', 'bottom-6', 'right-6', 'w-80');
    });

    it('sits on the fullscreen level and on no other', () => {
      expect(levelClasses(show())).toEqual(['z-fullscreen']);
    });

    it('opts out of the window drag lanes', () => {
      expect(show()).toHaveAttribute('data-electron-no-drag');
    });
  });

  describe('how it looks', () => {
    it('is an opaque raised box with a separator line', () => {
      expect(show()).toHaveClass('rounded-panel', 'border', 'border-separator', 'bg-raised', 'shadow-float');
    });

    it('names its corner button', () => {
      show();
      expect(screen.getAllByRole('button')[0]).toBe(screen.getByRole('button', { name: t().common.close }));
    });

    it('marks its title with the warning color, on its soft fill, with a shape', () => {
      show();
      const tag = screen.getByText(t().about.disclaimerTitle);
      expect(tag).toHaveClass('text-warning');
      expect(tag).toHaveClass('bg-warning-soft');
      expect(tag.querySelector('svg')).not.toBeNull();
    });

    it('uses no legacy color variable', () => {
      expect(show().outerHTML).not.toContain('--abu-');
    });
  });
});
