import { useEffect, useRef, useState } from 'react';
import { IconButton } from '@/components/ds/button';
import { ContextMenu } from '@/components/ds/context-menu';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Menu, MenuItem } from '@/components/ds/menu';
import { Pressable } from '@/components/ds/pressable';
import {
  usePreviewStore,
  useVisibleTabs,
  workspaceTabButtonId,
  workspaceTabPanelId,
  type WorkspaceTab,
} from '@/stores/previewStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { getBaseName } from '@/utils/pathUtils';
import { useI18n, format } from '@/i18n';
import { cn } from '@/lib/utils';
import { isWindows } from '@/utils/platform';
import { hasElectronCommandHost } from '@/utils/electronHost';

// The key of the new-tab menu in the set of open menus; a tab's context menu uses the tab id.
const NEW_TAB_MENU = 'new-tab';

function tabMenuKey(tabId: string): string {
  return `tab:${tabId}`;
}

function tabIcon(tab: WorkspaceTab) {
  if (tab.kind === 'summary') return AppIcons.plan;
  if (tab.kind === 'preview') return AppIcons.file;
  if (tab.kind === 'browser') return AppIcons.webPage;
  if (tab.kind === 'subagent') return AppIcons.agent;
  if (tab.kind === 'team') return AppIcons.team;
  return AppIcons.terminal;
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
  if (tab.kind === 'team') return t.workspace.teamTitle;
  return t.workspace.terminalTitle;
}

/**
 * Horizontal workspace tab bar (TRAE Solo-style): tab kind icon + title +
 * always-visible close, active-tab styling, trailing `+` new-tab menu, middle-click
 * close, and lightweight pointer-based drag-to-reorder (no dnd-kit — mirrors
 * TRAE's `swapOpenedTab(i, j)`). See docs/2026-07-17-workspace-tabs-design.md.
 *
 * The new-tab `+` menu and each tab's right-click menu are design-system menus.
 * A native browser view paints over the page, so the strip tells the store while
 * any of them is open.
 */
