import { useEffect, useRef, useState } from 'react';
import { FileText, Globe, SquareTerminal, X, Plus } from 'lucide-react';
import { usePreviewStore, type WorkspaceTab } from '@/stores/previewStore';
import { getBaseName } from '@/utils/pathUtils';
import { useI18n } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

function tabIcon(tab: WorkspaceTab) {
  if (tab.kind === 'preview') return FileText;
  if (tab.kind === 'browser') return Globe;
  return SquareTerminal;
}

function tabTitle(tab: WorkspaceTab, t: ReturnType<typeof useI18n>['t']): string {
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
  const openBrowser = usePreviewStore((s) => s.openBrowser);
  const openTerminal = usePreviewStore((s) => s.openTerminal);

  const [newTabMenuOpen, setNewTabMenuOpen] = useState(false);
  const newTabMenuRef = useRef<HTMLDivElement>(null);
  const [contextMenuTabId, setContextMenuTabId] = useState<string | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const draggingIdRef = useRef<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const closeNewTabMenu = () => setNewTabMenuOpen(false);
  const closeContextMenu = () => setContextMenuTabId(null);

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

  return (
    <div className="relative shrink-0 mt-7 flex items-center border-b border-[var(--abu-bg-pressed)] bg-[var(--abu-bg-subtle)] pr-1 overflow-x-auto">
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
              setContextMenuTabId(tab.id);
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

            {contextMenuTabId === tab.id && (
              <div
                ref={contextMenuRef}
                className="absolute top-9 z-30 min-w-[140px] rounded-md border border-[var(--abu-border)] bg-[var(--abu-bg-muted)] shadow-md py-1"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  onClick={() => {
                    closeOtherTabs(tab.id);
                    closeContextMenu();
                  }}
                  className="w-full text-left px-3 py-1.5 text-[12px] text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)]"
                >
                  {t.workspace.closeOtherTabs}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    closeAllTabs();
                    closeContextMenu();
                  }}
                  className="w-full text-left px-3 py-1.5 text-[12px] text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)]"
                >
                  {t.workspace.closeAllTabs}
                </button>
              </div>
            )}
          </div>
        );
      })}

      <div className="relative ml-0.5" ref={newTabMenuRef}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setNewTabMenuOpen((v) => !v)}
              className="text-[var(--abu-text-tertiary)] hover:text-[var(--abu-clay)]"
            >
              <Plus className="w-3.5 h-3.5" strokeWidth={1.5} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t.workspace.newTab}</TooltipContent>
        </Tooltip>

        {newTabMenuOpen && (
          <div className="absolute top-8 left-0 z-30 min-w-[140px] rounded-md border border-[var(--abu-border)] bg-[var(--abu-bg-muted)] shadow-md py-1">
            <button
              type="button"
              onClick={() => {
                openBrowser();
                closeNewTabMenu();
              }}
              className="flex items-center gap-2 w-full text-left px-3 py-1.5 text-[12px] text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)]"
            >
              <Globe className="w-3.5 h-3.5" strokeWidth={1.5} />
              {t.workspace.newBrowserTab}
            </button>
            <button
              type="button"
              onClick={() => {
                openTerminal();
                closeNewTabMenu();
              }}
              className="flex items-center gap-2 w-full text-left px-3 py-1.5 text-[12px] text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)]"
            >
              <SquareTerminal className="w-3.5 h-3.5" strokeWidth={1.5} />
              {t.workspace.newTerminalTab}
            </button>
          </div>
        )}
      </div>

      {/* Outside-click closers for the two popover menus above. */}
      {(newTabMenuOpen || contextMenuTabId) && (
        <div
          className="fixed inset-0 z-20"
          onClick={() => {
            closeNewTabMenu();
            closeContextMenu();
          }}
        />
      )}
    </div>
  );
}
