import { useEffect, useRef, useState, useCallback } from 'react';
import { ArrowLeft, ArrowRight, RotateCw, AppWindow, Compass, SquareDashedMousePointer } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { openUrl } from '@tauri-apps/plugin-opener';
import { usePreviewStore } from '@/stores/previewStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useChatStore } from '@/stores/chatStore';
import { useI18n } from '@/i18n';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { createLogger } from '@/core/logging/logger';
import { normalizeBrowserUrl } from '@/utils/browserUrl';
import { cn } from '@/lib/utils';
import { isMacOS } from '@/utils/platform';
import { createDomElementReference, type BrowserElementPayload } from '@/types/chatReference';

const browserLogger = createLogger('browser-tab');

function resolveInspectTheme() {
  const styles = getComputedStyle(document.documentElement);
  const read = (name: string) => styles.getPropertyValue(name).trim();
  return {
    bgBase: read('--abu-bg-base'),
    bgHover: read('--abu-bg-hover'),
    borderSubtle: read('--abu-border-subtle'),
    textPrimary: read('--abu-text-primary'),
    textTertiary: read('--abu-text-tertiary'),
    danger: read('--abu-danger'),
  };
}

/**
 * In-app browser tab backed by a REAL native child webview (`browser.rs` /
 * Tauri `add_child`), not an iframe — so it can load ANY site (Google, GitHub,
 * banks…) without hitting `X-Frame-Options` / CSP `frame-ancestors`.
 *
 * The native webview is a layer painted OVER the React UI at pixel coordinates
 * (it ignores CSS z-index/display). This component owns a placeholder `<div>`
 * and continuously streams its viewport rect to the backend
 * (`browser_set_bounds`); it hides the webview whenever the placeholder is not
 * visible (inactive/keep-alive-hidden tab, collapsed panel) or a full-window
 * modal is up (settings) — since CSS-hiding the placeholder is invisible to
 * the native layer. The webview is created lazily on first navigation, so the
 * empty "start" state shows a normal React prompt underneath.
 */