export default function TabStrip() {
  const { t } = useI18n();
  const windowsWorkspaceHeader = isWindows() && hasElectronCommandHost();
  // The strip lists only what this conversation owns or shares: a browser tab
  // adopted for another conversation keeps running (hidden) but is not listed,
  // not activatable, and not closable from here.
  const tabs = useVisibleTabs();
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

  // Every menu of the strip that is open right now. The layer registry closes the
  // previous menu when another one opens, and the new menu reports "open" before the
  // old one reports "closed", so a single boolean would uncover the native view in between.
  const openMenus = useRef(new Set<string>());
  // The pending "every menu has closed" report (see syncMenuOpen).
  const releaseFrame = useRef<number | null>(null);
  // What the new-tab menu will open once it has closed (see handleNewTabCloseAutoFocus).
  const pendingNewTab = useRef<(() => void) | null>(null);
  // Drag-to-reorder: `draggingId` = the tab being dragged, `dragDx` = how far it
  // has followed the cursor (px), `dragOverId` = the tab it will drop onto.
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragDx, setDragDx] = useState(0);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const dragMovedRef = useRef(false);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const tabButtonRefs = useRef(new Map<string, HTMLButtonElement>());

  const syncMenuOpen = () => {
    if (releaseFrame.current !== null) {
      window.cancelAnimationFrame(releaseFrame.current);
      releaseFrame.current = null;
    }
    if (openMenus.current.size > 0) {
      setMenuOpen(true);
      return;
    }
    // Right-clicking a tab while a menu is open closes that menu on the press and opens
    // the tab's menu on the context-menu event that follows. Waiting one frame before
    // reporting "all closed" keeps the native view hidden across that hand-over.
    releaseFrame.current = window.requestAnimationFrame(() => {
      releaseFrame.current = null;
      if (openMenus.current.size === 0) setMenuOpen(false);
    });
  };

  const trackMenu = (key: string) => (open: boolean) => {
    if (open) openMenus.current.add(key);
    else openMenus.current.delete(key);
    syncMenuOpen();
  };

  const handleNewTabMenuOpenChange = (open: boolean) => {
    if (open) pendingNewTab.current = null;
    trackMenu(NEW_TAB_MENU)(open);
  };

  // A new browser tab focuses its address field and a terminal takes the keyboard.
  // Opening them only after the menu has gone, with the focus return cancelled, keeps
  // the menu from pulling focus back to the `+` button.
  const handleNewTabCloseAutoFocus = (event: Event) => {
    const open = pendingNewTab.current;
    pendingNewTab.current = null;
    if (!open) return;
    event.preventDefault();
    open();
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
        // One press closes one tab: the focus moves to the next tab, and the repeats of a held
        // Delete would close that one too.
        if (e.repeat) break;
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

  // A tab can go away while its context menu is open (an agent closes it, its file is
  // deleted). Its menu unmounts without reporting "closed", so drop it from the set here.
  useEffect(() => {
    const menus = openMenus.current;
    let dropped = false;
    for (const key of menus) {
      if (key === NEW_TAB_MENU || tabs.some((tab) => tabMenuKey(tab.id) === key)) continue;
      menus.delete(key);
      dropped = true;
    }
    if (dropped) setMenuOpen(menus.size > 0);
  }, [tabs, setMenuOpen]);

  // The strip remounts per conversation; a menu open at that moment never reports
  // "closed", and a pending report would never run.
  useEffect(() => {
    const menus = openMenus.current;
    return () => {
      const pending = releaseFrame.current;
      if (pending !== null) window.cancelAnimationFrame(pending);
      releaseFrame.current = null;
      if (menus.size === 0 && pending === null) return;
      menus.clear();
      setMenuOpen(false);
    };
  }, [setMenuOpen]);

  return (
    <div
      data-abu-workspace-tabs
      className={cn(
        'relative flex h-8 shrink-0 items-center gap-1 border-b border-separator px-1',
        windowsWorkspaceHeader && 'h-11',
      )}
    >
      <div role="tablist" aria-label={t.workspace.tabListLabel} className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          const title = tabTitle(tab, t);
          return (
            <ContextMenu
              key={tab.id}
              onOpenChange={trackMenu(tabMenuKey(tab.id))}
              content={(
                <>
                  <MenuItem onSelect={() => closeOtherTabs(tab.id)}>{t.workspace.closeOtherTabs}</MenuItem>
                  <MenuItem onSelect={() => closeAllTabs()}>{t.workspace.closeAllTabs}</MenuItem>
                </>
              )}
            >
              <div
                role="presentation"
                data-tab-id={tab.id}
                className={cn(
                  'group flex h-7 max-w-40 shrink-0 select-none items-center rounded-control text-ui',
                  draggingId === tab.id && 'cursor-grabbing',
                  active
                    ? 'bg-fill-selected text-label'
                    : 'text-label-secondary hover:bg-fill-hover',
                  // The dragged tab lifts off the strip; a drop target gets highlighted.
                  // pointer-events-none lets elementFromPoint "see through" it to the
                  // tab underneath (the drop target) instead of hitting itself.
                  draggingId === tab.id && 'relative z-sticky rounded-control bg-raised opacity-90 shadow-float pointer-events-none',
                  // Drop target: a neutral vertical insertion line on the left edge
                  // (an "insert here" caret) — NOT a filled accent/red fill, which
                  // reads as a "can't drop" state.
                  dragOverId === tab.id && 'relative before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded-full before:bg-label',
                )}
                style={draggingId === tab.id ? { transform: `translateX(${dragDx}px)` } : undefined}
              >
                <Pressable
                  id={workspaceTabButtonId(tab.id)}
                  ref={(node) => {
                    if (node) tabButtonRefs.current.set(tab.id, node);
                    else tabButtonRefs.current.delete(tab.id);
                  }}
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
                  // The strip scrolls sideways and would clip a ring drawn outside the tab.
                  className="flex h-full min-w-0 flex-1 items-center gap-2 px-2 text-left focus-visible:ring-inset"
                >
                  <Icon icon={tabIcon(tab)} size="sm" />
                  <span className="flex-1 truncate">{title}</span>
                </Pressable>
                <IconButton
                  size="sm"
                  icon={AppIcons.close}
                  label={format(t.workspace.closeTabLabel, { title })}
                  tabIndex={-1}
                  // Don't let pressing × start a tab drag (which would flip the tab to
                  // pointer-events-none and swallow this click).
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.id, { focusAfterClose: true });
                  }}
                />
              </div>
            </ContextMenu>
          );
        })}
      </div>

      <Menu
        align="end"
        onOpenChange={handleNewTabMenuOpenChange}
        onCloseAutoFocus={handleNewTabCloseAutoFocus}
        trigger={<IconButton size="sm" icon={AppIcons.add} label={t.workspace.newTab} />}
      >
        <MenuItem icon={AppIcons.plan} onSelect={() => openSummary()}>{t.workspace.summaryTitle}</MenuItem>
        <MenuItem icon={AppIcons.webPage} onSelect={() => { pendingNewTab.current = () => openBrowser(); }}>
          {t.workspace.newBrowserTab}
        </MenuItem>
        <MenuItem icon={AppIcons.terminal} onSelect={() => { pendingNewTab.current = () => openTerminal(); }}>
          {t.workspace.newTerminalTab}
        </MenuItem>
      </Menu>

      {/* Collapse the whole right panel — pinned to the far right. (dev's
          RightPanelTabBar carried this button; our TabStrip replaced it, so the
          affordance moved here. The app top-bar toggle only *reopens* a
          collapsed panel.) */}
      <span className="ml-auto flex">
        <IconButton size="sm" icon={AppIcons.rightPanel} label={t.panel.hidePanel} onClick={() => setRightPanelCollapsed(true)} />
      </span>
    </div>
  );
}
