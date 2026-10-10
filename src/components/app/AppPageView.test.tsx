// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { listen } from '@tauri-apps/api/event';
import { DesignSystemProvider } from '@/components/ds/provider';
import { APP_PAGE_STATE_EVENT, hideAppPages, reloadAppPage, setAppPageBounds, showAppPage, type AppPageStateEvent } from '@/core/app/appPageBridge';
import { DEFAULT_APP_CONFIG } from '@/data/defaultAppConfig';
import { useNativeViewOcclusion } from '@/hooks/useNativeViewOcclusion';
import { getI18n } from '@/i18n';
import { useAppStore } from '@/stores/appStore';
import { useSettingsStore } from '@/stores/settingsStore';
import type { AppDefinition } from '@/types/app';
import AppPageView from './AppPageView';

// The native page lives in the main process: the bridge calls are written down, none is sent.
vi.mock('@/core/app/appPageBridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/app/appPageBridge')>()),
  showAppPage: vi.fn(async () => undefined),
  setAppPageBounds: vi.fn(async () => undefined),
  hideAppPages: vi.fn(async () => undefined),
  reloadAppPage: vi.fn(async () => undefined),
}));
vi.mock('@/hooks/useNativeViewOcclusion', () => ({ useNativeViewOcclusion: vi.fn(() => false) }));

const t = () => getI18n();
const APP_ID = 'shop@org';

const shop: AppDefinition = {
  appId: APP_ID,
  name: 'Shop desk',
  version: '1.0.0',
  origin: { kind: 'market', market: 'org' },
  plugins: [],
  config: {
    ...DEFAULT_APP_CONFIG,
    nav: {
      items: [
        { id: 'portal', title: 'Order portal', target: 'url:https://portal.example.test/' },
        { id: 'untitled', target: 'url:https://untitled.example.test/' },
      ],
    },
  },
};

// The rectangle the page's placeholder reports, and the observers watching it.
let rect = { left: 220, top: 52, width: 800, height: 600 };
const observers: { callback: () => void; watching: Element[]; disconnected: boolean }[] = [];
class RecordedResizeObserver {
  private readonly record: (typeof observers)[number];
  constructor(callback: () => void) {
    this.record = { callback, watching: [], disconnected: false };
    observers.push(this.record);
  }
  observe(element: Element) { this.record.watching.push(element); }
  unobserve() { /* the page never stops watching one element */ }
  disconnect() { this.record.disconnected = true; }
}

// What the main process says about a page, delivered to whoever listens.
type Listener = (event: { payload: AppPageStateEvent }) => void;
const listeners = new Set<Listener>();
function say(state: AppPageStateEvent['state'], more: Partial<AppPageStateEvent> = {}) {
  act(() => {
    for (const listener of listeners) listener({ payload: { appId: APP_ID, navItemId: 'portal', state, ...more } });
  });
}

const show = () => render(<AppPageView />, { wrapper: DesignSystemProvider });
// Lets the listener registration (a promise) finish.
async function shown() {
  const view = show();
  await act(async () => { await Promise.resolve(); });
  return view;
}
const view = () => screen.getByTestId('app-page-view');
const boundsNow = () => ({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });

