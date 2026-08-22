import { useEffect, useRef, useState } from 'react';
import { PanelLeft, PanelRight, Plus, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import abuAvatar from '@/assets/abu-avatar.png';

type WindowMenuGroup = 'edit' | 'window' | 'help';

interface WindowTitleBarProps {
  platform: string;
  windowsTitleBarOverlay: boolean;
  sidebarCollapsed: boolean;
  showSearch: boolean;
  showNewTask: boolean;
  showRightPanelToggle: boolean;
  rightPanelCollapsed: boolean;
  onToggleSidebar: () => void;
  onOpenSearch: () => void;
  onNewTask: () => void;
  onToggleRightPanel: () => void;
  onOpenWindowMenu: (
    group: WindowMenuGroup,
    anchor: { x: number; y: number },
  ) => Promise<unknown> | unknown;
  labels: {
    appName: string;
    editMenu: string;
    windowMenu: string;
    helpMenu: string;
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
 * draggable; every control remains an explicit no-drag target. Electron on
 * Windows keeps native Window Controls Overlay buttons while the renderer owns
 * the compact title-bar visuals. Business controls sit inside the workspace
 * header plane instead of consuming a second full-width toolbar row.
 */
export default function WindowTitleBar({
  platform,
  windowsTitleBarOverlay,
  sidebarCollapsed,
  showSearch,
  showNewTask,
  showRightPanelToggle,
  rightPanelCollapsed,
  onToggleSidebar,
  onOpenSearch,
  onNewTask,
  onToggleRightPanel,
  onOpenWindowMenu,
  labels,
}: WindowTitleBarProps) {
  const [activeMenu, setActiveMenu] = useState<WindowMenuGroup | null>(null);
  const windowMenuButtons = useRef<Partial<Record<WindowMenuGroup, HTMLButtonElement | null>>>({});
  const mac = platform === 'macos';
  const windows = platform === 'windows';

  // Match the access-key hints shown in the Chinese labels. The legacy native
  // menu handled Alt+E/W/H automatically; once the bar is renderer-owned we
  // must forward those keys explicitly to avoid a visual-only regression.
  useEffect(() => {
    if (!windows || !windowsTitleBarOverlay) return;
    const groups: Record<string, WindowMenuGroup> = { e: 'edit', w: 'window', h: 'help' };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey) return;
      const group = groups[event.key.toLowerCase()];
      if (!group) return;
      const button = windowMenuButtons.current[group];
      if (!button) return;
      event.preventDefault();
      button.click();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [windows, windowsTitleBarOverlay]);

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
    const openMenu = (group: WindowMenuGroup, button: HTMLButtonElement) => {
      const rect = button.getBoundingClientRect();
      setActiveMenu(group);
      void Promise.resolve().then(() => onOpenWindowMenu(group, {
        x: Math.round(rect.left),
        y: Math.round(rect.bottom),
      })).catch((error) => {
        console.warn('[WindowTitleBar] Could not open Windows menu', error);
      }).finally(() => setActiveMenu(null));
    };

    if (windowsTitleBarOverlay) {
      const workspaceControlTop = 49;
      const workspaceControlLeft = sidebarCollapsed ? 20 : 194;

      return (
        <>
          <div
            data-abu-windows-native-titlebar
            className="relative h-[30px] shrink-0 select-none bg-[var(--abu-bg-canvas)]"
          >
            <div
              data-abu-windows-titlebar-safe-area
              className="absolute inset-y-0 flex items-center"
              style={{
                left: 'env(titlebar-area-x, 0px)',
                width: 'env(titlebar-area-width, calc(100% - 138px))',
              }}
            >
              <div
                data-tauri-drag-region
                className="pointer-events-none flex h-full items-center gap-1.5 pl-2 pr-1.5"
              >
                <img src={abuAvatar} alt="" className="h-4 w-4 rounded-[4px]" draggable={false} />
                <span className="text-minor font-medium text-[var(--abu-text-primary)]">
                  {labels.appName}
                </span>
              </div>
              <div
                data-electron-no-drag
                data-abu-window-menu-group
                className="flex h-full items-center"
              >
                {([
                  ['edit', labels.editMenu],
                  ['window', labels.windowMenu],
                  ['help', labels.helpMenu],
                ] as const).map(([group, label]) => (
                  <button
                    key={group}
                    ref={(button) => { windowMenuButtons.current[group] = button; }}
                    type="button"
                    data-electron-no-drag
                    data-window-menu={group}
                    aria-haspopup="menu"
                    aria-expanded={activeMenu === group}
                    onClick={(event) => openMenu(group, event.currentTarget)}
                    className={cn(
                      'h-7 rounded px-2 text-minor text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)]',
                      activeMenu === group && 'bg-[var(--abu-bg-hover)]',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div
                data-abu-windows-drag-region="titlebar"
                data-tauri-drag-region
                className="h-full min-w-8 flex-1"
                aria-hidden="true"
              />
            </div>
          </div>

          <div
            data-abu-windows-workspace-controls
            className="pointer-events-none fixed inset-0 z-40"
          >
            <div
              data-abu-titlebar-control-group="left"
              data-electron-no-drag
              className="pointer-events-auto absolute flex items-center gap-1 transition-[left] duration-200"
              style={{ top: workspaceControlTop, left: workspaceControlLeft }}
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
            </div>

            {showRightPanelToggle && (
              <button
                type="button"
                data-electron-no-drag
                data-window-control="right-panel"
                onClick={onToggleRightPanel}
                className={cn(CONTROL_CLASS, 'absolute right-4 pointer-events-auto')}
                style={{ top: workspaceControlTop }}
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

    return (
        <div
          data-abu-windows-toolbar
          className="flex h-9 shrink-0 items-center border-b border-[var(--abu-border)] bg-[var(--abu-bg-canvas)] px-2"
        >
          {leftControls}
          <div
            data-abu-windows-drag-region="toolbar"
            data-tauri-drag-region
            className="h-full min-w-8 flex-1"
            aria-hidden="true"
          />
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
