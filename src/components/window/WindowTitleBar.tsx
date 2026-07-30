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
  'absolute btn-ghost p-1 text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)] rounded-md pointer-events-auto';

/**
 * Keeps application controls inside Electron's web title-bar safe area.
 * Windows owns the caption-button rectangle, while Abu owns the remaining
 * draggable row. Every interactive control is explicitly marked no-drag.
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
  const top = mac ? 23 : 6;
  const sidebarLeft = sidebarCollapsed ? 96 : 200;

  const controls = (
    <>
      <button
        type="button"
        data-electron-no-drag
        data-window-control="sidebar"
        onClick={onToggleSidebar}
        className={cn(CONTROL_CLASS, 'transition-[left] duration-200')}
        style={{ top, left: sidebarLeft }}
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
          className={cn(CONTROL_CLASS, 'transition-[left] duration-200')}
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
          className={CONTROL_CLASS}
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
          className={cn(CONTROL_CLASS, mac ? 'right-4' : 'right-2')}
          style={{ top }}
          title={rightPanelCollapsed ? labels.showPanel : labels.hidePanel}
          aria-label={rightPanelCollapsed ? labels.showPanel : labels.hidePanel}
        >
          <PanelRight className="h-3.5 w-[18px]" strokeWidth={1.5} />
        </button>
      )}
    </>
  );

  if (windows) {
    return (
      <div
        data-abu-windows-titlebar
        className="fixed inset-x-0 top-0 z-50 h-8 bg-[var(--abu-bg-canvas)]"
      >
        <div
          data-abu-windows-titlebar-safe-area
          data-tauri-drag-region
          className="abu-windows-titlebar-safe-area absolute overflow-hidden"
        >
          {controls}
        </div>
      </div>
    );
  }

  return (
    <>
      {mac && (
        <div
          data-tauri-drag-region
          className="fixed inset-x-0 top-0 z-40 h-2"
        />
      )}
      <div
        className={cn(
          'fixed inset-x-0 top-0 z-40 pointer-events-none',
          mac ? 'h-11' : 'h-8',
        )}
      >
        {controls}
      </div>
    </>
  );
}
