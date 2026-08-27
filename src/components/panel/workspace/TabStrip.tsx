import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileText, AppWindow, SquareTerminal, ListChecks, X, Plus, PanelRight, Bot } from 'lucide-react';
import {
  usePreviewStore,
  workspaceTabButtonId,
  workspaceTabPanelId,
  type WorkspaceTab,
} from '@/stores/previewStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { getBaseName } from '@/utils/pathUtils';
import { useI18n, format } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { isWindows } from '@/utils/platform';
import { hasElectronCommandHost } from '@/utils/electronHost';

const MENU_WIDTH = 150; // px — used to right-align / clamp popover menus

function tabIcon(tab: WorkspaceTab) {
  if (tab.kind === 'summary') return ListChecks;
  if (tab.kind === 'preview') return FileText;
  if (tab.kind === 'browser') return AppWindow;
  if (tab.kind === 'subagent') return Bot;
  return SquareTerminal;
}

function tabTitle(tab: WorkspaceTab, t: ReturnType<typeof useI18n>['t']): string {
  if (tab.kind === 'summary') return t.workspace.summaryTitle;
  if (tab.kind === 'preview') {
    if (tab.filePath.startsWith('data:image/')) return t.panel.imagePreview;
    return getBaseName(tab.filePath);
  }
  if (tab.kind === 'browser') {
    if (!tab.url) return t.workspace.newTabPage;
    try {
      return new URL(tab.url).host || tab.url;
    } catch {
      return tab.url;
    }
  }
  if (tab.kind === 'subagent') return tab.title || t.workspace.agentTitle;
  return t.workspace.terminalTitle;
}

/**
 * Horizontal workspace tab bar (TRAE Solo-style): tab kind icon + title +
 * always-visible close, active-tab styling, trailing `+` new-tab menu, middle-click
 * close, and lightweight pointer-based drag-to-reorder (no dnd-kit — mirrors
 * TRAE's `swapOpenedTab(i, j)`). See docs/2026-07-17-workspace-tabs-design.md.
 *
 * The two popover menus (new-tab `+` and per-tab right-click) are rendered via
 * a portal to `document.body`: the strip itself is `overflow-x-auto` (so many
 * tabs scroll horizontally), and CSS forces `overflow-y` to `auto` too, which
 * would clip any dropdown rendered below the strip. Portaling + fixed
 * positioning escapes that clip.
 */
