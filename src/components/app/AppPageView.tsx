import { useEffect, useRef, useState } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { Loader2, RotateCw } from 'lucide-react';
import { useI18n } from '@/i18n';
import { useAppStore, useSelectedApp } from '@/stores/appStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useNativeViewOcclusion } from '@/hooks/useNativeViewOcclusion';
import { APP_PAGE_STATE_EVENT, hideAppPages, reloadAppPage, setAppPageBounds, showAppPage, type AppPageStateEvent } from '@/core/app/appPageBridge';
import { resolveText } from '@/core/app/appBinding';
import { Button } from '@/components/ui/button';

/**
 * The main-area host for an app's `url:` page. It owns a placeholder that
 * fills the area, streams the placeholder's rectangle to the main process
 * (`appPage.setBounds`) and hides the native view whenever a React overlay
 * would be painted under it (`useNativeViewOcclusion`). The page itself is a
 * `WebContentsView` the main process resolves from the installed package —
 * nothing here knows or sends its URL.
 */
export default function AppPageView() {
  const { t } = useI18n();
  const app = useSelectedApp();
  const activePage = useAppStore((s) => s.activeAppPage);
  const viewMode = useSettingsStore((s) => s.viewMode);
  const occluded = useNativeViewOcclusion();
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<AppPageStateEvent | null>(null);
  const pluginKey = app.pluginKey;
  const navItemId = activePage?.appId === app.appId ? activePage.navItemId : null;
  const navItem = navItemId ? app.config.nav?.items.find((item) => item.id === navItemId) : undefined;
  const shouldShow = viewMode === 'app-page' && !occluded && pluginKey !== null && navItemId !== null;

  useEffect(() => {
    if (!pluginKey || !navItemId) return;
    let unlisten: UnlistenFn | undefined;
    let disposed = false;
    void listen<AppPageStateEvent>(APP_PAGE_STATE_EVENT, (event) => {
      if (event.payload.pluginKey === pluginKey && event.payload.navItemId === navItemId) setState(event.payload);
    }).then((stop) => { if (disposed) stop(); else unlisten = stop; });
    return () => { disposed = true; unlisten?.(); };
  }, [pluginKey, navItemId]);

  useEffect(() => {
    const element = containerRef.current;
    if (!shouldShow || !element || !pluginKey || !navItemId) {
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
        void showAppPage(pluginKey, navItemId, next);
        return;
      }
      void setAppPageBounds(pluginKey, navItemId, next);
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
  }, [shouldShow, pluginKey, navItemId]);

  return (
    <div className="flex h-full flex-col" data-testid="app-page-view" data-nav-item={navItemId ?? undefined}>
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--abu-border)] px-4">
        <span className="min-w-0 flex-1 truncate text-body font-medium text-[var(--abu-text-primary)]">
          {navItem?.title === undefined ? app.name : resolveText(navItem.title)}
        </span>
        {state?.state === 'loading' && <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--abu-text-muted)]" />}
        {pluginKey && navItemId && (
          <Button size="icon-sm" variant="ghost" aria-label={t.common.retry} onClick={() => { void reloadAppPage(pluginKey, navItemId); }}>
            <RotateCw className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      <div ref={containerRef} className="relative min-h-0 flex-1 bg-[var(--abu-bg-base)]">
        {state?.state === 'failed' && (
          <div data-testid="app-page-failed" className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-8 text-center">
            <p className="text-body text-[var(--abu-text-secondary)]">{state.errorDescription}</p>
            {pluginKey && navItemId && (
              <Button variant="outline" size="sm" onClick={() => { void reloadAppPage(pluginKey, navItemId); }}>{t.common.retry}</Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
