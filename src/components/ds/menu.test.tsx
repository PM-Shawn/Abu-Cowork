// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { useState, type ReactElement } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { PointerEventsCheckLevel } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button, IconButton } from './button';
import { ContextMenu } from './context-menu';
import { Dialog } from './dialog';
import { AppIcons } from './icons';
import { Menu, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuSub } from './menu';
import { Popover } from './popover';
import { Pressable } from './pressable';
import { DesignSystemProvider } from './provider';
import { keepClosingLayersOnScreen } from '@/test/dsWindows';

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

  it('stays open when the chosen item prevents the select event', async () => {
    const user = userEvent.setup();
    const onCheck = vi.fn((event: Event) => event.preventDefault());
    render(
      <Menu trigger={<Button>Actions</Button>}>
        <MenuItem onSelect={onCheck}>Check for updates</MenuItem>
      </Menu>,
      { wrapper: DesignSystemProvider },
    );
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Check for updates' }));
    expect(onCheck).toHaveBeenCalledOnce();
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('names a described menu item by its first line and describes it with the second', async () => {
    const user = userEvent.setup();
    render(
      <Menu trigger={<Button>Versions</Button>}>
        <MenuItem icon={AppIcons.history} shortcut="⌘Z" description="Before AI edit · 2.1 KB">10:24:31</MenuItem>
        <MenuItem icon={AppIcons.copy} shortcut="⌘C">Plain</MenuItem>
      </Menu>,
      { wrapper: DesignSystemProvider },
    );
    await user.click(screen.getByRole('button', { name: 'Versions' }));
    const item = screen.getByRole('menuitem', { name: /10:24:31/ });
    expect(within(item).getByText('10:24:31')).toBeVisible();
    expect(item).not.toHaveAccessibleName(/Before AI edit/);
    expect(item).toHaveAccessibleDescription('Before AI edit · 2.1 KB');
    expect(screen.getByText('Before AI edit · 2.1 KB')).toBeVisible();
    expect(item).toHaveClass('h-auto');
    expect(item).not.toHaveClass('h-6');
    // The icon and the shortcut sit level with the first line, not at the top edge of the row.
    expect(item.querySelector('svg')).toHaveClass('mt-0.5');
    expect(within(item).getByText('⌘Z')).toHaveClass('mt-0.5');
    const plain = screen.getByRole('menuitem', { name: /Plain/ });
    expect(plain).not.toHaveAttribute('aria-describedby');
    expect(plain).not.toHaveClass('h-auto');
    expect(plain).toHaveClass('h-6');
    expect(plain.querySelector('svg')).not.toHaveClass('mt-0.5');
    expect(within(plain).getByText('⌘C')).not.toHaveClass('mt-0.5');
  });

  it('describes an item inside a ContextMenu too', async () => {
    render(
      <ContextMenu content={<MenuItem icon={AppIcons.history} description="Before AI edit · 2.1 KB">10:24:31</MenuItem>}>
        <div>Message body</div>
      </ContextMenu>,
      { wrapper: DesignSystemProvider },
    );
    fireEvent.contextMenu(screen.getByText('Message body'));
    const item = await screen.findByRole('menuitem', { name: '10:24:31' });
    expect(item).toHaveAccessibleDescription('Before AI edit · 2.1 KB');
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

  // A long list must not run past the window edge: the panel takes the room Radix measures and scrolls.
  it('never grows taller than the room the window leaves, and scrolls instead', async () => {
    const user = userEvent.setup();
    render(<TaskMenu onRename={() => undefined} />, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    const menu = screen.getByRole('menu');
    expect(menu).toHaveClass('max-h-(--radix-dropdown-menu-content-available-height)');
    expect(menu).toHaveClass('overflow-y-auto');
  });

  it('shows a native hint on an item that carries a title, in both kinds of menu', async () => {
    const user = userEvent.setup();
    render(
      <>
        <Menu trigger={<Button>Versions</Button>}>
          <MenuItem title="Revert to this version">10:00:00</MenuItem>
          <MenuItem>10:00:01</MenuItem>
        </Menu>
        <ContextMenu content={<MenuItem title="Copy the text">Copy</MenuItem>}>
          <div>Message body</div>
        </ContextMenu>
      </>,
      { wrapper: DesignSystemProvider },
    );
    await user.click(screen.getByRole('button', { name: 'Versions' }));
    expect(screen.getByRole('menuitem', { name: '10:00:00' })).toHaveAttribute('title', 'Revert to this version');
    expect(screen.getByRole('menuitem', { name: '10:00:01' })).not.toHaveAttribute('title');
    await user.keyboard('{Escape}');
    fireEvent.contextMenu(screen.getByText('Message body'));
    expect(screen.getByRole('menuitem', { name: 'Copy' })).toHaveAttribute('title', 'Copy the text');
  });

  it('puts the caller\'s data attributes on its content, and none of its own can be replaced', async () => {
    const user = userEvent.setup();
    render(
      <Menu trigger={<Button>Actions</Button>} contentProps={{ 'data-testid': 'row-menu', 'data-ds-layer': 'mine' }}>
        <MenuItem>Rename</MenuItem>
      </Menu>,
      { wrapper: DesignSystemProvider },
    );
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    const menu = screen.getByTestId('row-menu');
    expect(menu).toHaveAttribute('role', 'menu');
    expect(menu).toHaveAttribute('data-ds-layer', 'true');
  });

  it('puts a test id on the item that asks for one, in both kinds of menu, and nothing on the others', async () => {
    const user = userEvent.setup();
    render(
      <>
        <Menu trigger={<Button>Actions</Button>}>
          <MenuItem testId="row-menu-delete">删除</MenuItem>
          <MenuItem>Rename</MenuItem>
        </Menu>
        <ContextMenu content={<MenuItem testId="message-copy">Copy</MenuItem>}>
          <div>Message body</div>
        </ContextMenu>
      </>,
      { wrapper: DesignSystemProvider },
    );
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    const item = screen.getByTestId('row-menu-delete');
    expect(item).toHaveAttribute('role', 'menuitem');
    expect(screen.getByRole('menuitem', { name: '删除' })).toBe(item);
    expect(screen.getByRole('menuitem', { name: 'Rename' })).not.toHaveAttribute('data-testid');
    expect(screen.getByRole('menu')).not.toHaveAttribute('data-testid');
    await user.keyboard('{Escape}');
    fireEvent.contextMenu(screen.getByText('Message body'));
    expect(screen.getByTestId('message-copy')).toBe(screen.getByRole('menuitem', { name: 'Copy' }));
  });

  // React sends a click inside the portaled menu up to the menu's React ancestors. A card or a row
  // that opens on click must not open because its own menu was pressed.
  it('keeps a press on the menu from reaching a clickable ancestor, and still runs the chosen item', async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    const onRename = vi.fn();
    render(
      // A stand-in for a card that opens on click and holds a menu.
      <div role="presentation" onClick={onRowClick}>
        <Menu trigger={<Button>Actions</Button>}>
          <MenuLabel>Task</MenuLabel>
          <MenuItem onSelect={onRename}>Rename</MenuItem>
        </Menu>
      </div>,
      { wrapper: DesignSystemProvider },
    );
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    onRowClick.mockClear();

    // The padding of the panel, a label: places in the menu that are not an item.
    await user.click(screen.getByRole('menu'));
    await user.click(screen.getByText('Task'));
    expect(onRowClick).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeInTheDocument();

    await user.click(screen.getByRole('menuitem', { name: 'Rename' }));
    expect(onRename).toHaveBeenCalledOnce();
    expect(onRowClick).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
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
    expect(menu).toHaveClass('max-h-(--radix-context-menu-content-available-height)');
    expect(menu).toHaveClass('overflow-y-auto');
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

  // Radix keeps the content mounted while it animates out, and a second right-click in
  // that time would reuse it where it stood. Every opening gets content of its own.
  it('gives a ContextMenu opened again new content, which keeps the focus', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const seen: boolean[] = [];
    render(<FocusField kind="context" onClose={(event) => seen.push(event.defaultPrevented)} />, { wrapper: DesignSystemProvider });
    const target = screen.getByText('Message body');
    act(() => target.focus());
    fireEvent.contextMenu(target);
    const first = screen.getByRole('menu');

    fireEvent.contextMenu(target);
    await act(() => vi.runOnlyPendingTimersAsync());

    const second = screen.getByRole('menu');
    expect(screen.getAllByRole('menu')).toHaveLength(1);
    expect(second).not.toBe(first);
    // The replaced content closed without taking the focus back from the new one.
    expect(seen).toEqual([true]);
    expect(second.contains(document.activeElement)).toBe(true);

    await user.keyboard('{Escape}');
    await act(() => vi.runOnlyPendingTimersAsync());

    expect(screen.queryByRole('menu')).toBeNull();
    // The focus goes back to the element that had it before the first opening; the
    // caller's hook saw an event it could still have prevented.
    expect(seen).toEqual([true, false]);
    expect(target).toHaveFocus();
  });

  it('leaves the focus to a caller that takes it after a ContextMenu was opened again', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<FocusField kind="context" onClose={focusTitle} />, { wrapper: DesignSystemProvider });
    const target = screen.getByText('Message body');
    act(() => target.focus());
    fireEvent.contextMenu(target);
    fireEvent.contextMenu(target);
    await act(() => vi.runOnlyPendingTimersAsync());

    await user.click(screen.getByRole('menuitem', { name: 'Rename' }));
    await act(() => vi.runOnlyPendingTimersAsync());

    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveFocus();
  });

  it('gives the focus back as before when a ContextMenu was opened once', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const seen: boolean[] = [];
    render(<FocusField kind="context" onClose={(event) => seen.push(event.defaultPrevented)} />, { wrapper: DesignSystemProvider });
    const target = screen.getByText('Message body');
    act(() => target.focus());
    fireEvent.contextMenu(target);
    await user.keyboard('{Escape}');
    await act(() => vi.runOnlyPendingTimersAsync());
    // Closed, then opened again by a new right-click: a new session, not a reopening.
    act(() => screen.getByRole('textbox', { name: 'Title' }).focus());
    fireEvent.contextMenu(target);
    await user.keyboard('{Escape}');
    await act(() => vi.runOnlyPendingTimersAsync());

    expect(seen).toEqual([false, false]);
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveFocus();
  });
});