export default function BrowserTab({ tabId, url }: { tabId: string; url: string }) {
  const { t } = useI18n();
  const updateBrowserUrl = usePreviewStore((s) => s.updateBrowserUrl);
  // A full-window React overlay would be painted UNDER the native webview, so
  // force-hide the webview while settings is open.
  const systemSettingsOpen = useSettingsStore((s) => s.systemSettingsOpen);
  // A workspace popover (tab-strip menu) is also a React overlay the native
  // webview would paint over — hide while one is up.
  const menuOpen = usePreviewStore((s) => s.menuOpen);

  const [addressInput, setAddressInput] = useState(url);
  const [committedUrl, setCommittedUrl] = useState(url);
  const [inspecting, setInspecting] = useState(false);

  const inspectLabels = {
    addToChat: t.reference.addToChat,
    commentToChat: t.reference.commentToChat,
    commentPlaceholder: t.reference.commentPlaceholder,
    cancel: t.common.cancel,
    shortcutModifier: isMacOS() ? '⌘' : 'Ctrl',
    theme: resolveInspectTheme(),
  };
  const inspectLabelsRef = useRef(inspectLabels);
  useEffect(() => {
    inspectLabelsRef.current = inspectLabels;
  });
  const inspectingRef = useRef(inspecting);
  useEffect(() => {
    inspectingRef.current = inspecting;
  }, [inspecting]);

  const containerRef = useRef<HTMLDivElement>(null);
  const addressInputRef = useRef<HTMLInputElement>(null);
  const createdRef = useRef(false); // has the native webview been created?
  const shownRef = useRef(false);   // is it currently shown?
  const lastBoundsRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  // Holds the initial URL for the mount effect (read once); never reassigned
  // during render (that would trip react-hooks/refs).
  const committedUrlRef = useRef(committedUrl);

  // Push the placeholder's current rect to the native webview, and show/hide it
  // based on visibility. Cheap: only invokes when something actually changed.
  const syncBounds = useCallback(() => {
    if (!createdRef.current) return;
    const el = containerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // A CSS-hidden ancestor (inactive keep-alive tab) yields a zero rect; a
    // full-window modal should also force-hide even though the rect is valid.
    const visible =
      r.width >= 1 && r.height >= 1 && el.offsetParent !== null && !systemSettingsOpen && !menuOpen;

    if (!visible) {
      if (shownRef.current) {
        shownRef.current = false;
        void invoke('browser_hide', { id: tabId }).catch(() => {});
      }
      return;
    }
    const next = { x: r.left, y: r.top, w: r.width, h: r.height };
    const prev = lastBoundsRef.current;
    if (!prev || prev.x !== next.x || prev.y !== next.y || prev.w !== next.w || prev.h !== next.h) {
      lastBoundsRef.current = next;
      void invoke('browser_set_bounds', { id: tabId, x: next.x, y: next.y, width: next.w, height: next.h }).catch(() => {});
    }
    if (!shownRef.current) {
      shownRef.current = true;
      void invoke('browser_show', { id: tabId }).catch(() => {});
    }
  }, [tabId, systemSettingsOpen, menuOpen]);

  // Create (lazily) the native webview for `committedUrl`, or navigate an
  // existing one. Called on first commit and on subsequent address changes.
  const ensureWebview = useCallback(
    async (targetUrl: string) => {
      const el = containerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      try {
        if (!createdRef.current) {
          createdRef.current = true;
          await invoke('browser_create', {
            id: tabId,
            url: targetUrl,
            x: r.left,
            y: r.top,
            width: Math.max(r.width, 1),
            height: Math.max(r.height, 1),
          });
          lastBoundsRef.current = { x: r.left, y: r.top, w: r.width, h: r.height };
          shownRef.current = true;
        } else {
          await invoke('browser_navigate', { id: tabId, url: targetUrl });
        }
        syncBounds();
      } catch (err) {
        createdRef.current = false;
        browserLogger.error('Failed to create/navigate browser webview', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [tabId, syncBounds],
  );

  // Mount: if the tab already carries a URL, create the webview immediately
  // (keep-alive — a background tab still loads). Listen for real navigations
  // (link clicks / redirects) to keep the address bar in sync.
  useEffect(() => {
    let navUnlisten: UnlistenFn | undefined;
    let elementUnlisten: UnlistenFn | undefined;
    let disposed = false;

    (async () => {
      const unlisten = await listen<string>(`browser://nav/${tabId}`, (e) => {
        const u = e.payload;
        if (u && u !== 'about:blank') {
          setAddressInput(u);
          setCommittedUrl(u);
          updateBrowserUrl(tabId, u);
        }
        if (inspectingRef.current) setInspecting(false);
      });
      if (disposed) {
        unlisten();
        return;
      }
      navUnlisten = unlisten;
    })();

    (async () => {
      const unlisten = await listen<BrowserElementPayload>(`browser://element/${tabId}`, (e) => {
        useChatStore.getState().addPendingReference(createDomElementReference(e.payload));
        setInspecting(false);
        void invoke('browser_inspect_set', { id: tabId, enabled: false, labels: inspectLabelsRef.current }).catch(() => {});
      });
      if (disposed) {
        unlisten();
        return;
      }
      elementUnlisten = unlisten;
    })();

    if (committedUrlRef.current) {
      void ensureWebview(normalizeBrowserUrl(committedUrlRef.current));
    } else {
      addressInputRef.current?.focus();
    }

    return () => {
      disposed = true;
      navUnlisten?.();
      elementUnlisten?.();
      void invoke('browser_close', { id: tabId }).catch(() => {});
      createdRef.current = false;
      shownRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  // Keep the webview glued to the placeholder as layout changes (splitter drag,
  // window resize, panel collapse), and re-evaluate visibility on tab switch /
  // settings open. A light interval is the safety net for position-only shifts
  // that a ResizeObserver (size-only) misses.
  useEffect(() => {
    syncBounds();
    const ro = new ResizeObserver(() => syncBounds());
    if (containerRef.current) ro.observe(containerRef.current);
    window.addEventListener('resize', syncBounds);
    const interval = window.setInterval(syncBounds, 250);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', syncBounds);
      window.clearInterval(interval);
    };
  }, [syncBounds, systemSettingsOpen]);

  useEffect(() => {
    if (!inspecting || !(systemSettingsOpen || menuOpen)) return;
    setInspecting(false);
    void invoke('browser_inspect_set', { id: tabId, enabled: false, labels: inspectLabelsRef.current }).catch(() => {});
  }, [inspecting, menuOpen, systemSettingsOpen, tabId]);

  const toggleInspect = useCallback(async () => {
    const next = !inspecting;
    setInspecting(next);
    try {
      await invoke('browser_inspect_set', { id: tabId, enabled: next, labels: inspectLabelsRef.current });
    } catch (err) {
      setInspecting(!next);
      browserLogger.error('Failed to toggle browser inspect mode', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, [inspecting, tabId]);

  const commit = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const normalized = normalizeBrowserUrl(trimmed);
    setAddressInput(normalized);
    setCommittedUrl(normalized);
    updateBrowserUrl(tabId, normalized);
    void ensureWebview(normalized);
  };

  const handleOpenExternal = async () => {
    if (!committedUrl) return;
    try {
      await openUrl(committedUrl);
    } catch (err) {
      browserLogger.error('Failed to open URL in system browser', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1.5 shrink-0 px-2 py-1.5 border-b border-[var(--abu-bg-pressed)] bg-[var(--abu-bg-subtle)]">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs" disabled={!committedUrl} onClick={() => void invoke('browser_back', { id: tabId }).catch(() => {})} className="text-[var(--abu-text-tertiary)]">
              <ArrowLeft className="w-3.5 h-3.5" strokeWidth={1.5} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t.workspace.browser.back}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs" disabled={!committedUrl} onClick={() => void invoke('browser_forward', { id: tabId }).catch(() => {})} className="text-[var(--abu-text-tertiary)]">
              <ArrowRight className="w-3.5 h-3.5" strokeWidth={1.5} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t.workspace.browser.forward}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs" disabled={!committedUrl} onClick={() => void invoke('browser_reload', { id: tabId }).catch(() => {})} className="text-[var(--abu-text-tertiary)]">
              <RotateCw className="w-3.5 h-3.5" strokeWidth={1.5} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t.workspace.browser.reload}</TooltipContent>
        </Tooltip>

        <Input
          ref={addressInputRef}
          value={addressInput}
          placeholder={t.workspace.browser.addressPlaceholder}
          onChange={(e) => setAddressInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit(addressInput);
          }}
          className="flex-1 h-7 text-minor"
        />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs" disabled={!committedUrl} onClick={() => void handleOpenExternal()} className="text-[var(--abu-text-tertiary)]">
              <Compass className="w-3.5 h-3.5" strokeWidth={1.5} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t.workspace.browser.openExternal}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={!committedUrl}
              onClick={() => void toggleInspect()}
              className={cn(inspecting ? 'text-[var(--abu-clay)] bg-[var(--abu-clay-bg)]' : 'text-[var(--abu-text-tertiary)]')}
            >
              <SquareDashedMousePointer className="w-3.5 h-3.5" strokeWidth={1.5} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t.workspace.browser.selectElement}</TooltipContent>
        </Tooltip>
      </div>

      {/* Placeholder the native webview is positioned over. When there's no URL
          yet, no webview exists, so this React start prompt is visible. */}
      <div ref={containerRef} className="flex-1 min-h-0 bg-white">
        {!committedUrl && (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-center p-4">
            <AppWindow className="w-6 h-6 text-[var(--abu-text-tertiary)]" strokeWidth={1.5} />
            <p className="text-body font-medium text-[var(--abu-text-secondary)]">{t.workspace.browser.startPrompt}</p>
          </div>
        )}
      </div>
    </div>
  );
}
