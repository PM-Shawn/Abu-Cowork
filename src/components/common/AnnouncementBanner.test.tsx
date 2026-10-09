// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render as renderBare, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { DesignSystemProvider } from '@/components/ds/provider';
import { getI18n } from '@/i18n';
import type { AnnouncementItem } from '@/utils/consoleAnnouncement';
import AnnouncementBanner from './AnnouncementBanner';

const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });
const t = () => getI18n();

const ITEM: AnnouncementItem = {
  id: 7,
  slug: 'test-item',
  type: 'version_update',
  title: 'Test announcement title',
  body: 'First paragraph with **strong words**.\n\n- one\n- two',
  ctaUrl: 'https://example.invalid/notes',
  ctaLabel: 'Read the notes',
  publishedAt: null,
};

function show(item: Partial<AnnouncementItem> = {}) {
  const onDismiss = vi.fn();
  render(<AnnouncementBanner item={{ ...ITEM, ...item }} onDismiss={onDismiss} />);
  const banner = screen.getByText(item.title ?? ITEM.title).closest<HTMLElement>('.fixed')!;
  return { onDismiss, banner };
}

const levelClasses = (element: HTMLElement) => [...element.classList].filter((name) => name.startsWith('z-'));

afterEach(() => {
  cleanup();
  vi.mocked(openUrl).mockClear();
});

describe('AnnouncementBanner', () => {
  describe('what it shows', () => {
    it.each([
      ['version_update', () => t().announcement.typeVersionUpdate],
      ['feature', () => t().announcement.typeFeature],
      ['breaking', () => t().announcement.typeBreaking],
      ['general', () => t().announcement.typeGeneral],
    ] as const)('names the %s type', (type, label) => {
      const { banner } = show({ type });
      expect(banner).toHaveTextContent(label());
    });

    it('names an unknown type as a general notice', () => {
      const { banner } = show({ type: 'something-new' as AnnouncementItem['type'] });
      expect(banner).toHaveTextContent(t().announcement.typeGeneral);
    });

    it('shows the title and the body as markdown', () => {
      const { banner } = show();
      expect(screen.getByText(ITEM.title)).toBeInTheDocument();
      expect(screen.getByText('strong words').tagName).toBe('STRONG');
      expect(banner.querySelectorAll('.line-clamp-4 li')).toHaveLength(2);
    });

    it('shows no body when the item has none', () => {
      const { banner } = show({ body: null });
      expect(banner.querySelector('.line-clamp-4')).toBeNull();
      expect(banner.querySelectorAll('li')).toHaveLength(0);
    });

    it('labels the link with the item label, else with the default words', () => {
      show();
      expect(screen.getByRole('button', { name: ITEM.ctaLabel! })).toBeInTheDocument();
      cleanup();
      show({ ctaLabel: null });
      expect(screen.getByRole('button', { name: t().announcement.ctaDefault })).toBeInTheDocument();
    });

    it('offers no link when the item has no address', () => {
      show({ ctaUrl: null });
      expect(screen.queryByRole('button', { name: ITEM.ctaLabel! })).toBeNull();
      expect(screen.getAllByRole('button')).toHaveLength(2);
    });
  });

  describe('what its buttons do', () => {
    it('dismisses once from the corner button', () => {
      const { onDismiss } = show();
      fireEvent.click(screen.getAllByRole('button')[0]);
      expect(onDismiss).toHaveBeenCalledTimes(1);
      expect(openUrl).not.toHaveBeenCalled();
    });

    it('dismisses once from the dismiss button', () => {
      const { onDismiss } = show();
      fireEvent.click(screen.getByRole('button', { name: t().announcement.dismiss }));
      expect(onDismiss).toHaveBeenCalledTimes(1);
      expect(openUrl).not.toHaveBeenCalled();
    });

    it('opens the address from the link and stays', () => {
      const { onDismiss } = show();
      fireEvent.click(screen.getByRole('button', { name: ITEM.ctaLabel! }));
      expect(openUrl).toHaveBeenCalledTimes(1);
      expect(openUrl).toHaveBeenCalledWith(ITEM.ctaUrl);
      expect(onDismiss).not.toHaveBeenCalled();
    });
  });

  describe('where it sits', () => {
    it('keeps its corner and its width', () => {
      const { banner } = show();
      expect(banner).toHaveClass('fixed', 'bottom-6', 'right-6', 'w-80');
    });

    it('sits on the fullscreen level and on no other', () => {
      const { banner } = show();
      expect(levelClasses(banner)).toEqual(['z-fullscreen']);
    });

    it('opts out of the window drag lanes', () => {
      const { banner } = show();
      expect(banner).toHaveAttribute('data-electron-no-drag');
    });
  });

  describe('how it looks', () => {
    it('is an opaque raised box with a separator line', () => {
      const { banner } = show();
      expect(banner).toHaveClass('rounded-panel', 'border', 'border-separator', 'bg-raised', 'shadow-float');
    });

    it('names its corner button', () => {
      show();
      expect(screen.getAllByRole('button')[0]).toBe(screen.getByRole('button', { name: t().common.close }));
    });

    it.each([
      ['version_update', 'text-info', 'bg-info-soft'],
      ['feature', 'text-success', 'bg-success-soft'],
      ['breaking', 'text-danger', 'bg-danger-soft'],
    ] as const)('marks the %s type with its status color, on its soft fill, with a shape', (type, text, fill) => {
      const labels = { version_update: t().announcement.typeVersionUpdate, feature: t().announcement.typeFeature, breaking: t().announcement.typeBreaking };
      show({ type });
      const tag = screen.getByText(labels[type]);
      expect(tag).toHaveClass(text);
      expect(tag).toHaveClass(fill);
      expect(tag.querySelector('svg')).not.toBeNull();
    });

    it('marks a general notice with no status color', () => {
      show({ type: 'general' });
      const tag = screen.getByText(t().announcement.typeGeneral);
      expect(tag).toHaveClass('text-label-secondary');
      expect(tag.querySelector('svg')).toBeNull();
    });

    it('uses no legacy color variable', () => {
      const { banner } = show();
      expect(banner.outerHTML).not.toContain('--abu-');
    });
  });
});
