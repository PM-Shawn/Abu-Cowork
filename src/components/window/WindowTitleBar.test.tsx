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

  it('keeps macOS sidebar controls inside their own draggable header', async () => {
    const user = userEvent.setup();
    const callbacks = props({
      platform: 'macos',
      macPlacement: 'sidebar',
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
    const header = container.querySelector('[data-abu-macos-titlebar="sidebar"]');
    expect(header).toHaveAttribute('data-tauri-drag-region');
    expect(header?.querySelector('[data-abu-titlebar-control-group="left"]'))
      .toHaveAttribute('data-electron-no-drag');
    const sidebarButton = screen.getByRole('button', { name: 'Hide sidebar' });
    expect(sidebarButton).toHaveAttribute('data-electron-no-drag');
    expect(header?.contains(sidebarButton)).toBe(true);

    await user.click(sidebarButton);
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(callbacks.onToggleSidebar).toHaveBeenCalledOnce();
    expect(callbacks.onOpenSearch).toHaveBeenCalledOnce();
  });

  it('owns collapsed macOS controls in the main header', () => {
    const { container } = render(
      <WindowTitleBar {...props({ platform: 'macos', macPlacement: 'main' })} />,
    );

    const header = container.querySelector('[data-abu-macos-titlebar="main"]');
    expect(header).toHaveAttribute('data-tauri-drag-region');
    expect(header?.querySelectorAll('[data-window-control]')).toHaveLength(4);
    expect(header?.querySelectorAll('[data-electron-no-drag]')).not.toHaveLength(0);
  });

  it('renders the expanded macOS right-panel toggle inside the no-drag card', () => {
    const { container } = render(
      <WindowTitleBar
        {...props({
          platform: 'macos',
          macPlacement: 'panel',
          sidebarCollapsed: false,
          showNewTask: false,
        })}
      />,
    );

    expect(container.querySelector('[data-tauri-drag-region]')).toBeNull();
    expect(container.querySelector('[data-abu-macos-panel-controls]'))
      .toHaveAttribute('data-electron-no-drag');
    expect(screen.getByRole('button', { name: 'Show panel' }))
      .toHaveAttribute('data-electron-no-drag');
  });
});
