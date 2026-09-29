// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent, { PointerEventsCheckLevel } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button } from './button';
import { ContextMenu } from './context-menu';
import { AppIcons } from './icons';
import { Menu, MenuItem, MenuLabel, MenuSeparator, MenuSub } from './menu';
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

// Code opens the popover (open=true); the popover reports its own closes through onOpenChange.
function TrackedPopover({ requested }: { requested: boolean }) {
  const [open, setOpen] = useState(requested);
  const [lastRequested, setLastRequested] = useState(requested);
  if (requested !== lastRequested) {
    setLastRequested(requested);
    setOpen(requested);
  }
  return <Popover open={open} onOpenChange={setOpen} trigger={<Button>Details</Button>}>Popover body</Popover>;
}

function MenuThenTrackedPopover({ popoverRequested }: { popoverRequested: boolean }) {
  return (
    <>
      <TaskMenu onRename={() => undefined} />
      <TrackedPopover requested={popoverRequested} />
    </>
  );
}

function ContextMenuThenTrackedPopover({ popoverRequested, onOpenChange }: {
  popoverRequested: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <>
      <ContextMenu content={<MenuItem icon={AppIcons.copy}>Copy</MenuItem>} onOpenChange={onOpenChange}>
        <div>Message body</div>
      </ContextMenu>
      <TrackedPopover requested={popoverRequested} />
    </>
  );
}

// Lets Radix run the focus restore it schedules on a timer when a layer unmounts.
async function flushTimers() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
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

  it('leaves a popover opened by code open after it closes to make room', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<MenuThenTrackedPopover popoverRequested={false} />, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    rerender(<MenuThenTrackedPopover popoverRequested />);
    await flushTimers();
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

  it('dims a disabled item', async () => {
    const user = userEvent.setup();
    render(
      <Menu trigger={<Button>Actions</Button>}>
        <MenuItem>Rename</MenuItem>
        <MenuItem disabled>Archive</MenuItem>
      </Menu>,
      { wrapper: DesignSystemProvider },
    );
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    const disabled = screen.getByRole('menuitem', { name: 'Archive' });
    expect(disabled).toHaveAttribute('data-disabled');
    expect(disabled).toHaveClass('data-[disabled]:opacity-40');
    expect(screen.getByRole('menuitem', { name: 'Rename' })).not.toHaveAttribute('data-disabled');
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

  it('leaves a popover opened by code open after it closes to make room', async () => {
    // Earlier tests unmount open context menus; their focus restores must not land in this test.
    await flushTimers();
    const { rerender } = render(<ContextMenuThenTrackedPopover popoverRequested={false} />, { wrapper: DesignSystemProvider });
    fireEvent.contextMenu(screen.getByText('Message body'));
    expect(screen.getByRole('menuitem', { name: /Copy/ })).toBeInTheDocument();
    rerender(<ContextMenuThenTrackedPopover popoverRequested />);
    await flushTimers();
    expect(screen.queryByRole('menuitem', { name: /Copy/ })).toBeNull();
    expect(screen.getByText('Popover body')).toBeInTheDocument();
  });

  it('tells the caller it closed when another popover replaces it', () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(<ContextMenuThenTrackedPopover popoverRequested={false} onOpenChange={onOpenChange} />, { wrapper: DesignSystemProvider });
    fireEvent.contextMenu(screen.getByText('Message body'));
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    rerender(<ContextMenuThenTrackedPopover popoverRequested onOpenChange={onOpenChange} />);
    expect(screen.queryByRole('menuitem', { name: /Copy/ })).toBeNull();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
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

describe('onCloseAutoFocus', () => {
  // Radix restores focus from a timer once the closed menu has unmounted.
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); });

  function FocusField({ kind, onClose }: { kind: 'dropdown' | 'context'; onClose: (event: Event) => void }) {
    const items = <MenuItem>Rename</MenuItem>;
    return (
      <>
        {kind === 'dropdown'
          ? <Menu trigger={<Button>Actions</Button>} onCloseAutoFocus={onClose}>{items}</Menu>
          : <ContextMenu content={items} onCloseAutoFocus={onClose}><div tabIndex={0}>Message body</div></ContextMenu>}
        <input aria-label="Title" />
      </>
    );
  }

  const focusTitle = (event: Event) => {
    event.preventDefault();
    screen.getByRole('textbox', { name: 'Title', hidden: true }).focus();
  };

  it('lets a Menu caller keep focus off the trigger', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onClose = vi.fn(focusTitle);
    render(<FocusField kind="dropdown" onClose={onClose} />, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }));
    await act(() => vi.runOnlyPendingTimersAsync());
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveFocus();
  });

  it('returns focus to the Menu trigger when the caller does not prevent it', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onClose = vi.fn();
    render(<FocusField kind="dropdown" onClose={onClose} />, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }));
    await act(() => vi.runOnlyPendingTimersAsync());
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Actions' })).toHaveFocus();
  });

  it('runs after the layer handler, which still keeps focus where a replacing layer put it', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const seen: boolean[] = [];
    function MenuThenPopover({ popoverOpen }: { popoverOpen: boolean }) {
      return (
        <>
          <Menu trigger={<Button>Actions</Button>} onCloseAutoFocus={(event) => seen.push(event.defaultPrevented)}>
            <MenuItem>Rename</MenuItem>
          </Menu>
          <Popover open={popoverOpen} trigger={<Button>Details</Button>}>Popover body</Popover>
        </>
      );
    }
    const { rerender } = render(<MenuThenPopover popoverOpen={false} />, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    rerender(<MenuThenPopover popoverOpen />);
    await act(() => vi.runOnlyPendingTimersAsync());
    // The registry closed the menu, so the layer handler prevented the focus restore
    // before the caller's handler ran.
    expect(seen).toEqual([true]);
  });

  it('lets a ContextMenu caller keep focus off the element focused before it opened', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onClose = vi.fn(focusTitle);
    render(<FocusField kind="context" onClose={onClose} />, { wrapper: DesignSystemProvider });
    const target = screen.getByText('Message body');
    act(() => target.focus());
    fireEvent.contextMenu(target);
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }));
    await act(() => vi.runOnlyPendingTimersAsync());
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveFocus();
  });
});