export default function TabStrip() {
  const { t } = useI18n();
  const windowsWorkspaceHeader = isWindows() && hasElectronCommandHost();
  const tabs = usePreviewStore((s) => s.tabs);
  const activeTabId = usePreviewStore((s) => s.activeTabId);
  const activateTab = usePreviewStore((s) => s.activateTab);
  const closeTab = usePreviewStore((s) => s.closeTab);
  const closeOtherTabs = usePreviewStore((s) => s.closeOtherTabs);
  const closeAllTabs = usePreviewStore((s) => s.closeAllTabs);
  const reorderTabs = usePreviewStore((s) => s.reorderTabs);
  const focusTabId = usePreviewStore((s) => s.focusTabId);
  const consumeFocusTabRequest = usePreviewStore((s) => s.consumeFocusTabRequest);
  const openSummary = usePreviewStore((s) => s.openSummary);
  const openBrowser = usePreviewStore((s) => s.openBrowser);
  const openTerminal = usePreviewStore((s) => s.openTerminal);
  const setMenuOpen = usePreviewStore((s) => s.setMenuOpen);
  const setRightPanelCollapsed = useSettingsStore((s) => s.setRightPanelCollapsed);

  // Popover state holds a viewport-fixed position (or null when closed).
  const [newTabMenuPos, setNewTabMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ tabId: string; top: number; left: number } | null>(null);
  const plusBtnRef = useRef<HTMLButtonElement>(null);
  // Drag-to-reorder: `draggingId` = the tab being dragged, `dragDx` = how far it
  // has followed the cursor (px), `dragOverId` = the tab it will drop onto.
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragDx, setDragDx] = useState(0);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const dragMovedRef = useRef(false);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const tabButtonRefs = useRef(new Map<string, HTMLButtonElement>());

  const closeMenus = () => {
    setNewTabMenuPos(null);
    setContextMenu(null);
  };

  const toggleNewTabMenu = () => {
    setContextMenu(null);
    setNewTabMenuPos((cur) => {
      if (cur) return null;
      const r = plusBtnRef.current?.getBoundingClientRect();
      if (!r) return null;
      // Right-align the menu to the button (the `+` sits at the panel's right
      // edge), clamped into the viewport.
      const left = Math.max(8, Math.min(r.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8));
      return { top: r.bottom + 4, left };
    });
  };

  const openContextMenu = (tabId: string, x: number, y: number) => {
    setNewTabMenuPos(null);
    const left = Math.max(8, Math.min(x, window.innerWidth - MENU_WIDTH - 8));
    setContextMenu({ tabId, top: y, left });
  };

  const handleTabPointerDown = (id: string) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;

    // Register global listeners synchronously. Starting the drag in an effect
    // can miss a quick pointerup, leaving the tab permanently "grabbing".
    dragCleanupRef.current?.();
    const startX = e.clientX;
    let moved = false;
    let overId: string | null = null;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    dragMovedRef.current = false;

    const onMove = (e: PointerEvent) => {
      const dx = e.clientX - startX;
      if (!moved) {
        if (Math.abs(dx) <= 4) return;
        moved = true;
        dragMovedRef.current = true;
        document.body.style.cursor = 'grabbing';
        document.body.style.userSelect = 'none';
        setDraggingId(id);
      }
      setDragDx(dx);
      const overTab = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest(
        '[data-tab-id]',
      ) as HTMLElement | null;
      const next = overTab?.dataset.tabId;
      overId = next && next !== id ? next : null;
      setDragOverId(overId);
    };

    const cleanupListeners = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      if (dragCleanupRef.current === cleanupListeners) {
        dragCleanupRef.current = null;
      }
    };

    const onUp = () => {
      cleanupListeners();
      if (moved && overId) {
        reorderTabs(id, overId);
      }
      setDraggingId(null);
      setDragDx(0);
      setDragOverId(null);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    dragCleanupRef.current = cleanupListeners;
  };

  const focusTabButton = (id: string) => {
    const schedule = window.requestAnimationFrame ?? ((cb: FrameRequestCallback) => window.setTimeout(() => cb(performance.now()), 0));
    schedule(() => {
      tabButtonRefs.current.get(id)?.focus();
    });
  };

  const activateAndFocusIndex = (index: number) => {
    const tab = tabs[index];
    if (!tab) return;
    activateTab(tab.id);
    focusTabButton(tab.id);
  };

  const handleTabKeyDown = (id: string) => (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const currentIndex = tabs.findIndex((tab) => tab.id === id);
    if (currentIndex === -1 || tabs.length === 0) return;
    switch (e.key) {
      case 'ArrowLeft':
        e.preventDefault();
        activateAndFocusIndex((currentIndex - 1 + tabs.length) % tabs.length);
        break;
      case 'ArrowRight':
        e.preventDefault();
        activateAndFocusIndex((currentIndex + 1) % tabs.length);
        break;
      case 'Home':
        e.preventDefault();
        activateAndFocusIndex(0);
        break;
      case 'End':
        e.preventDefault();
        activateAndFocusIndex(tabs.length - 1);
        break;
      case 'Delete':
        e.preventDefault();
        closeTab(id, { focusAfterClose: true });
        break;
    }
  };

  useEffect(() => () => {
    dragCleanupRef.current?.();
  }, []);

  useEffect(() => {
    if (!focusTabId) return;
    const el = tabButtonRefs.current.get(focusTabId);
    if (!el) return;
    el.focus();
    consumeFocusTabRequest(focusTabId);
  }, [focusTabId, consumeFocusTabRequest, tabs]);

  // Tell the store when a popover is open so a native browser webview (which
  // paints over React) hides instead of occluding the menu.
  useEffect(() => {
    setMenuOpen(!!(newTabMenuPos || contextMenu));
  }, [newTabMenuPos, contextMenu, setMenuOpen]);

  // Close popovers on Escape, and on scroll/resize (their fixed position would
  // otherwise drift away from the anchor).
  useEffect(() => {
    if (!newTabMenuPos && !contextMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMenus();
    };
    const onScrollResize = () => closeMenus();
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onScrollResize);
    window.addEventListener('scroll', onScrollResize, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onScrollResize);
      window.removeEventListener('scroll', onScrollResize, true);
    };
  }, [newTabMenuPos, contextMenu]);

  const menuItemCls =
    'flex items-center gap-2 w-full text-left px-3 py-1.5 text-minor text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)]';

  return (
    <div
      data-abu-workspace-tabs
      className={cn(
        'relative shrink-0 flex items-center border-b border-[var(--abu-bg-pressed)] bg-[var(--abu-bg-subtle)] pr-1',
        windowsWorkspaceHeader && 'h-11',
      )}
    >
      <div role="tablist" aria-label={t.workspace.tabListLabel} className="flex min-w-0 flex-1 overflow-x-auto">
        {tabs.map((tab) => {
          const Icon = tabIcon(tab);
          const active = tab.id === activeTabId;
          const title = tabTitle(tab, t);
          return (
            <div
              key={tab.id}
              role="presentation"
              data-tab-id={tab.id}
              onContextMenu={(e) => {
                e.preventDefault();
                openContextMenu(tab.id, e.clientX, e.clientY);
              }}
              className={cn(
                'group flex items-center max-w-[160px] shrink-0 select-none',
                windowsWorkspaceHeader ? 'h-full' : 'h-8',
                'border-r border-[var(--abu-bg-pressed)] text-minor transition-shadow',
                draggingId === tab.id && 'cursor-grabbing',
                active
                  ? 'bg-[var(--abu-bg-active)] text-[var(--abu-text-primary)]'
                  : 'text-[var(--abu-text-tertiary)] hover:bg-[var(--abu-bg-hover)]',
                // The dragged tab lifts off the strip; a drop target gets highlighted.
                // pointer-events-none lets elementFromPoint "see through" it to the
                // tab underneath (the drop target) instead of hitting itself.
                draggingId === tab.id && 'relative z-20 shadow-lg opacity-90 rounded-md bg-[var(--abu-bg-base)] pointer-events-none',
                // Drop target: a neutral vertical insertion line on the left edge
                // (an "insert here" caret) — NOT a filled accent/red fill, which
                // reads as a "can't drop" state.
                dragOverId === tab.id && 'shadow-[inset_2px_0_0_0_var(--abu-text-primary)]',
              )}
              style={draggingId === tab.id ? { transform: `translateX(${dragDx}px)` } : undefined}
            >
              <button
                id={workspaceTabButtonId(tab.id)}
                ref={(node) => {
                  if (node) tabButtonRefs.current.set(tab.id, node);
                  else tabButtonRefs.current.delete(tab.id);
                }}
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls={workspaceTabPanelId(tab.id)}
                tabIndex={active ? 0 : -1}
                onPointerDown={handleTabPointerDown(tab.id)}
                onClick={() => {
                  // Suppress the click that follows an actual drag (would re-activate).
                  if (dragMovedRef.current) return;
                  activateTab(tab.id);
                }}
                onAuxClick={(e) => {
                  // Middle-click closes the tab.
                  if (e.button === 1) closeTab(tab.id);
                }}
                onKeyDown={handleTabKeyDown(tab.id)}
                className={cn(
                  'flex min-w-0 flex-1 items-center gap-1.5 px-2.5 h-full text-left',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--abu-clay)] focus-visible:ring-inset',
                )}
              >
                <Icon aria-hidden="true" className="w-3.5 h-3.5 shrink-0" strokeWidth={1.5} />
                <span className="truncate flex-1">{title}</span>
              </button>
              <button
                type="button"
                tabIndex={-1}
                // Don't let pressing × start a tab drag (which would flip the tab to
                // pointer-events-none and swallow this click).
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.id, { focusAfterClose: true });
                }}
                className="mr-1 shrink-0 rounded p-0.5 hover:bg-[var(--abu-bg-pressed)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--abu-clay)]"
                aria-label={format(t.workspace.closeTabLabel, { title })}
                title={t.workspace.closeTab}
              >
                <X aria-hidden="true" className="w-3 h-3" strokeWidth={1.5} />
              </button>
            </div>
          );
        })}
      </div>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            ref={plusBtnRef}
            variant="ghost"
            size="icon-xs"
            onClick={toggleNewTabMenu}
            aria-label={t.workspace.newTab}
            className="ml-0.5 shrink-0 text-[var(--abu-text-tertiary)] hover:text-[var(--abu-clay)]"
          >
            <Plus aria-hidden="true" className="w-3.5 h-3.5" strokeWidth={1.5} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t.workspace.newTab}</TooltipContent>
      </Tooltip>

      {/* Collapse the whole right panel — pinned to the far right. (dev's
          RightPanelTabBar carried this button; our TabStrip replaced it, so the
          affordance moved here. The app top-bar toggle only *reopens* a
          collapsed panel.) */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => setRightPanelCollapsed(true)}
            aria-label={t.panel.hidePanel}
            className="ml-auto shrink-0 text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)]"
          >
            <PanelRight aria-hidden="true" className="w-3.5 h-3.5" strokeWidth={1.5} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t.panel.hidePanel}</TooltipContent>
      </Tooltip>

      {/* Portaled popovers — escape the strip's overflow clip. */}
      {(newTabMenuPos || contextMenu) &&
        createPortal(
          <>
            <div data-electron-no-drag className="fixed inset-0 z-[55]" onClick={closeMenus} onContextMenu={(e) => { e.preventDefault(); closeMenus(); }} />
            {newTabMenuPos && (
              <div
                className="fixed z-[60] min-w-[150px] rounded-md border border-[var(--abu-border)] bg-[var(--abu-bg-muted)] shadow-md py-1"
                style={{ top: newTabMenuPos.top, left: newTabMenuPos.left }}
              >
                <button type="button" className={menuItemCls} onClick={() => { openSummary(); closeMenus(); }}>
                  <ListChecks aria-hidden="true" className="w-3.5 h-3.5" strokeWidth={1.5} />
                  {t.workspace.summaryTitle}
                </button>
                <button type="button" className={menuItemCls} onClick={() => { openBrowser(); closeMenus(); }}>
                  <AppWindow aria-hidden="true" className="w-3.5 h-3.5" strokeWidth={1.5} />
                  {t.workspace.newBrowserTab}
                </button>
                <button type="button" className={menuItemCls} onClick={() => { openTerminal(); closeMenus(); }}>
                  <SquareTerminal aria-hidden="true" className="w-3.5 h-3.5" strokeWidth={1.5} />
                  {t.workspace.newTerminalTab}
                </button>
              </div>
            )}
            {contextMenu && (
              <div
                className="fixed z-[60] min-w-[150px] rounded-md border border-[var(--abu-border)] bg-[var(--abu-bg-muted)] shadow-md py-1"
                style={{ top: contextMenu.top, left: contextMenu.left }}
              >
                <button
                  type="button"
                  className="w-full text-left px-3 py-1.5 text-minor text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)]"
                  onClick={() => { closeOtherTabs(contextMenu.tabId); closeMenus(); }}
                >
                  {t.workspace.closeOtherTabs}
                </button>
                <button
                  type="button"
                  className="w-full text-left px-3 py-1.5 text-minor text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)]"
                  onClick={() => { closeAllTabs(); closeMenus(); }}
                >
                  {t.workspace.closeAllTabs}
                </button>
              </div>
            )}
          </>,
          document.body,
        )}
    </div>
  );
}