describe('MenuRadioGroup', () => {
  const themes = (
    <>
      <MenuRadioItem value="system">System</MenuRadioItem>
      <MenuRadioItem value="light">Light</MenuRadioItem>
      <MenuRadioItem value="dark">Dark</MenuRadioItem>
    </>
  );

  it('marks the current choice, reports a new one, and closes the menu', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <Menu trigger={<Button>Appearance</Button>}>
        <MenuRadioGroup value="light" onValueChange={onValueChange}>{themes}</MenuRadioGroup>
      </Menu>,
      { wrapper: DesignSystemProvider },
    );
    await user.click(screen.getByRole('button', { name: 'Appearance' }));
    const light = screen.getByRole('menuitemradio', { name: 'Light' });
    expect(light).toHaveAttribute('aria-checked', 'true');
    expect(light.querySelector('svg')).not.toBeNull();
    const dark = screen.getByRole('menuitemradio', { name: 'Dark' });
    expect(dark).toHaveAttribute('aria-checked', 'false');
    expect(dark.querySelector('svg')).toBeNull();
    await user.click(dark);
    expect(onValueChange).toHaveBeenCalledWith('dark');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('is reachable from the keyboard inside a submenu', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <Menu trigger={<Button>Account</Button>}>
        <MenuSub label="Appearance">
          <MenuRadioGroup value="system" onValueChange={onValueChange}>{themes}</MenuRadioGroup>
        </MenuSub>
      </Menu>,
      { wrapper: DesignSystemProvider },
    );
    await user.click(screen.getByRole('button', { name: 'Account' }));
    await user.keyboard('{ArrowDown}{ArrowRight}');
    expect(await screen.findByRole('menuitemradio', { name: 'System' })).toHaveFocus();
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onValueChange).toHaveBeenCalledWith('light');
  });

  it('shows a description under a choice and reads it as the description, not the name', async () => {
    const user = userEvent.setup();
    render(
      <Menu trigger={<Button>Mode</Button>}>
        <MenuRadioGroup value="ask" onValueChange={vi.fn()}>
          <MenuRadioItem value="ask" description="Asks before anything outside the folder">Ask</MenuRadioItem>
          <MenuRadioItem value="plain">Plain</MenuRadioItem>
        </MenuRadioGroup>
      </Menu>,
      { wrapper: DesignSystemProvider },
    );
    await user.click(screen.getByRole('button', { name: 'Mode' }));
    const ask = screen.getByRole('menuitemradio', { name: 'Ask' });
    expect(ask).toHaveAccessibleName('Ask');
    expect(ask).toHaveAccessibleDescription('Asks before anything outside the folder');
    expect(screen.getByText('Asks before anything outside the folder')).toBeVisible();
    expect(screen.getByRole('menuitemradio', { name: 'Plain' })).not.toHaveAttribute('aria-describedby');
  });

  it('works inside a ContextMenu too', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <ContextMenu content={<MenuRadioGroup value="dark" onValueChange={onValueChange}>{themes}</MenuRadioGroup>}>
        <div>Message body</div>
      </ContextMenu>,
      { wrapper: DesignSystemProvider },
    );
    fireEvent.contextMenu(screen.getByText('Message body'));
    expect(await screen.findByRole('menuitemradio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByRole('menuitemradio', { name: 'System' }));
    expect(onValueChange).toHaveBeenCalledWith('system');
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

  it('sits on the dialog level inside a dialog and on the popover level on the page', async () => {
    const user = userEvent.setup();
    const openSubmenu = async () => {
      await user.click(screen.getByRole('button', { name: 'Actions' }));
      await user.keyboard('{ArrowDown}{ArrowDown}{ArrowRight}');
      return (await screen.findByRole('menuitem', { name: 'Launch plan' })).closest('[role="menu"]');
    };
    const { unmount } = render(<Dialog open title="Host"><MoveMenu onMove={() => undefined} /></Dialog>, { wrapper: DesignSystemProvider });
    const inDialog = await openSubmenu();
    expect(inDialog).toHaveClass('z-dialog');
    expect(inDialog).not.toHaveClass('z-popover');
    unmount();
    render(<MoveMenu onMove={() => undefined} />, { wrapper: DesignSystemProvider });
    const onPage = await openSubmenu();
    expect(onPage).toHaveClass('z-popover');
    expect(onPage).not.toHaveClass('z-dialog');
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

// A menu chooses an item on the key-down of Enter or Space. The key that opened the menu is
// still down when the menu shows with the focus on its first item.
describe('keys held in a menu', () => {
  const down = (target: Element, key: string, code = key) => fireEvent.keyDown(target, { key, code });
  const repeat = (target: Element, key: string, code = key) => fireEvent.keyDown(target, { key, code, repeat: true });
  const up = (target: Element, key: string, code = key) => fireEvent.keyUp(target, { key, code });
  const focused = () => document.activeElement as HTMLElement;
  // keepClosingLayersOnScreen() replaces getComputedStyle for the case that calls it.
  afterEach(() => { vi.restoreAllMocks(); });

  function FileMenu({ onPick }: { onPick: (name: string) => void }) {
    return (
      <Menu trigger={<Button>Actions</Button>}>
        <MenuItem onSelect={() => onPick('Rename')}>Rename</MenuItem>
        <MenuItem onSelect={() => onPick('Export')}>Export</MenuItem>
        <MenuItem onSelect={() => onPick('Archive')}>Archive</MenuItem>
        <MenuSub label="Move to">
          <MenuItem onSelect={() => onPick('Launch plan')}>Launch plan</MenuItem>
          <MenuItem onSelect={() => onPick('Inbox')}>Inbox</MenuItem>
          <MenuItem onSelect={() => onPick('Someday')}>Someday</MenuItem>
        </MenuSub>
      </Menu>
    );
  }

  it('does not choose the first item with the Enter that opened the menu; released and pressed again, Enter chooses', async () => {
    const onPick = vi.fn();
    render(<FileMenu onPick={onPick} />, { wrapper: DesignSystemProvider });
    const trigger = screen.getByRole('button', { name: 'Actions' });
    trigger.focus();
    down(trigger, 'Enter');
    const first = await screen.findByRole('menuitem', { name: 'Rename' });
    first.focus();
    for (let i = 0; i < 5; i += 1) expect(repeat(focused(), 'Enter')).toBe(false);
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeInTheDocument();
    up(focused(), 'Enter');
    down(focused(), 'Enter');
    expect(onPick.mock.calls).toEqual([['Rename']]);
  });

  it('does not choose with a Space that opened the menu either', async () => {
    const onPick = vi.fn();
    render(<FileMenu onPick={onPick} />, { wrapper: DesignSystemProvider });
    const trigger = screen.getByRole('button', { name: 'Actions' });
    trigger.focus();
    down(trigger, ' ', 'Space');
    (await screen.findByRole('menuitem', { name: 'Rename' })).focus();
    expect(repeat(focused(), ' ', 'Space')).toBe(false);
    expect(onPick).not.toHaveBeenCalled();
  });

  it('does not walk the list with the ArrowDown that opened the menu until it is pressed again', async () => {
    render(<FileMenu onPick={() => undefined} />, { wrapper: DesignSystemProvider });
    const trigger = screen.getByRole('button', { name: 'Actions' });
    trigger.focus();
    down(trigger, 'ArrowDown');
    const first = await screen.findByRole('menuitem', { name: 'Rename' });
    first.focus();
    expect(repeat(focused(), 'ArrowDown')).toBe(false);
    // Radix moves the focus one timer tick after an arrow it took.
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
    expect(first).toHaveFocus();
    up(focused(), 'ArrowDown');
    down(focused(), 'ArrowDown');
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Export' })).toHaveFocus());
    expect(repeat(focused(), 'ArrowDown')).toBe(false);
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Archive' })).toHaveFocus());
  });

  it('walks the list with an ArrowDown pressed inside the menu and held', async () => {
    const user = userEvent.setup();
    render(<FileMenu onPick={() => undefined} />, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    const menu = screen.getByRole('menu');
    down(focused(), 'ArrowDown');
    await waitFor(() => expect(within(menu).getByRole('menuitem', { name: 'Rename' })).toHaveFocus());
    repeat(focused(), 'ArrowDown');
    await waitFor(() => expect(within(menu).getByRole('menuitem', { name: 'Export' })).toHaveFocus());
    repeat(focused(), 'ArrowDown');
    await waitFor(() => expect(within(menu).getByRole('menuitem', { name: 'Archive' })).toHaveFocus());
    repeat(focused(), 'ArrowDown');
    await waitFor(() => expect(within(menu).getByRole('menuitem', { name: 'Move to' })).toHaveFocus());
  });

  it('does not choose the first item of a nested list with the Enter that opened that list', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<FileMenu onPick={onPick} />, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    const sub = screen.getByRole('menuitem', { name: 'Move to' });
    sub.focus();
    down(sub, 'Enter');
    const nested = await screen.findByRole('menuitem', { name: 'Launch plan' });
    nested.focus();
    for (let i = 0; i < 5; i += 1) expect(repeat(focused(), 'Enter')).toBe(false);
    expect(onPick).not.toHaveBeenCalled();
    up(focused(), 'Enter');
    down(focused(), 'Enter');
    expect(onPick.mock.calls).toEqual([['Launch plan']]);
  });

  it('walks a nested list with an ArrowDown pressed inside it and held', async () => {
    const user = userEvent.setup();
    render(<FileMenu onPick={() => undefined} />, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    const sub = screen.getByRole('menuitem', { name: 'Move to' });
    sub.focus();
    await user.keyboard('{ArrowRight}');
    expect(await screen.findByRole('menuitem', { name: 'Launch plan' })).toHaveFocus();
    down(focused(), 'ArrowDown');
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Inbox' })).toHaveFocus());
    repeat(focused(), 'ArrowDown');
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Someday' })).toHaveFocus());
  });

  it('does not choose in a context menu with a key that was down when it opened', async () => {
    const onPick = vi.fn();
    render(
      <ContextMenu content={<><MenuItem onSelect={() => onPick('Copy')}>Copy</MenuItem><MenuItem onSelect={() => onPick('Quote')}>Quote</MenuItem></>}>
        <div>Message body</div>
      </ContextMenu>,
      { wrapper: DesignSystemProvider },
    );
    down(document.body, 'Enter');
    fireEvent.contextMenu(screen.getByText('Message body'));
    const copy = await screen.findByRole('menuitem', { name: 'Copy' });
    copy.focus();
    for (let i = 0; i < 5; i += 1) expect(repeat(focused(), 'Enter')).toBe(false);
    expect(onPick).not.toHaveBeenCalled();
    up(focused(), 'Enter');
    down(focused(), 'Enter');
    expect(onPick.mock.calls).toEqual([['Copy']]);
  });

  it('chooses once with an Enter pressed inside the menu and held: the item is not chosen again while the menu fades out', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    keepClosingLayersOnScreen();
    render(<FileMenu onPick={onPick} />, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    const item = screen.getByRole('menuitem', { name: 'Export' });
    item.focus();
    down(item, 'Enter');
    expect(onPick.mock.calls).toEqual([['Export']]);
    // The menu is closing and still on the page; the key repeats on the item.
    expect(item).toBeInTheDocument();
    for (let i = 0; i < 4; i += 1) expect(repeat(item, 'Enter')).toBe(false);
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it('chooses once with a Space pressed inside the menu and held', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    keepClosingLayersOnScreen();
    render(<FileMenu onPick={onPick} />, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    const item = screen.getByRole('menuitem', { name: 'Archive' });
    item.focus();
    down(item, ' ', 'Space');
    for (let i = 0; i < 4; i += 1) expect(repeat(item, ' ', 'Space')).toBe(false);
    expect(onPick.mock.calls).toEqual([['Archive']]);
  });

  it('leaves Escape to the menu: a held Escape closes it', async () => {
    const user = userEvent.setup();
    render(<FileMenu onPick={() => undefined} />, { wrapper: DesignSystemProvider });
    down(document.body, 'Escape');
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    repeat(focused(), 'Escape');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });
});

// A screen reader activates a button with a click alone: no pointer goes down before it and no
// key. `element.click()` makes the same event (`detail` 0).
describe('a menu trigger under a click that no pointer and no key made', () => {
  const TRIGGERS: [string, () => ReactElement][] = [
    ['a Button', () => <Button>Actions</Button>],
    ['an IconButton', () => <IconButton icon={AppIcons.more} label="Actions" />],
    ['a Pressable', () => <Pressable>Actions</Pressable>],
  ];
  const trigger = () => screen.getByRole('button', { name: 'Actions', hidden: true });
  const opened = (onOpenChange: ReturnType<typeof vi.fn>) => onOpenChange.mock.calls.filter(([open]) => open === true).length;

  function ActionsMenu({ children, onOpenChange, onPick = () => undefined }: { children: ReactElement; onOpenChange: (open: boolean) => void; onPick?: () => void }) {
    return (
      <Menu trigger={children} onOpenChange={onOpenChange}>
        <MenuItem onSelect={onPick}>Rename</MenuItem>
        <MenuItem>Delete</MenuItem>
      </Menu>
    );
  }

  describe.each(TRIGGERS)('%s', (_name, ui) => {
    it('opens the menu once, and a second such click leaves it open', async () => {
      const onOpenChange = vi.fn();
      render(<ActionsMenu onOpenChange={onOpenChange}>{ui()}</ActionsMenu>, { wrapper: DesignSystemProvider });

      act(() => { trigger().click(); });

      expect(await screen.findByRole('menu')).toBeInTheDocument();
      expect(trigger()).toHaveAttribute('aria-expanded', 'true');
      expect(opened(onOpenChange)).toBe(1);

      act(() => { trigger().click(); });

      expect(screen.getAllByRole('menu')).toHaveLength(1);
      expect(onOpenChange.mock.calls).toEqual([[true]]);
    });

    it('opens once for a pointer press and once for each opening key', async () => {
      const user = userEvent.setup();
      const onOpenChange = vi.fn();
      render(<ActionsMenu onOpenChange={onOpenChange}>{ui()}</ActionsMenu>, { wrapper: DesignSystemProvider });

      await user.click(trigger());
      expect(screen.getAllByRole('menu')).toHaveLength(1);
      expect(onOpenChange.mock.calls).toEqual([[true]]);

      for (const key of ['{Enter}', ' ', '{ArrowDown}']) {
        await user.keyboard('{Escape}');
        await flushTimers();
        expect(screen.queryByRole('menu')).toBeNull();
        onOpenChange.mockClear();
        act(() => { trigger().focus(); });
        await user.keyboard(key);
        expect(screen.getAllByRole('menu')).toHaveLength(1);
        expect(onOpenChange.mock.calls).toEqual([[true]]);
      }
    });

    it('opens again after it was closed, and after a pointer press whose click went elsewhere', async () => {
      const user = userEvent.setup();
      const onOpenChange = vi.fn();
      render(<ActionsMenu onOpenChange={onOpenChange}>{ui()}</ActionsMenu>, { wrapper: DesignSystemProvider });

      act(() => { trigger().click(); });
      await user.keyboard('{Escape}');
      await flushTimers();
      expect(screen.queryByRole('menu')).toBeNull();

      // The pointer goes down on the trigger and the menu opens; with the menu open the click
      // that ends the press lands on the page, not on the trigger.
      fireEvent.pointerDown(trigger(), { button: 0, pointerType: 'mouse' });
      expect(screen.getAllByRole('menu')).toHaveLength(1);
      await user.keyboard('{Escape}');
      await flushTimers();
      expect(screen.queryByRole('menu')).toBeNull();

      act(() => { trigger().click(); });

      expect(screen.getAllByRole('menu')).toHaveLength(1);
      expect(opened(onOpenChange)).toBe(3);
    });
  });

  it('leaves the click of a pointer to the pointer-down: a click that counts presses opens nothing by itself', () => {
    const onOpenChange = vi.fn();
    render(<ActionsMenu onOpenChange={onOpenChange}><Button>Actions</Button></ActionsMenu>, { wrapper: DesignSystemProvider });

    fireEvent.click(trigger(), { detail: 1 });

    expect(screen.queryByRole('menu')).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('opens nothing on a busy trigger', () => {
    const onOpenChange = vi.fn();
    render(<ActionsMenu onOpenChange={onOpenChange}><IconButton busy icon={AppIcons.more} label="Actions" /></ActionsMenu>, { wrapper: DesignSystemProvider });

    act(() => { trigger().click(); });

    expect(screen.queryByRole('menu')).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('opens nothing when the trigger\'s own handler refuses the click', () => {
    const onOpenChange = vi.fn();
    render(
      <ActionsMenu onOpenChange={onOpenChange}><Button onClick={(event) => event.preventDefault()}>Actions</Button></ActionsMenu>,
      { wrapper: DesignSystemProvider },
    );

    act(() => { trigger().click(); });

    expect(screen.queryByRole('menu')).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('asks the owner of a controlled menu once, and shows nothing the owner does not open', () => {
    const onOpenChange = vi.fn();
    render(
      <Menu open={false} onOpenChange={onOpenChange} trigger={<Button>Actions</Button>}><MenuItem>Rename</MenuItem></Menu>,
      { wrapper: DesignSystemProvider },
    );

    act(() => { trigger().click(); });

    expect(onOpenChange.mock.calls).toEqual([[true]]);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('chooses nothing: the menu opens and waits for a choice', async () => {
    const onPick = vi.fn();
    render(<ActionsMenu onOpenChange={() => undefined} onPick={onPick}><Button>Actions</Button></ActionsMenu>, { wrapper: DesignSystemProvider });

    act(() => { trigger().click(); });
    await screen.findByRole('menu');
    await flushTimers();

    expect(onPick).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('still keeps the trigger\'s click from a card it sits on when the trigger says so', async () => {
    const onCardClick = vi.fn();
    render(
      <div role="button" tabIndex={0} aria-label="Card" onClick={onCardClick}>
        <ActionsMenu onOpenChange={() => undefined}><IconButton icon={AppIcons.more} label="Actions" onClick={(event) => event.stopPropagation()} /></ActionsMenu>
      </div>,
      { wrapper: DesignSystemProvider },
    );

    act(() => { trigger().click(); });

    expect(await screen.findByRole('menu')).toBeInTheDocument();
    expect(onCardClick).not.toHaveBeenCalled();
  });
});

// The focus is handed to a menu button by code (after a row's action, when a window closes); a
// key that is still down then repeats on it.
describe('a held key arriving on a closed menu trigger', () => {
  const TRIGGERS: [string, () => ReactElement][] = [
    ['a Button', () => <Button>Actions</Button>],
    ['an IconButton', () => <IconButton icon={AppIcons.more} label="Actions" />],
    ['a Pressable', () => <Pressable>Actions</Pressable>],
    // No ds control of its own drops anything here: the menu does.
    ['a plain element', () => <span role="button" tabIndex={0}>Actions</span>],
  ];
  const KEYS = [['Enter', 'Enter'], [' ', 'Space'], ['ArrowDown', 'ArrowDown']] as const;

  describe.each(TRIGGERS)('%s', (_name, ui) => {
    it('opens nothing on the repeats of Enter, Space and ArrowDown, and lets no click follow them', () => {
      const onOpenChange = vi.fn();
      render(<Menu trigger={ui()} onOpenChange={onOpenChange}><MenuItem>Rename</MenuItem></Menu>, { wrapper: DesignSystemProvider });
      const trigger = screen.getByRole('button', { name: 'Actions' });
      trigger.focus();

      for (const [key, code] of KEYS) {
        // fireEvent returns false once the default was prevented.
        for (let i = 0; i < 3; i += 1) expect(fireEvent.keyDown(trigger, { key, code, repeat: true })).toBe(false);
      }

      expect(screen.queryByRole('menu')).toBeNull();
      expect(onOpenChange).not.toHaveBeenCalled();
    });

    it.each(KEYS)('opens on a new press of %j after the key was released', async (key, code) => {
      const onOpenChange = vi.fn();
      render(<Menu trigger={ui()} onOpenChange={onOpenChange}><MenuItem>Rename</MenuItem></Menu>, { wrapper: DesignSystemProvider });
      const trigger = screen.getByRole('button', { name: 'Actions' });
      trigger.focus();
      fireEvent.keyDown(trigger, { key, code, repeat: true });
      fireEvent.keyUp(trigger, { key, code });

      expect(fireEvent.keyDown(trigger, { key, code })).toBe(false);

      expect(await screen.findByRole('menu')).toBeInTheDocument();
      expect(onOpenChange.mock.calls).toEqual([[true]]);
    });

    it('lets Tab repeat past it', () => {
      render(<Menu trigger={ui()}><MenuItem>Rename</MenuItem></Menu>, { wrapper: DesignSystemProvider });
      expect(fireEvent.keyDown(screen.getByRole('button', { name: 'Actions' }), { key: 'Tab', code: 'Tab', repeat: true })).toBe(true);
    });
  });
});

describe('keys held when a popover opens', () => {
  it('drops the repeats of the key that opened it, before a control inside hears them', async () => {
    const heard: string[] = [];
    render(
      <Popover trigger={<Button>Details</Button>}>
        <input aria-label="Filter" onKeyDown={(event) => heard.push(event.key)} />
      </Popover>,
      { wrapper: DesignSystemProvider },
    );
    const trigger = screen.getByRole('button', { name: 'Details' });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Enter', code: 'Enter' });
    // The browser makes the click that opens a popover from that key-down.
    fireEvent.click(trigger, { detail: 0 });
    const field = await screen.findByRole('textbox', { name: 'Filter' });
    field.focus();
    expect(fireEvent.keyDown(field, { key: 'Enter', code: 'Enter', repeat: true })).toBe(false);
    expect(heard).toEqual([]);
    fireEvent.keyUp(field, { key: 'Enter', code: 'Enter' });
    expect(fireEvent.keyDown(field, { key: 'a', code: 'KeyA' })).toBe(true);
    expect(fireEvent.keyDown(field, { key: 'a', code: 'KeyA', repeat: true })).toBe(true);
    expect(heard).toEqual(['a', 'a']);
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
