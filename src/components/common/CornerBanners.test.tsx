// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render as renderBare, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { DesignSystemProvider } from '@/components/ds/provider';
import { getI18n } from '@/i18n';
import { useSettingsStore } from '@/stores/settingsStore';
import type { AnnouncementItem } from '@/utils/consoleAnnouncement';
import CornerBanners from './CornerBanners';

const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });
const t = () => getI18n();

const ITEM: AnnouncementItem = {
  id: 7,
  slug: 'test-item',
  type: 'feature',
  title: 'Test announcement title',
  body: 'Test announcement body',
  ctaUrl: 'https://example.invalid/notes',
  ctaLabel: 'Read the notes',
  publishedAt: null,
};

const settings = () => useSettingsStore.getState();
const reset = () => useSettingsStore.setState({ hasAcknowledgedDisclaimer: false, systemSettingsOpen: false, activeSystemTab: 'usage' });
const banners = () => [...document.querySelectorAll<HTMLElement>('.fixed.bottom-6.right-6')];
const disclaimer = () => screen.queryByText(t().about.disclaimerTitle);
const announcement = () => screen.queryByText(ITEM.title);

// `none` renders with no announcement due.
function show(due: 'announcement' | 'none' = 'announcement') {
  const onDismiss = vi.fn();
  render(<CornerBanners announcement={due === 'none' ? undefined : ITEM} onDismissAnnouncement={onDismiss} />);
  return { onDismiss };
}

beforeEach(reset);

afterEach(() => {
  cleanup();
  reset();
  vi.mocked(openUrl).mockClear();
});

describe('CornerBanners', () => {
  describe('each banner alone', () => {
    it('shows the disclaimer until it has been acknowledged, with no announcement', () => {
      show('none');
      expect(disclaimer()).toBeInTheDocument();
      expect(banners()).toHaveLength(1);
    });

    it('shows the announcement once the disclaimer has been acknowledged', () => {
      useSettingsStore.setState({ hasAcknowledgedDisclaimer: true });
      show();
      expect(announcement()).toBeInTheDocument();
      expect(disclaimer()).toBeNull();
      expect(banners()).toHaveLength(1);
    });

    it('shows nothing with the disclaimer acknowledged and no announcement', () => {
      useSettingsStore.setState({ hasAcknowledgedDisclaimer: true });
      show('none');
      expect(banners()).toHaveLength(0);
      expect(screen.queryAllByRole('button')).toHaveLength(0);
    });

    it('hands the dismissal of the announcement to its owner, from both of its buttons', () => {
      useSettingsStore.setState({ hasAcknowledgedDisclaimer: true });
      const { onDismiss } = show();
      fireEvent.click(screen.getByRole('button', { name: t().common.close }));
      fireEvent.click(screen.getByRole('button', { name: t().announcement.dismiss }));
      expect(onDismiss).toHaveBeenCalledTimes(2);
    });

    it('opens the address of the announcement and leaves it showing', () => {
      useSettingsStore.setState({ hasAcknowledgedDisclaimer: true });
      const { onDismiss } = show();
      fireEvent.click(screen.getByRole('button', { name: ITEM.ctaLabel! }));
      expect(openUrl).toHaveBeenCalledWith(ITEM.ctaUrl);
      expect(onDismiss).not.toHaveBeenCalled();
      expect(announcement()).toBeInTheDocument();
    });

    it('acknowledges the disclaimer from its dismiss button and opens nothing', () => {
      show('none');
      fireEvent.click(screen.getByRole('button', { name: t().disclaimerBanner.dismiss }));
      expect(settings().hasAcknowledgedDisclaimer).toBe(true);
      expect(settings().systemSettingsOpen).toBe(false);
      expect(banners()).toHaveLength(0);
    });
  });

  describe('both due at once', () => {
    it('shows the disclaimer alone', () => {
      show();
      expect(disclaimer()).toBeInTheDocument();
      expect(announcement()).toBeNull();
      expect(banners()).toHaveLength(1);
    });

    it('offers only the three buttons of the disclaimer', () => {
      show();
      const names = screen.getAllByRole('button').map((button) => button.getAttribute('aria-label') ?? button.textContent);
      expect(names).toEqual([t().common.close, t().disclaimerBanner.dismiss, t().disclaimerBanner.viewFull]);
    });

    it('does not dismiss the announcement when the disclaimer is dismissed', () => {
      const { onDismiss } = show();
      fireEvent.click(screen.getByRole('button', { name: t().disclaimerBanner.dismiss }));
      expect(onDismiss).not.toHaveBeenCalled();
    });

    it.each([
      ['its dismiss button', () => t().disclaimerBanner.dismiss],
      ['its corner button', () => t().common.close],
    ] as const)('shows the announcement after the disclaimer is dismissed from %s', (_name, label) => {
      show();
      fireEvent.click(screen.getByRole('button', { name: label() }));
      expect(settings().hasAcknowledgedDisclaimer).toBe(true);
      expect(disclaimer()).toBeNull();
      expect(announcement()).toBeInTheDocument();
      expect(banners()).toHaveLength(1);
    });

    it('shows the announcement after the full text of the disclaimer is opened', () => {
      show();
      fireEvent.click(screen.getByRole('button', { name: t().disclaimerBanner.viewFull }));
      expect(settings().systemSettingsOpen).toBe(true);
      expect(settings().activeSystemTab).toBe('about');
      expect(disclaimer()).toBeNull();
      expect(announcement()).toBeInTheDocument();
    });

    it('keeps the announcement dismissible once it shows', () => {
      const { onDismiss } = show();
      fireEvent.click(screen.getByRole('button', { name: t().disclaimerBanner.dismiss }));
      fireEvent.click(screen.getByRole('button', { name: t().announcement.dismiss }));
      expect(onDismiss).toHaveBeenCalledTimes(1);
    });
  });
});
