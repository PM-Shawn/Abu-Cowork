import { useEffect, useRef, useState, useCallback, useSyncExternalStore } from 'react';
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
import { ToolbarTooltip } from '@/components/panel/workspace/ToolbarTooltip';
import { createLogger } from '@/core/logging/logger';
import { normalizeBrowserUrl } from '@/utils/browserUrl';
import { hasVisibleBlockingApproval } from '@/core/browser/nativeBrowserVisibility';
import {
  getPendingCommandConfirmation,
  getPendingFilePermission,
  getPendingWorkspaceRequest,
  subscribeToCommandConfirmation,
  subscribeToFilePermission,
  subscribeToWorkspaceRequest,
} from '@/core/agent/permissionBridge';
import {
  getPendingCapabilitySetup,
  subscribeCapabilitySetup,
} from '@/core/capabilityPlugins/setupBridge';
import { cn } from '@/lib/utils';
import { isMacOS } from '@/utils/platform';
import { hasElectronCommandHost } from '@/utils/electronHost';
import { isTauriEnv } from '@/utils/tauriEnv';
import { createDomElementReference, type BrowserElementPayload } from '@/types/chatReference';

const browserLogger = createLogger('browser-tab');
const BROWSER_CREATE_RETRY_DELAYS_MS = [250, 500, 1_000] as const;

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
  // App-global modals (close-window dialog) sit above the chat column but the
  // native webview would still paint over them — treat like a blocking approval.
  const appModalOpen = usePreviewStore((s) => s.appModalOpen);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const commandApproval = useSyncExternalStore(
    subscribeToCommandConfirmation,
    getPendingCommandConfirmation,
  );
  const fileApproval = useSyncExternalStore(
    subscribeToFilePermission,
    getPendingFilePermission,
  );
  const workspaceApproval = useSyncExternalStore(
    subscribeToWorkspaceRequest,
    getPendingWorkspaceRequest,
  );
  const capabilitySetup = useSyncExternalStore(
    subscribeCapabilitySetup,
    getPendingCapabilitySetup,
  );
  const blockingApprovalOpen = hasVisibleBlockingApproval(
    activeConversationId,
    [commandApproval, fileApproval, workspaceApproval],
    capabilitySetup !== null || appModalOpen,
  );

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
  const desiredVisibleRef = useRef(false);
  const visibilityOperationRef = useRef<Promise<void> | null>(null);
  const createRetryCountRef = useRef(0);
  const createRetryTimerRef = useRef<number | null>(null);
  const navigationGenerationRef = useRef(0);
  const retryCreateRef = useRef<(targetUrl: string, generation: number) => void>(() => {});
  const lastBoundsRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  // Holds the initial URL for the mount effect (read once); never reassigned
  // during render (that would trip react-hooks/refs).
  const committedUrlRef = useRef(committedUrl);

  // Freeze-frame shown while the native view is hidden for an overlay. The
  // native view paints above React, so hiding it for a modal/menu would flash
  // the pane to blank white; capturing the last frame first keeps the page
  // visually "under" the overlay (Claude desktop's warm-capture approach).
  // null while the native view is visible.
  const [freezeFrame, setFreezeFrame] = useState<string | null>(null);

  // Reconcile visibility serially. IPC failures leave `shownRef` unchanged so
  // the interval below retries instead of permanently believing the view moved.
  const reconcileNativeVisibility = useCallback(() => {
    if (!createdRef.current || visibilityOperationRef.current) return;

    const operation = (async () => {
      while (createdRef.current) {
        const desired = desiredVisibleRef.current;
        if (shownRef.current === desired) return;
        if (!desired) {
          // Capture BEFORE hiding — a hidden view has no compositor frame.
          // Best-effort: a null capture just falls back to the blank pane.
          try {
            const frame = await invoke<string | null>('browser_capture', { id: tabId });
            if (typeof frame === 'string' && frame.startsWith('data:image/')) {
              setFreezeFrame(frame);
            }
          } catch {
            /* keep whatever frame we already have */
          }
          if (!createdRef.current) return;
          // Overlay may have closed while capturing — re-check before hiding.
          if (desiredVisibleRef.current !== desired) continue;
        }
        try {
          await invoke(desired ? 'browser_show' : 'browser_hide', { id: tabId });
        } catch {
          return;
        }
        if (!createdRef.current) return;
        shownRef.current = desired;
        if (desired) setFreezeFrame(null);
      }
    })();
    visibilityOperationRef.current = operation;
    void operation.finally(() => {
      if (visibilityOperationRef.current === operation) {
        visibilityOperationRef.current = null;
      }
    });
  }, [tabId]);

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
      r.width >= 1
      && r.height >= 1
      && el.offsetParent !== null
      && !systemSettingsOpen
      && !menuOpen
      && !blockingApprovalOpen;

    desiredVisibleRef.current = visible;
    reconcileNativeVisibility();
    if (!visible) {
      return;
    }
    const next = { x: r.left, y: r.top, w: r.width, h: r.height };
    const prev = lastBoundsRef.current;
    if (!prev || prev.x !== next.x || prev.y !== next.y || prev.w !== next.w || prev.h !== next.h) {
      lastBoundsRef.current = next;
      void invoke('browser_set_bounds', { id: tabId, x: next.x, y: next.y, width: next.w, height: next.h }).catch(() => {});
    }
  }, [
    tabId,
    systemSettingsOpen,
    menuOpen,
    blockingApprovalOpen,
    reconcileNativeVisibility,
  ]);

  // Create (lazily) the native webview for `committedUrl`, or navigate an
  // existing one. Called on first commit and on subsequent address changes.
  const ensureWebview = useCallback(
    async (targetUrl: string, generation: number) => {
      const el = containerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      try {
        if (!createdRef.current) {
          createdRef.current = true;
          const initiallyVisible =
            r.width >= 1
            && r.height >= 1
            && el.offsetParent !== null
            && !systemSettingsOpen
            && !menuOpen
            && !blockingApprovalOpen;
          const electronHost = hasElectronCommandHost();
          desiredVisibleRef.current = initiallyVisible;
          // Electron can create the native child view hidden, preventing even a
          // single frame from painting above a dialog that was already open.
          // Tauri keeps its historical create-then-hide contract.
          shownRef.current = electronHost ? initiallyVisible : true;
          await invoke('browser_create', {
            id: tabId,
            url: targetUrl,
            x: r.left,
            y: r.top,
            width: Math.max(r.width, 1),
            height: Math.max(r.height, 1),
            ...(electronHost ? { visible: initiallyVisible } : {}),
          });
          lastBoundsRef.current = { x: r.left, y: r.top, w: r.width, h: r.height };
          if (generation === navigationGenerationRef.current) {
            createRetryCountRef.current = 0;
          }
          reconcileNativeVisibility();
        } else {
          await invoke('browser_navigate', { id: tabId, url: targetUrl });
        }
        syncBounds();
      } catch (err) {
        if (generation !== navigationGenerationRef.current) return;
        createdRef.current = false;
        shownRef.current = false;
        const retryIndex = createRetryCountRef.current;
        if (
          retryIndex < BROWSER_CREATE_RETRY_DELAYS_MS.length
          && createRetryTimerRef.current === null
        ) {
          createRetryCountRef.current += 1;
          createRetryTimerRef.current = window.setTimeout(() => {
            createRetryTimerRef.current = null;
            if (generation === navigationGenerationRef.current) {
              retryCreateRef.current(targetUrl, generation);
            }
          }, BROWSER_CREATE_RETRY_DELAYS_MS[retryIndex]);
        }
        browserLogger.error('Failed to create/navigate browser webview', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [
      tabId,
      syncBounds,
      reconcileNativeVisibility,
      systemSettingsOpen,
      menuOpen,
      blockingApprovalOpen,
    ],
  );

  useEffect(() => {
    retryCreateRef.current = (targetUrl, generation) => {
      void ensureWebview(targetUrl, generation);
    };
    return () => {
      retryCreateRef.current = () => {};
    };
  }, [ensureWebview]);

  const startWebviewNavigation = useCallback((targetUrl: string) => {
    navigationGenerationRef.current += 1;
    const generation = navigationGenerationRef.current;
    createRetryCountRef.current = 0;
    if (createRetryTimerRef.current !== null) {
      window.clearTimeout(createRetryTimerRef.current);
      createRetryTimerRef.current = null;
    }
    void ensureWebview(targetUrl, generation);
  }, [ensureWebview]);

  // Mount: if the tab already carries a URL, create the webview immediately
  // (keep-alive — a background tab still loads). Listen for real navigations
  // (link clicks / redirects) to keep the address bar in sync.
  useEffect(() => {
    // Tauri and the Electron compatibility preload both inject
    // __TAURI_INTERNALS__. Plain web/E2E mode has no native event bridge, so
    // keep the empty browser surface usable without registering listeners
    // that would otherwise reject outside a desktop host.
    if (!isTauriEnv()) {
      addressInputRef.current?.focus();
      return;
    }

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
      startWebviewNavigation(normalizeBrowserUrl(committedUrlRef.current));
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
      desiredVisibleRef.current = false;
      visibilityOperationRef.current = null;
      if (createRetryTimerRef.current !== null) {
        window.clearTimeout(createRetryTimerRef.current);
        createRetryTimerRef.current = null;
      }
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
  }, [syncBounds, systemSettingsOpen, blockingApprovalOpen]);

  useEffect(() => {
    if (!inspecting || !(systemSettingsOpen || menuOpen || blockingApprovalOpen)) return;
    setInspecting(false);
    void invoke('browser_inspect_set', { id: tabId, enabled: false, labels: inspectLabelsRef.current }).catch(() => {});
  }, [blockingApprovalOpen, inspecting, menuOpen, systemSettingsOpen, tabId]);

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
    startWebviewNavigation(normalized);
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
        <ToolbarTooltip content={t.workspace.browser.back}>
          <Button variant="ghost" size="icon-xs" disabled={!committedUrl} onClick={() => void invoke('browser_back', { id: tabId }).catch(() => {})} className="text-[var(--abu-text-tertiary)]">
            <ArrowLeft className="w-3.5 h-3.5" strokeWidth={1.5} />
          </Button>
        </ToolbarTooltip>
        <ToolbarTooltip content={t.workspace.browser.forward}>
          <Button variant="ghost" size="icon-xs" disabled={!committedUrl} onClick={() => void invoke('browser_forward', { id: tabId }).catch(() => {})} className="text-[var(--abu-text-tertiary)]">
            <ArrowRight className="w-3.5 h-3.5" strokeWidth={1.5} />
          </Button>
        </ToolbarTooltip>
        <ToolbarTooltip content={t.workspace.browser.reload}>
          <Button variant="ghost" size="icon-xs" disabled={!committedUrl} onClick={() => void invoke('browser_reload', { id: tabId }).catch(() => {})} className="text-[var(--abu-text-tertiary)]">
            <RotateCw className="w-3.5 h-3.5" strokeWidth={1.5} />
          </Button>
        </ToolbarTooltip>

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

        <ToolbarTooltip content={t.workspace.browser.openExternal}>
          <Button variant="ghost" size="icon-xs" disabled={!committedUrl} onClick={() => void handleOpenExternal()} className="text-[var(--abu-text-tertiary)]">
            <Compass className="w-3.5 h-3.5" strokeWidth={1.5} />
          </Button>
        </ToolbarTooltip>
        <ToolbarTooltip content={t.workspace.browser.selectElement}>
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={!committedUrl}
            onClick={() => void toggleInspect()}
            className={cn(inspecting ? 'text-[var(--abu-clay)] bg-[var(--abu-clay-bg)]' : 'text-[var(--abu-text-tertiary)]')}
          >
            <SquareDashedMousePointer className="w-3.5 h-3.5" strokeWidth={1.5} />
          </Button>
        </ToolbarTooltip>
      </div>

      {/* Placeholder the native webview is positioned over. When there's no URL
          yet, no webview exists, so this React start prompt is visible. While
          the native view is hidden for an overlay, the freeze-frame keeps the
          last rendered page visible instead of a blank pane. */}
      <div ref={containerRef} className="relative flex-1 min-h-0 bg-white">
        {freezeFrame && committedUrl && (
          <img
            src={freezeFrame}
            alt=""
            aria-hidden="true"
            className="absolute inset-0 h-full w-full object-cover"
            draggable={false}
          />
        )}
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