describe('MenuSub', () => {
  function MoveMenu({ onMove }: { onMove: () => void }) {
    return (
      <Menu trigger={<Button>Actions</Button>}>
        <MenuItem>Rename</MenuItem>
        <MenuSub icon={AppIcons.folder} label="Move to">
          <MenuItem onSelect={onMove}>Launch plan</MenuItem>
        </MenuSub>
      </Menu>
    );
  }

  it('opens from its trigger with ArrowRight and closes the whole menu when an item is chosen', async () => {
    const user = userEvent.setup();
    const onMove = vi.fn();
    render(<MoveMenu onMove={onMove} />, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    expect(screen.queryByRole('menuitem', { name: 'Launch plan' })).toBeNull();
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Move to' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    const item = await screen.findByRole('menuitem', { name: 'Launch plan' });
    expect(item).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onMove).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens on hover and floats in its own panel that never drags the window', async () => {
    const user = userEvent.setup();
    render(<MoveMenu onMove={() => undefined} />, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    const trigger = screen.getByRole('menuitem', { name: 'Move to' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    await user.hover(trigger);
    const submenu = (await screen.findByRole('menuitem', { name: 'Launch plan' })).closest('[role="menu"]');
    expect(submenu).not.toBeNull();
    expect(submenu).not.toContainElement(trigger);
    expect(submenu).toHaveAttribute('data-electron-no-drag');
    expect(submenu).toHaveAttribute('data-ds-motion');
    expect(trigger).toHaveAttribute('data-state', 'open');
  });

  it('works inside a ContextMenu too', async () => {
    const user = userEvent.setup();
    const onMove = vi.fn();
    render(
      <ContextMenu content={<MenuSub label="Move to"><MenuItem onSelect={onMove}>Launch plan</MenuItem></MenuSub>}>
        <div>Message body</div>
      </ContextMenu>,
      { wrapper: DesignSystemProvider },
    );
    fireEvent.contextMenu(screen.getByText('Message body'));
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Move to' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(await screen.findByRole('menuitem', { name: 'Launch plan' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onMove).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();
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
