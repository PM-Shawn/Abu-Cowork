import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import WindowTitleBar from './WindowTitleBar';

function props(overrides: Record<string, unknown> = {}) {
  return {
    platform: 'windows',
    sidebarCollapsed: true,
    showSearch: true,
    showNewTask: true,
    showRightPanelToggle: true,
    rightPanelCollapsed: true,
    onToggleSidebar: vi.fn(),
    onOpenSearch: vi.fn(),
    onNewTask: vi.fn(),
    onToggleRightPanel: vi.fn(),
    labels: {
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
  it('keeps every Windows control clickable in a toolbar outside native chrome', async () => {
    const user = userEvent.setup();
    const callbacks = props();
    const { container } = render(<WindowTitleBar {...callbacks} />);

    const toolbar = container.querySelector('[data-abu-windows-toolbar]');
    const controls = [...container.querySelectorAll('[data-window-control]')];
    expect(toolbar).not.toBeNull();
    expect(toolbar).not.toHaveAttribute('data-tauri-drag-region');
    expect(controls).toHaveLength(4);
    controls.forEach((control) => {
      expect(control).toHaveAttribute('data-electron-no-drag');
    });

    await user.click(screen.getByRole('button', { name: 'Show sidebar' }));
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await user.click(screen.getByRole('button', { name: 'New task' }));
    await user.click(screen.getByRole('button', { name: 'Show panel' }));
    expect(callbacks.onToggleSidebar).toHaveBeenCalledOnce();
    expect(callbacks.onOpenSearch).toHaveBeenCalledOnce();
    expect(callbacks.onNewTask).toHaveBeenCalledOnce();
    expect(callbacks.onToggleRightPanel).toHaveBeenCalledOnce();
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
