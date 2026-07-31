import { PanelLeft, PanelRight, Plus, Search } from 'lucide-react';
import { cn } from '@/lib/utils';

interface WindowTitleBarProps {
  platform: string;
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
 * macOS keeps the controls in the original 44px overlay so the raised content
 * card can retain its compact 8px top gutter. Only the top 8px strip is
 * draggable; every control remains an explicit no-drag target. Windows keeps
 * native window chrome and a separate renderer toolbar for Abu actions.
 */
export default function WindowTitleBar({
  platform,
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

  if (mac) {
    const top = 23;

    return (
      <>
        <div
          data-abu-macos-drag-strip
          data-tauri-drag-region
          className="fixed inset-x-0 top-0 z-40 h-2"
        />
        <div
          data-abu-macos-titlebar
          className="pointer-events-none fixed inset-x-0 top-0 z-40 h-11 select-none"
        >
          <button
            type="button"
            data-electron-no-drag
            data-window-control="sidebar"
            onClick={onToggleSidebar}
            className={cn(CONTROL_CLASS, 'absolute transition-[left] duration-200')}
            style={{ top, left: sidebarCollapsed ? 96 : 200 }}
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
              className={cn(CONTROL_CLASS, 'absolute transition-[left] duration-200')}
              style={{ top, left: sidebarCollapsed ? 126 : 230 }}
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
              className={cn(CONTROL_CLASS, 'absolute')}
              style={{ top, left: 156 }}
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
              className={cn(CONTROL_CLASS, 'absolute right-4')}
              style={{ top }}
              title={rightPanelCollapsed ? labels.showPanel : labels.hidePanel}
              aria-label={rightPanelCollapsed ? labels.showPanel : labels.hidePanel}
            >
              <PanelRight className="h-3.5 w-[18px]" strokeWidth={1.5} />
            </button>
          )}
        </div>
      </>
    );
  }

  const leftControls = (
    <div
      data-abu-titlebar-control-group="left"
      data-electron-no-drag
      className="flex h-full shrink-0 items-center gap-1"
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
