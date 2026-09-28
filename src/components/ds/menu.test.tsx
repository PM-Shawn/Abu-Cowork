// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent, { PointerEventsCheckLevel } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './button';
import { ContextMenu } from './context-menu';
import { AppIcons } from './icons';
import { Menu, MenuItem, MenuLabel, MenuSeparator } from './menu';
import { Popover } from './popover';
import { DesignSystemProvider } from './provider';

function TaskMenu({ onRename }: { onRename: () => void }) {
  return (
    <Menu trigger={<Button>Actions</Button>}>
      <MenuLabel>Task</MenuLabel>
      <MenuItem icon={AppIcons.rename} shortcut="⌘R" onSelect={onRename}>Rename</MenuItem>
      <MenuSeparator />
      <MenuItem icon={AppIcons.delete} tone="danger">Delete</MenuItem>
    </Menu>
  );
}

function MenuAndPopover({ popoverOpen }: { popoverOpen: boolean }) {
  return (
    <>
      <TaskMenu onRename={() => undefined} />
      <Popover open={popoverOpen} trigger={<Button>Details</Button>}>Popover body</Popover>
    </>
  );
}

function ContextMenuAndPopover({ popoverOpen }: { popoverOpen: boolean }) {
  return (
    <>
      <ContextMenu
        content={(
          <>
            <MenuLabel>Message</MenuLabel>
            <MenuItem icon={AppIcons.copy}>Copy</MenuItem>
            <MenuSeparator />
          </>
        )}
      >
        <div>Message body</div>
      </ContextMenu>
      <Popover open={popoverOpen} trigger={<Button>Details</Button>}>Popover body</Popover>
    </>
  );
}

function MenuAndContextMenu() {
  return (
    <>
      <TaskMenu onRename={() => undefined} />
      <ContextMenu content={<MenuItem icon={AppIcons.copy}>Copy</MenuItem>}>
        <div>Message body</div>
      </ContextMenu>
    </>
  );
}

describe('Menu', () => {
  it('opens from its trigger, runs the chosen item, and closes', async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();
    render(<TaskMenu onRename={onRename} />, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    const menu = screen.getByRole('menu');
    expect(menu).toHaveAttribute('data-ds-layer');
    expect(screen.getByText('⌘R')).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: /Rename/ }));
    expect(onRename).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('colors a destructive item and its icon', async () => {
    const user = userEvent.setup();
    render(<TaskMenu onRename={() => undefined} />, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    const item = screen.getByRole('menuitem', { name: /Delete/ });
    expect(item).toHaveClass('text-danger');
    expect(item.querySelector('svg')).toHaveClass('text-danger');
  });

  it('closes when another menu or popover opens', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<MenuAndPopover popoverOpen={false} />, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    rerender(<MenuAndPopover popoverOpen />);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByText('Popover body')).toBeInTheDocument();
  });

  it('closes when the user clicks outside it', async () => {
    // Radix sets pointer-events: none on the page behind a modal menu; the browser still
    // delivers the pointerdown Radix listens for, so skip user-event's own check.
    const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never });
    render(<><TaskMenu onRename={() => undefined} /><p>Elsewhere</p></>, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.click(screen.getByText('Elsewhere'));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('scales from its trigger', async () => {
    const user = userEvent.setup();
    render(<TaskMenu onRename={() => undefined} />, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    expect(screen.getByRole('menu')).toHaveClass('origin-(--radix-dropdown-menu-content-transform-origin)');
  });

  it('refuses items outside a menu', () => {
    expect(() => render(<MenuItem>Orphan</MenuItem>)).toThrow(/inside <Menu> or <ContextMenu>/);
  });
});

describe('ContextMenu', () => {
  it('opens on right-click with the same items', async () => {
    const user = userEvent.setup();
    const onCopy = vi.fn();
    render(
      <ContextMenu content={<MenuItem icon={AppIcons.copy} onSelect={onCopy}>Copy</MenuItem>}>
        <div>Message body</div>
      </ContextMenu>,
      { wrapper: DesignSystemProvider },
    );
    fireEvent.contextMenu(screen.getByText('Message body'));
    await user.click(screen.getByRole('menuitem', { name: /Copy/ }));
    expect(onCopy).toHaveBeenCalledOnce();
  });

  it('renders labels and separators like a dropdown menu', () => {
    render(<ContextMenuAndPopover popoverOpen={false} />, { wrapper: DesignSystemProvider });
    fireEvent.contextMenu(screen.getByText('Message body'));
    const menu = screen.getByRole('menu');
    expect(menu).toHaveTextContent('Message');
    expect(menu.querySelector('[role="separator"]')).not.toBeNull();
    expect(menu).toHaveClass('origin-(--radix-context-menu-content-transform-origin)');
  });

  it('closes when another popover opens, and opens again on the next right-click', () => {
    const { rerender } = render(<ContextMenuAndPopover popoverOpen={false} />, { wrapper: DesignSystemProvider });
    fireEvent.contextMenu(screen.getByText('Message body'));
    expect(screen.getByRole('menuitem', { name: /Copy/ })).toBeInTheDocument();
    rerender(<ContextMenuAndPopover popoverOpen />);
    expect(screen.queryByRole('menuitem', { name: /Copy/ })).toBeNull();
    expect(screen.getByText('Popover body')).toBeInTheDocument();
    fireEvent.contextMenu(screen.getByText('Message body'));
    expect(screen.getByRole('menuitem', { name: /Copy/ })).toBeInTheDocument();
  });

  it('closes an open dropdown menu when it opens', async () => {
    const user = userEvent.setup();
    render(<MenuAndContextMenu />, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    expect(screen.getByRole('menuitem', { name: /Rename/ })).toBeInTheDocument();
    fireEvent.contextMenu(screen.getByText('Message body'));
    expect(screen.queryByRole('menuitem', { name: /Rename/ })).toBeNull();
    expect(screen.getByRole('menuitem', { name: /Copy/ })).toBeInTheDocument();
  });
});

describe('Popover', () => {
  it('opens from its trigger and closes on Escape', async () => {
    const user = userEvent.setup();
    render(<Popover trigger={<Button>Details</Button>}>Popover body</Popover>, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('button', { name: 'Details' }));
    const content = screen.getByText('Popover body').closest('[data-ds-layer]');
    expect(content).toHaveClass('origin-(--radix-popover-content-transform-origin)');
    await user.keyboard('{Escape}');
    expect(screen.queryByText('Popover body')).toBeNull();
  });
});
