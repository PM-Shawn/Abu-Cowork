import { PanelLeft, PanelRight, Plus, Search } from 'lucide-react';
import { cn } from '@/lib/utils';

type MacPlacement = 'sidebar' | 'main' | 'panel';

interface WindowTitleBarProps {
  platform: string;
  macPlacement?: MacPlacement;
  sidebarCollapsed: boolean;
  showSearch: boolean;
  showNewTask: boolean;
  showRightPanelToggle: boolean;
  rightPanelCollapsed: boolean;
  onToggleSidebar: () => void;
  onOpenSearch: () => void;
  onNewTask: () => void;
  onToggleRightPanel: () => void;
  labels: {
    showSidebar: string;
    hideSidebar: string;
    search: string;
    newTask: string;
    showPanel: string;
    hidePanel: string;
  };
}

const CONTROL_CLASS =
  'btn-ghost p-1 text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)] rounded-md pointer-events-auto';

/**
 * Electron drag regions must own their controls instead of overlapping them.
 * macOS mirrors TRAE SOLO's panel-scoped chrome: the expanded sidebar owns its
 * 56px header, the collapsed layout owns a main header, and the content card
 * owns the optional right-panel toggle. Windows keeps native window chrome and
 * uses a separate renderer toolbar for Abu actions.
 */
export default function WindowTitleBar({
  platform,
  macPlacement = 'main',
  sidebarCollapsed,
  showSearch,
  showNewTask,
  showRightPanelToggle,
  rightPanelCollapsed,
  onToggleSidebar,
  onOpenSearch,
  onNewTask,
  onToggleRightPanel,
  labels,
}: WindowTitleBarProps) {
  const mac = platform === 'macos';
  const windows = platform === 'windows';

  const leftControls = (
    <div
      data-abu-titlebar-control-group="left"
      data-electron-no-drag
      className="flex h-full shrink-0 items-center gap-1"
      style={mac ? { paddingLeft: macPlacement === 'sidebar' ? 200 : 96 } : undefined}
    >
      <button
        type="button"
        data-electron-no-drag
        data-window-control="sidebar"
        onClick={onToggleSidebar}
        className={CONTROL_CLASS}
        title={sidebarCollapsed ? labels.showSidebar : labels.hideSidebar}
        aria-label={sidebarCollapsed ? labels.showSidebar : labels.hideSidebar}
      >
        <PanelLeft className="h-3.5 w-[18px]" strokeWidth={1.5} />
      </button>
      {showSearch && (
        <button
          type="button"
          data-electron-no-drag
          data-window-control="search"
          onClick={onOpenSearch}
          className={CONTROL_CLASS}
          title={labels.search}
          aria-label={labels.search}
        >
          <Search className="h-3.5 w-[18px]" strokeWidth={1.5} />
        </button>
      )}
      {showNewTask && (
        <button
          type="button"
          data-electron-no-drag
          data-window-control="new-task"
          onClick={onNewTask}
          className={CONTROL_CLASS}
          title={labels.newTask}
          aria-label={labels.newTask}
        >
          <Plus className="h-3.5 w-[18px]" strokeWidth={2} />
        </button>
      )}
    </div>
  );

  const rightControl = showRightPanelToggle ? (
    <button
      type="button"
      data-electron-no-drag
      data-window-control="right-panel"
      onClick={onToggleRightPanel}
      className={CONTROL_CLASS}
      title={rightPanelCollapsed ? labels.showPanel : labels.hidePanel}
      aria-label={rightPanelCollapsed ? labels.showPanel : labels.hidePanel}
    >
      <PanelRight className="h-3.5 w-[18px]" strokeWidth={1.5} />
    </button>
  ) : null;

  if (mac) {
    if (macPlacement === 'panel') {
      return rightControl ? (
        <div
          data-abu-macos-panel-controls
          data-electron-no-drag
          className="absolute right-4 top-[15px] z-50"
        >
          {rightControl}
        </div>
      ) : null;
    }

    return (
      <div
        data-abu-macos-titlebar={macPlacement}
        data-tauri-drag-region
        className="flex h-14 w-full shrink-0 select-none items-center justify-between bg-[var(--abu-bg-canvas)]"
      >
        {leftControls}
        {macPlacement === 'main' && rightControl && (
          <div
            data-abu-titlebar-control-group="right"
            data-electron-no-drag
            className="flex h-full shrink-0 items-center pr-4"
          >
            {rightControl}
          </div>
        )}
      </div>
    );
  }

  if (windows) {
    return (
      <div
        data-abu-windows-toolbar
        className="flex h-9 shrink-0 items-center justify-between border-b border-[var(--abu-border)] bg-[var(--abu-bg-canvas)] px-2"
      >
        <div className="flex items-center gap-1">
          {leftControls}
        </div>
        {rightControl}
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        data-electron-no-drag
        data-window-control="sidebar"
        onClick={onToggleSidebar}
        className={cn(CONTROL_CLASS, 'fixed left-2 top-1.5 z-50')}
        title={sidebarCollapsed ? labels.showSidebar : labels.hideSidebar}
        aria-label={sidebarCollapsed ? labels.showSidebar : labels.hideSidebar}
      >
        <PanelLeft className="h-3.5 w-[18px]" strokeWidth={1.5} />
      </button>

      {showSearch && (
        <button
          type="button"
          data-electron-no-drag
          data-window-control="search"
          onClick={onOpenSearch}
          className={cn(CONTROL_CLASS, 'fixed left-10 top-1.5 z-50')}
          title={labels.search}
          aria-label={labels.search}
        >
          <Search className="h-3.5 w-[18px]" strokeWidth={1.5} />
        </button>
      )}

      {showNewTask && (
        <button
          type="button"
          data-electron-no-drag
          data-window-control="new-task"
          onClick={onNewTask}
          className={cn(CONTROL_CLASS, 'fixed left-[72px] top-1.5 z-50')}
          title={labels.newTask}
          aria-label={labels.newTask}
        >
          <Plus className="h-3.5 w-[18px]" strokeWidth={2} />
        </button>
      )}

      {showRightPanelToggle && (
        <button
          type="button"
          data-electron-no-drag
          data-window-control="right-panel"
          onClick={onToggleRightPanel}
          className={cn(CONTROL_CLASS, 'fixed right-2 top-1.5 z-50')}
          title={rightPanelCollapsed ? labels.showPanel : labels.hidePanel}
          aria-label={rightPanelCollapsed ? labels.showPanel : labels.hidePanel}
        >
          <PanelRight className="h-3.5 w-[18px]" strokeWidth={1.5} />
        </button>
      )}
    </>
  );
}
