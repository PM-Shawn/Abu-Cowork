import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import WindowTitleBar from './WindowTitleBar';

function props(overrides: Record<string, unknown> = {}) {
  return {
    platform: 'windows',
    windowsTitleBarOverlay: true,
    sidebarCollapsed: true,
    showSearch: true,
    showNewTask: true,
    showRightPanelToggle: true,
    rightPanelCollapsed: true,
    onToggleSidebar: vi.fn(),
    onOpenSearch: vi.fn(),
    onNewTask: vi.fn(),
    onToggleRightPanel: vi.fn(),
    onOpenWindowMenu: vi.fn(),
    labels: {
      appName: 'Abu',
      editMenu: 'Edit',
      windowMenu: 'Window',
      helpMenu: 'Help',
      showSidebar: 'Show sidebar',
      hideSidebar: 'Hide sidebar',
      search: 'Search',
      newTask: 'New task',
      showPanel: 'Show panel',
      hidePanel: 'Hide panel',
    },
    ...overrides,
  };
}

describe('WindowTitleBar', () => {
  it('keeps native menus and every Windows business control clickable', async () => {
    const user = userEvent.setup();
    const callbacks = props();
    const { container } = render(<WindowTitleBar {...callbacks} />);

    const toolbar = container.querySelector('[data-abu-windows-toolbar]');
    const nativeTitlebar = container.querySelector('[data-abu-windows-native-titlebar]');
    const dragRegions = [...container.querySelectorAll('[data-abu-windows-drag-region]')];
    const menus = [...container.querySelectorAll('[data-window-menu]')];
    const controls = [...container.querySelectorAll('[data-window-control]')];
    expect(toolbar).not.toBeNull();
    expect(nativeTitlebar).not.toHaveAttribute('data-tauri-drag-region');
    expect(toolbar).not.toHaveAttribute('data-tauri-drag-region');
    expect(dragRegions).toHaveLength(2);
    expect(dragRegions.map((region) => region.getAttribute('data-abu-windows-drag-region')))
      .toEqual(['titlebar', 'toolbar']);
    dragRegions.forEach((region) => {
      expect(region).toHaveAttribute('data-tauri-drag-region');
      expect(region).not.toHaveAttribute('data-electron-no-drag');
    });
    expect(menus).toHaveLength(3);
    menus.forEach((menu) => {
      expect(menu).toHaveAttribute('data-electron-no-drag');
      expect(menu).toHaveAttribute('aria-haspopup', 'menu');
    });
    expect(controls).toHaveLength(4);
    controls.forEach((control) => {
      expect(control).toHaveAttribute('data-electron-no-drag');
    });

    await user.click(screen.getByRole('button', { name: 'Show sidebar' }));
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await user.click(screen.getByRole('button', { name: 'New task' }));
    await user.click(screen.getByRole('button', { name: 'Show panel' }));
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect(callbacks.onToggleSidebar).toHaveBeenCalledOnce();
    expect(callbacks.onOpenSearch).toHaveBeenCalledOnce();
    expect(callbacks.onNewTask).toHaveBeenCalledOnce();
    expect(callbacks.onToggleRightPanel).toHaveBeenCalledOnce();
    expect(callbacks.onOpenWindowMenu).toHaveBeenCalledWith('edit', { x: 0, y: 0 });

    fireEvent.keyDown(window, { key: 'w', altKey: true });
    await waitFor(() => {
      expect(callbacks.onOpenWindowMenu).toHaveBeenCalledWith('window', { x: 0, y: 0 });
    });
  });

  it('keeps the legacy Windows business toolbar when Window Controls Overlay is unavailable', () => {
    const { container } = render(
      <WindowTitleBar {...props({ windowsTitleBarOverlay: false })} />,
    );

    expect(container.querySelector('[data-abu-windows-native-titlebar]')).toBeNull();
    expect(container.querySelector('[data-abu-windows-toolbar]')).not.toBeNull();
    expect(container.querySelectorAll('[data-window-menu]')).toHaveLength(0);
  });

  it('restores the compact macOS overlay without making controls draggable', async () => {
    const user = userEvent.setup();
    const callbacks = props({
      platform: 'macos',
      sidebarCollapsed: false,
      showNewTask: false,
      showRightPanelToggle: false,
    });
    const { container } = render(
      <WindowTitleBar
        {...callbacks}
      />,
    );

    expect(container.querySelector('[data-abu-windows-toolbar]')).toBeNull();
    const overlay = container.querySelector('[data-abu-macos-titlebar]');
    const dragStrip = container.querySelector('[data-abu-macos-drag-strip]');
    expect(overlay).toHaveClass('fixed', 'h-11', 'pointer-events-none');
    expect(overlay).not.toHaveAttribute('data-tauri-drag-region');
    expect(dragStrip).toHaveClass('fixed', 'h-2');
    expect(dragStrip).toHaveAttribute('data-tauri-drag-region');
    const sidebarButton = screen.getByRole('button', { name: 'Hide sidebar' });
    expect(sidebarButton).toHaveAttribute('data-electron-no-drag');
    expect(sidebarButton).toHaveStyle({ top: '23px', left: '200px' });
    expect(overlay?.contains(sidebarButton)).toBe(true);

    await user.click(sidebarButton);
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(callbacks.onToggleSidebar).toHaveBeenCalledOnce();
    expect(callbacks.onOpenSearch).toHaveBeenCalledOnce();
  });

  it('uses the original collapsed macOS control positions', async () => {
    const user = userEvent.setup();
    const callbacks = props({ platform: 'macos' });
    const { container } = render(
      <WindowTitleBar {...callbacks} />,
    );

    const overlay = container.querySelector('[data-abu-macos-titlebar]');
    const controls = [...container.querySelectorAll('[data-window-control]')];
    expect(controls).toHaveLength(4);
    controls.forEach((control) => {
      expect(control).toHaveAttribute('data-electron-no-drag');
      expect(overlay?.contains(control)).toBe(true);
    });
    expect(screen.getByRole('button', { name: 'Show sidebar' }))
      .toHaveStyle({ top: '23px', left: '96px' });
    expect(screen.getByRole('button', { name: 'Search' }))
      .toHaveStyle({ top: '23px', left: '126px' });
    expect(screen.getByRole('button', { name: 'New task' }))
      .toHaveStyle({ top: '23px', left: '156px' });
    expect(screen.getByRole('button', { name: 'Show panel' }))
      .toHaveClass('right-4');

    await user.click(screen.getByRole('button', { name: 'Show sidebar' }));
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await user.click(screen.getByRole('button', { name: 'New task' }));
    await user.click(screen.getByRole('button', { name: 'Show panel' }));
    expect(callbacks.onToggleSidebar).toHaveBeenCalledOnce();
    expect(callbacks.onOpenSearch).toHaveBeenCalledOnce();
    expect(callbacks.onNewTask).toHaveBeenCalledOnce();
    expect(callbacks.onToggleRightPanel).toHaveBeenCalledOnce();
  });
});