describe('AppPageView', () => {
  beforeEach(() => {
    rect = { left: 220, top: 52, width: 800, height: 600 };
    observers.length = 0;
    listeners.clear();
    vi.stubGlobal('ResizeObserver', RecordedResizeObserver);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
      ...rect, x: rect.left, y: rect.top, right: rect.left + rect.width, bottom: rect.top + rect.height, toJSON: () => rect,
    }));
    vi.mocked(listen).mockImplementation(async (name, handler) => {
      if (name !== APP_PAGE_STATE_EVENT) return () => undefined;
      const listener = handler as unknown as Listener;
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    });
    vi.mocked(useNativeViewOcclusion).mockReturnValue(false);
    for (const call of [showAppPage, setAppPageBounds, hideAppPages, reloadAppPage]) vi.mocked(call).mockClear();
    useAppStore.setState({ addedApps: [shop], selectedAppId: APP_ID, activeAppPage: { appId: APP_ID, navItemId: 'portal' } });
    useSettingsStore.setState({ viewMode: 'app-page' });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.mocked(listen).mockReset();
    vi.mocked(listen).mockResolvedValue(() => undefined);
    useAppStore.setState({ addedApps: [], selectedAppId: '__general__', activeAppPage: null });
    useSettingsStore.setState({ viewMode: 'chat' });
  });

  describe('the native page', () => {
    it('is shown in the rectangle of the placeholder under the header', () => {
      show();
      expect(vi.mocked(showAppPage).mock.calls).toEqual([[APP_ID, 'portal', boundsNow()]]);
      expect(hideAppPages).not.toHaveBeenCalled();
      expect(setAppPageBounds).not.toHaveBeenCalled();
      expect(observers).toHaveLength(1);
      expect(observers[0].watching).toHaveLength(1);
      // The placeholder is what is measured: the area below the header row.
      expect(observers[0].watching[0].parentElement).toBe(view());
      expect(observers[0].watching[0].previousElementSibling).toHaveClass('h-11');
    });

    it('follows the placeholder when it or the window changes size', () => {
      show();
      rect = { left: 220, top: 52, width: 640, height: 480 };
      act(() => observers[0].callback());
      expect(vi.mocked(setAppPageBounds).mock.calls).toEqual([[APP_ID, 'portal', boundsNow()]]);
      rect = { left: 8, top: 52, width: 1000, height: 700 };
      fireEvent(window, new Event('resize'));
      expect(vi.mocked(setAppPageBounds).mock.calls[1]).toEqual([APP_ID, 'portal', boundsNow()]);
      expect(showAppPage).toHaveBeenCalledTimes(1);
    });

    it('is hidden when the view leaves, which also stops the watching', () => {
      const { unmount } = show();
      unmount();
      expect(hideAppPages).toHaveBeenCalledTimes(1);
      expect(observers[0].disconnected).toBe(true);
      vi.mocked(setAppPageBounds).mockClear();
      fireEvent(window, new Event('resize'));
      expect(setAppPageBounds).not.toHaveBeenCalled();
    });

    it('is hidden while a window of the app would be painted under it, and shown again after', () => {
      vi.mocked(useNativeViewOcclusion).mockReturnValue(true);
      const { rerender } = show();
      expect(showAppPage).not.toHaveBeenCalled();
      expect(hideAppPages).toHaveBeenCalledTimes(1);
      expect(observers).toHaveLength(0);

      vi.mocked(useNativeViewOcclusion).mockReturnValue(false);
      rerender(<AppPageView />);
      expect(vi.mocked(showAppPage).mock.calls).toEqual([[APP_ID, 'portal', boundsNow()]]);

      vi.mocked(useNativeViewOcclusion).mockReturnValue(true);
      rerender(<AppPageView />);
      expect(hideAppPages).toHaveBeenCalledTimes(3);
      expect(observers[0].disconnected).toBe(true);
    });

    it('is hidden when another view is in the main area', () => {
      useSettingsStore.setState({ viewMode: 'chat' });
      show();
      expect(showAppPage).not.toHaveBeenCalled();
      expect(hideAppPages).toHaveBeenCalledTimes(1);
    });

    it('is not asked for when the general shell is selected', () => {
      useAppStore.setState({ selectedAppId: '__general__' });
      show();
      expect(showAppPage).not.toHaveBeenCalled();
      expect(hideAppPages).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('button', { name: t().common.retry })).toBeNull();
      expect(view()).not.toHaveAttribute('data-nav-item');
    });
  });

  describe('the header', () => {
    it('names the page, and the app when the page has no title', () => {
      show();
      expect(view()).toHaveAttribute('data-nav-item', 'portal');
      expect(screen.getByText('Order portal')).toBeInTheDocument();
      act(() => useAppStore.setState({ activeAppPage: { appId: APP_ID, navItemId: 'untitled' } }));
      expect(view()).toHaveAttribute('data-nav-item', 'untitled');
      expect(screen.getByText('Shop desk')).toBeInTheDocument();
    });

    it('reloads the page from its retry button', () => {
      show();
      fireEvent.click(screen.getByRole('button', { name: t().common.retry }));
      expect(vi.mocked(reloadAppPage).mock.calls).toEqual([[APP_ID, 'portal']]);
    });
  });

  describe('a page that failed to load', () => {
    it('shows why, with a retry that reloads it', async () => {
      await shown();
      expect(screen.queryByTestId('app-page-failed')).toBeNull();
      say('failed', { errorDescription: 'ERR_NAME_NOT_RESOLVED' });
      const failed = within(screen.getByTestId('app-page-failed'));
      expect(failed.getByText('ERR_NAME_NOT_RESOLVED')).toBeInTheDocument();
      fireEvent.click(failed.getByRole('button', { name: t().common.retry }));
      expect(vi.mocked(reloadAppPage).mock.calls).toEqual([[APP_ID, 'portal']]);
    });

    it('clears the failure once the page loads', async () => {
      await shown();
      say('failed', { errorDescription: 'ERR_NAME_NOT_RESOLVED' });
      say('ready');
      expect(screen.queryByTestId('app-page-failed')).toBeNull();
    });

    it('ignores what is said about another page', async () => {
      await shown();
      say('failed', { navItemId: 'untitled', errorDescription: 'ERR_OTHER_PAGE' });
      say('failed', { appId: 'hr@org', errorDescription: 'ERR_OTHER_APP' });
      expect(screen.queryByTestId('app-page-failed')).toBeNull();
    });

    it('stops listening when the view leaves', async () => {
      const { unmount } = await shown();
      expect(listeners.size).toBe(1);
      unmount();
      expect(listeners.size).toBe(0);
    });
  });

  describe('on the design system', () => {
    it('shows one spinner that says it is loading, beside the title, and none once the page is ready', async () => {
      await shown();
      expect(document.querySelectorAll('[data-ds-spinner]')).toHaveLength(0);
      say('loading');
      expect(document.querySelectorAll('[data-ds-spinner]')).toHaveLength(1);
      expect(screen.getByRole('status')).toHaveTextContent(t().common.loading);
      // The words are for screen readers: only the icon fits beside the title.
      expect(screen.getByText(t().common.loading)).toHaveClass('sr-only');
      say('ready');
      expect(document.querySelectorAll('[data-ds-spinner]')).toHaveLength(0);
    });

    it('reports a failed page as an alert with the reason and a retry', async () => {
      await shown();
      say('failed', { errorDescription: 'ERR_NAME_NOT_RESOLVED' });
      const alert = within(screen.getByTestId('app-page-failed')).getByRole('alert');
      expect(alert).toHaveTextContent('ERR_NAME_NOT_RESOLVED');
      expect(within(alert).getByRole('button', { name: t().common.retry })).toBeInTheDocument();
    });

    it('shows the name of the header retry button when the keyboard reaches it', () => {
      show();
      const retry = screen.getByRole('button', { name: t().common.retry });
      fireEvent.keyDown(document.body, { key: 'Tab' });
      retry.focus();
      fireEvent.focus(retry);
      expect(screen.getByRole('tooltip')).toHaveTextContent(t().common.retry);
    });

    it('keeps the header 44px high: the native page starts right under it', () => {
      show();
      const header = view().firstElementChild as HTMLElement;
      expect(header).toHaveClass('h-11');
      expect(header).toHaveClass('border-separator');
      expect(screen.getByText('Order portal')).toHaveClass('text-ui');
    });
  });
});
