import { useEffect, useRef, useState } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { IconButton } from '@/components/ds/button';
import { AppIcons } from '@/components/ds/icons';
import { LoadError } from '@/components/ds/load-error';
import { Spinner } from '@/components/ds/spinner';
import { useI18n } from '@/i18n';
import { useAppStore, useSelectedApp } from '@/stores/appStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useNativeViewOcclusion } from '@/hooks/useNativeViewOcclusion';
import { APP_PAGE_STATE_EVENT, hideAppPages, reloadAppPage, setAppPageBounds, showAppPage, type AppPageStateEvent } from '@/core/app/appPageBridge';
import { resolveText } from '@/core/app/appBinding';

/**
 * The main-area host for an app's `url:` page. It owns a placeholder that
 * fills the area, streams the placeholder's rectangle to the main process
 * (`appPage.setBounds`) and hides the native view whenever a React overlay
 * would be painted under it (`useNativeViewOcclusion`). The page itself is a
 * `WebContentsView` the main process resolves from the app's own
 * configuration — nothing here knows or sends its URL.
 */
export default function AppPageView() {
  const { t } = useI18n();
  const app = useSelectedApp();
  const activePage = useAppStore((s) => s.activeAppPage);
  const viewMode = useSettingsStore((s) => s.viewMode);
  const occluded = useNativeViewOcclusion();
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<AppPageStateEvent | null>(null);
  const appId = app.origin === null ? null : app.appId;
  const navItemId = activePage?.appId === app.appId ? activePage.navItemId : null;
  const navItem = navItemId ? app.config.nav?.items.find((item) => item.id === navItemId) : undefined;
  const shouldShow = viewMode === 'app-page' && !occluded && appId !== null && navItemId !== null;

  useEffect(() => {
    if (!appId || !navItemId) return;
    let unlisten: UnlistenFn | undefined;
    let disposed = false;
    void listen<AppPageStateEvent>(APP_PAGE_STATE_EVENT, (event) => {
      if (event.payload.appId === appId && event.payload.navItemId === navItemId) setState(event.payload);
    }).then((stop) => { if (disposed) stop(); else unlisten = stop; });
    return () => { disposed = true; unlisten?.(); };
  }, [appId, navItemId]);

  useEffect(() => {
    const element = containerRef.current;
    if (!shouldShow || !element || !appId || !navItemId) {
      void hideAppPages();
      return;
    }
    const bounds = () => {
      const rect = element.getBoundingClientRect();
      return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
    };
    let shown = false;
    const sync = () => {
      const next = bounds();
      if (!shown) {
        shown = true;
        void showAppPage(appId, navItemId, next);
        return;
      }
      void setAppPageBounds(appId, navItemId, next);
    };
    sync();
    const observer = new ResizeObserver(() => sync());
    observer.observe(element);
    window.addEventListener('resize', sync);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', sync);
      void hideAppPages();
    };
  }, [shouldShow, appId, navItemId]);

  return (
    <div className="flex h-full flex-col" data-testid="app-page-view" data-nav-item={navItemId ?? undefined}>
      {/* h-11: the native page's rectangle starts right under this row. */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-separator px-4">
        <span className="min-w-0 flex-1 truncate text-ui font-medium text-label">
          {navItem?.title === undefined ? app.name : resolveText(navItem.title)}
        </span>
        {state?.state === 'loading' && <Spinner size="sm" label={t.common.loading} labelHidden />}
        {appId && navItemId && (
          // The tooltip opens beside the button, inside this row: below it the native page is
          // painted over everything the app draws, and above it the window ends.
          <IconButton size="sm" icon={AppIcons.reload} label={t.common.retry} tooltipSide="left" onClick={() => { void reloadAppPage(appId, navItemId); }} />
        )}
      </div>
      <div ref={containerRef} className="relative min-h-0 flex-1 bg-surface">
        {state?.state === 'failed' && (
          <div data-testid="app-page-failed" className="absolute inset-0 flex flex-col items-center justify-center">
            {appId && navItemId
              ? <LoadError reason={state.errorDescription} onRetry={() => { void reloadAppPage(appId, navItemId); }} />
              // No page is selected any more: the reason stays, with nothing to retry.
              : <p role="alert" className="max-w-96 px-6 text-center text-ui text-label">{state.errorDescription}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
