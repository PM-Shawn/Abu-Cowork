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
  it('keeps every Windows control clickable inside the native safe area', async () => {
    const user = userEvent.setup();
    const callbacks = props();
    const { container } = render(<WindowTitleBar {...callbacks} />);

    const titlebar = container.querySelector('[data-abu-windows-titlebar]');
    const safeArea = container.querySelector('[data-abu-windows-titlebar-safe-area]');
    const controls = [...container.querySelectorAll('[data-window-control]')];
    expect(titlebar).not.toBeNull();
    expect(safeArea).toHaveAttribute('data-tauri-drag-region');
    expect(safeArea).toHaveClass('abu-windows-titlebar-safe-area');
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

  it('keeps the existing macOS traffic-light overlay layout', () => {
    const { container } = render(
      <WindowTitleBar
        {...props({
          platform: 'macos',
          sidebarCollapsed: false,
          showNewTask: false,
          showRightPanelToggle: false,
        })}
      />,
    );

    expect(container.querySelector('[data-abu-windows-titlebar]')).toBeNull();
    expect(container.querySelector('[data-tauri-drag-region]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Hide sidebar' })).toHaveStyle({
      top: '23px',
      left: '200px',
    });
  });
});
