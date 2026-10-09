// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import WindowTitleBar from './WindowTitleBar';

// App.tsx mounts DesignSystemProvider at the root; the icon buttons' tooltips need it.
function renderBar(barProps: ComponentProps<typeof WindowTitleBar>) {
  const view = render(<DesignSystemProvider><WindowTitleBar {...barProps} /></DesignSystemProvider>);
  return {
    ...view,
    rerender: (next: ComponentProps<typeof WindowTitleBar>) =>
      view.rerender(<DesignSystemProvider><WindowTitleBar {...next} /></DesignSystemProvider>),
  };
}

// The bar paints nothing behind itself, so the window's desk shows through.
function expectNoBackground(element: Element | null) {
  expect(element).not.toBeNull();
  expect([...(element?.classList ?? [])].filter((name) => name.startsWith('bg-'))).toEqual([]);
}

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
  it('embeds the existing Windows controls in the workspace header plane', async () => {
    const user = userEvent.setup();
    const callbacks = props();
    const { container } = renderBar(callbacks);

    const toolbar = container.querySelector('[data-abu-windows-toolbar]');
    const nativeTitlebar = container.querySelector('[data-abu-windows-native-titlebar]');
    const dragRegions = [...container.querySelectorAll('[data-abu-windows-drag-region]')];
    const menus = [...container.querySelectorAll('[data-window-menu]')];
    const controls = [...container.querySelectorAll('[data-window-control]')];
    const workspaceControls = container.querySelector('[data-abu-windows-workspace-controls]');
    expect(toolbar).toBeNull();
    expect(workspaceControls).not.toBeNull();
    expect(nativeTitlebar).toHaveClass('h-[30px]');
    expectNoBackground(nativeTitlebar);
    expect(nativeTitlebar).not.toHaveAttribute('data-tauri-drag-region');
    expect(dragRegions).toHaveLength(1);
    expect(dragRegions.map((region) => region.getAttribute('data-abu-windows-drag-region')))
      .toEqual(['titlebar']);
    dragRegions.forEach((region) => {
      expect(region).toHaveAttribute('data-tauri-drag-region');
      expect(region).not.toHaveAttribute('data-electron-no-drag');
      expect(region).toHaveClass('pointer-events-none', 'absolute', 'inset-0');
    });
    expect(menus).toHaveLength(3);
    menus.forEach((menu) => {
      expect(menu).toHaveAttribute('data-electron-no-drag');
      expect(menu).toHaveAttribute('aria-haspopup', 'menu');
    });
    expect(controls).toHaveLength(3);
    controls.forEach((control) => {
      expect(control).toHaveAttribute('data-electron-no-drag');
    });

    await user.click(screen.getByRole('button', { name: 'Show sidebar' }));
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await user.click(screen.getByRole('button', { name: 'Show panel' }));
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect(callbacks.onToggleSidebar).toHaveBeenCalledOnce();
    expect(callbacks.onOpenSearch).toHaveBeenCalledOnce();
    expect(callbacks.onNewTask).not.toHaveBeenCalled();
    expect(callbacks.onToggleRightPanel).toHaveBeenCalledOnce();
    expect(callbacks.onOpenWindowMenu).toHaveBeenCalledWith('edit', { x: 0, y: 0 });

    fireEvent.keyDown(window, { key: 'w', altKey: true });
    await waitFor(() => {
      expect(callbacks.onOpenWindowMenu).toHaveBeenCalledWith('window', { x: 0, y: 0 });
    });
  });

  it('moves only the existing left controls when the Windows sidebar changes state', () => {
    const { container, rerender } = renderBar(props({ sidebarCollapsed: false }));
    const expandedGroup = container.querySelector('[data-abu-titlebar-control-group="left"]');
    expect(expandedGroup).toHaveStyle({ top: '49px', left: '194px' });

    rerender(props({ sidebarCollapsed: true }));
    const collapsedGroup = container.querySelector('[data-abu-titlebar-control-group="left"]');
    expect(collapsedGroup).toHaveStyle({ top: '49px', left: '20px' });
    expect(screen.queryByRole('button', { name: 'New task' })).toBeNull();
  });

  it('keeps the legacy Windows business toolbar when Window Controls Overlay is unavailable', () => {
    const { container } = renderBar(props({ windowsTitleBarOverlay: false }));

    expect(container.querySelector('[data-abu-windows-native-titlebar]')).toBeNull();
    expect(container.querySelector('[data-abu-windows-toolbar]')).not.toBeNull();
    expectNoBackground(container.querySelector('[data-abu-windows-toolbar]'));
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
    const { container } = renderBar(callbacks);

    expect(container.querySelector('[data-abu-windows-toolbar]')).toBeNull();
    const overlay = container.querySelector('[data-abu-macos-titlebar]');
    const dragStrip = container.querySelector('[data-abu-macos-drag-strip]');
    expect(overlay).toHaveClass('fixed', 'h-11', 'pointer-events-none');
    expectNoBackground(overlay);
    expectNoBackground(dragStrip);
    expect(overlay).not.toHaveAttribute('data-tauri-drag-region');
    expect(dragStrip).toHaveClass('fixed', 'h-2');
    expect(dragStrip).toHaveAttribute('data-tauri-drag-region');
    const sidebarButton = screen.getByRole('button', { name: 'Hide sidebar' });
    expect(sidebarButton).toHaveAttribute('data-electron-no-drag');
    expect(sidebarButton).toHaveStyle({ top: '23px', left: '200px' });
    expect(overlay?.contains(sidebarButton)).toBe(true);
    // The buttons move with the sidebar at once and keep the icon button's colour fade.
    [sidebarButton, screen.getByRole('button', { name: 'Search' })].forEach((button) => {
      expect(button).toHaveClass('transition-colors', 'duration-fast');
      expect(button.className).not.toMatch(/transition-\[left\]|duration-base/);
    });

    await user.click(sidebarButton);
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(callbacks.onToggleSidebar).toHaveBeenCalledOnce();
    expect(callbacks.onOpenSearch).toHaveBeenCalledOnce();
  });

  it('shows each icon control name as its tooltip', async () => {
    const user = userEvent.setup();
    renderBar(props({ platform: 'macos', sidebarCollapsed: false }));

    // Keyboard focus opens a design-system tooltip at once; the name is the button's label.
    await user.tab();
    expect(screen.getByRole('button', { name: 'Hide sidebar' })).toHaveFocus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Hide sidebar');
  });

  it('uses the original collapsed macOS control positions', async () => {
    const user = userEvent.setup();
    const callbacks = props({ platform: 'macos' });
    const { container } = renderBar(callbacks);

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
