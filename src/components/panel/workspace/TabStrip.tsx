import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileText, AppWindow, SquareTerminal, ListChecks, X, Plus, PanelRight } from 'lucide-react';
import { usePreviewStore, type WorkspaceTab } from '@/stores/previewStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { getBaseName } from '@/utils/pathUtils';
import { useI18n } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

const MENU_WIDTH = 150; // px — used to right-align / clamp popover menus

function tabIcon(tab: WorkspaceTab) {
  if (tab.kind === 'summary') return ListChecks;
  if (tab.kind === 'preview') return FileText;
  if (tab.kind === 'browser') return AppWindow;
  return SquareTerminal;
}

function tabTitle(tab: WorkspaceTab, t: ReturnType<typeof useI18n>['t']): string {
  if (tab.kind === 'summary') return t.workspace.summaryTitle;
  if (tab.kind === 'preview') return getBaseName(tab.filePath);
  if (tab.kind === 'browser') {
    if (!tab.url) return t.workspace.newTabPage;
    try {
      return new URL(tab.url).host || tab.url;
    } catch {
      return tab.url;
    }
  }
  return t.workspace.terminalTitle;
}

/**
 * Horizontal workspace tab bar (TRAE Solo-style): tab kind icon + title +
 * hover close, active-tab styling, trailing `+` new-tab menu, middle-click
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
  const tabs = usePreviewStore((s) => s.tabs);
  const activeTabId = usePreviewStore((s) => s.activeTabId);
  const activateTab = usePreviewStore((s) => s.activateTab);
  const closeTab = usePreviewStore((s) => s.closeTab);
  const closeOtherTabs = usePreviewStore((s) => s.closeOtherTabs);
  const closeAllTabs = usePreviewStore((s) => s.closeAllTabs);
  const reorderTabs = usePreviewStore((s) => s.reorderTabs);
  const openSummary = usePreviewStore((s) => s.openSummary);
  const openBrowser = usePreviewStore((s) => s.openBrowser);
  const openTerminal = usePreviewStore((s) => s.openTerminal);
  const setMenuOpen = usePreviewStore((s) => s.setMenuOpen);
  const setRightPanelCollapsed = useSettingsStore((s) => s.setRightPanelCollapsed);

  // Popover state holds a viewport-fixed position (or null when closed).
  const [newTabMenuPos, setNewTabMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ tabId: string; top: number; left: number } | null>(null);
  const plusBtnRef = useRef<HTMLButtonElement>(null);
  const draggingIdRef = useRef<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

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

  const handlePointerDown = (id: string) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    draggingIdRef.current = id;
  };

  const handlePointerEnter = (id: string) => () => {
    if (!draggingIdRef.current || draggingIdRef.current === id) return;
    setDragOverId(id);
  };

  const handlePointerUp = (id: string) => () => {
    const fromId = draggingIdRef.current;
    draggingIdRef.current = null;
    setDragOverId(null);
    if (fromId && fromId !== id) reorderTabs(fromId, id);
  };

  // Releasing a drag outside any tab (over the `+` button, the strip padding,
  // or off-strip) never fires a tab's onPointerUp, which would otherwise leave
  // draggingIdRef set — causing phantom hover-highlighting and an accidental
  // reorder on the next release. A window-level reset covers those cases.
  useEffect(() => {
    const reset = () => {
      draggingIdRef.current = null;
      setDragOverId(null);
    };
    window.addEventListener('pointerup', reset);
    window.addEventListener('pointercancel', reset);
    return () => {
      window.removeEventListener('pointerup', reset);
      window.removeEventListener('pointercancel', reset);
    };
  }, []);

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
    'flex items-center gap-2 w-full text-left px-3 py-1.5 text-[12px] text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)]';

  return (
    <div className="relative shrink-0 flex items-center border-b border-[var(--abu-bg-pressed)] bg-[var(--abu-bg-subtle)] pr-1 overflow-x-auto">
      {tabs.map((tab) => {
        const Icon = tabIcon(tab);
        const active = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={active}
            onPointerDown={handlePointerDown(tab.id)}
            onPointerEnter={handlePointerEnter(tab.id)}
            onPointerUp={handlePointerUp(tab.id)}
            onClick={() => activateTab(tab.id)}
            onAuxClick={(e) => {
              // Middle-click closes the tab.
              if (e.button === 1) closeTab(tab.id);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              openContextMenu(tab.id, e.clientX, e.clientY);
            }}
            className={cn(
              'group flex items-center gap-1.5 h-8 px-2.5 max-w-[160px] shrink-0 cursor-pointer select-none',
              'border-r border-[var(--abu-bg-pressed)] text-[12px]',
              active
                ? 'bg-[var(--abu-bg-base)] text-[var(--abu-text-primary)]'
                : 'text-[var(--abu-text-tertiary)] hover:bg-[var(--abu-bg-hover)]',
              dragOverId === tab.id && 'bg-[var(--abu-clay-20)]',
            )}
          >
            <Icon className="w-3.5 h-3.5 shrink-0" strokeWidth={1.5} />
            <span className="truncate flex-1">{tabTitle(tab, t)}</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.id);
              }}
              className="shrink-0 rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-[var(--abu-bg-pressed)]"
              title={t.workspace.closeTab}
            >
              <X className="w-3 h-3" strokeWidth={1.5} />
            </button>
          </div>
        );
      })}

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            ref={plusBtnRef}
            variant="ghost"
            size="icon-xs"
            onClick={toggleNewTabMenu}
            className="ml-0.5 shrink-0 text-[var(--abu-text-tertiary)] hover:text-[var(--abu-clay)]"
          >
            <Plus className="w-3.5 h-3.5" strokeWidth={1.5} />
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
            className="ml-auto shrink-0 text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)]"
          >
            <PanelRight className="w-3.5 h-3.5" strokeWidth={1.5} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t.panel.hidePanel}</TooltipContent>
      </Tooltip>

      {/* Portaled popovers — escape the strip's overflow clip. */}
      {(newTabMenuPos || contextMenu) &&
        createPortal(
          <>
            <div className="fixed inset-0 z-[55]" onClick={closeMenus} onContextMenu={(e) => { e.preventDefault(); closeMenus(); }} />
            {newTabMenuPos && (
              <div
                className="fixed z-[60] min-w-[150px] rounded-md border border-[var(--abu-border)] bg-[var(--abu-bg-muted)] shadow-md py-1"
                style={{ top: newTabMenuPos.top, left: newTabMenuPos.left }}
              >
                <button type="button" className={menuItemCls} onClick={() => { openSummary(); closeMenus(); }}>
                  <ListChecks className="w-3.5 h-3.5" strokeWidth={1.5} />
                  {t.workspace.summaryTitle}
                </button>
                <button type="button" className={menuItemCls} onClick={() => { openBrowser(); closeMenus(); }}>
                  <AppWindow className="w-3.5 h-3.5" strokeWidth={1.5} />
                  {t.workspace.newBrowserTab}
                </button>
                <button type="button" className={menuItemCls} onClick={() => { openTerminal(); closeMenus(); }}>
                  <SquareTerminal className="w-3.5 h-3.5" strokeWidth={1.5} />
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
                  className="w-full text-left px-3 py-1.5 text-[12px] text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)]"
                  onClick={() => { closeOtherTabs(contextMenu.tabId); closeMenus(); }}
                >
                  {t.workspace.closeOtherTabs}
                </button>
                <button
                  type="button"
                  className="w-full text-left px-3 py-1.5 text-[12px] text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)]"
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
