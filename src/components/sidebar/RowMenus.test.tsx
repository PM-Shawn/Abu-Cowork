// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IconButton } from '@/components/ds/button';
import { AppIcons } from '@/components/ds/icons';
import { MenuItem } from '@/components/ds/menu';
import { DesignSystemProvider } from '@/components/ds/provider';
import { RowMenus } from './RowMenus';

// Counts the menus that are mounted, whatever the number of rows.
const mounted = vi.hoisted(() => ({ contextMenus: new Set<string>(), menus: new Set<string>() }));

vi.mock('@/components/ds/context-menu', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ds/context-menu')>();
  const { useId } = await import('react');
  return {
    ...actual,
    ContextMenu: (props: ComponentProps<typeof actual.ContextMenu>) => {
      mounted.contextMenus.add(useId());
      return actual.ContextMenu(props);
    },
  };
});

vi.mock('@/components/ds/menu', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ds/menu')>();
  const { useId } = await import('react');
  return {
    ...actual,
    Menu: (props: ComponentProps<typeof actual.Menu>) => {
      mounted.menus.add(useId());
      return actual.Menu(props);
    },
  };
});

const onRowClick = vi.fn();
const onRename = vi.fn();
const onOpenChange = vi.fn();
const onCloseAutoFocus = vi.fn();

function List({ rows }: { rows: string[] }) {
  return (
    <RowMenus
      className="space-y-1"
      onOpenChange={onOpenChange}
      onCloseAutoFocus={onCloseAutoFocus}
      items={(rowId) => (
        <>
          <MenuItem onSelect={() => onRename(rowId)}>{`Rename ${rowId}`}</MenuItem>
          <MenuItem>{`Delete ${rowId}`}</MenuItem>
        </>
      )}
    >
      {(menus) => rows.map((rowId) => (
        <div
          key={rowId}
          role="button"
          tabIndex={0}
          data-testid={rowId}
          onClick={() => onRowClick(rowId)}
          onContextMenu={(event) => menus.onRowContextMenu(event, rowId)}
        >
          {rowId}
          <IconButton icon={AppIcons.more} label={`More for ${rowId}`} size="sm" {...menus.moreButtonProps(rowId)} />
        </div>
      ))}
    </RowMenus>
  );
}

function renderList(rows = ['a', 'b', 'c']) {
  return render(<List rows={rows} />, { wrapper: DesignSystemProvider });
}

function menuItemNames() {
  return within(screen.getByRole('menu')).getAllByRole('menuitem').map((item) => item.textContent);
}

// An open menu hides the rest of the page from assistive technology.
function moreButton(rowId: string) {
  return screen.getByRole('button', { name: `More for ${rowId}`, hidden: true });
}

beforeAll(() => {
  // happy-dom lacks the pointer-capture and scroll APIs Radix menus call.
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

beforeEach(() => {
  mounted.contextMenus.clear();
  mounted.menus.clear();
  onRowClick.mockClear();
  onRename.mockClear();
  onOpenChange.mockClear();
  onCloseAutoFocus.mockReset();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('RowMenus', () => {
  it('mounts one right-click menu and one "more actions" menu for any number of rows', () => {
    renderList(Array.from({ length: 50 }, (_, i) => `row-${i}`));

    expect(screen.getAllByRole('button', { name: /^More for/ })).toHaveLength(50);
    expect(mounted.contextMenus.size).toBe(1);
    expect(mounted.menus.size).toBe(1);
  });

  it('keeps the list free of the menu state attribute', () => {
    renderList();
    const list = screen.getByTestId('a').parentElement as HTMLElement;
    expect(list).toHaveClass('space-y-1');
    expect(list).not.toHaveAttribute('data-state');

    fireEvent.contextMenu(screen.getByTestId('a'));

    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(list).not.toHaveAttribute('data-state');
  });

  describe('the "more actions" button', () => {
    it('is a menu button that opens the items of its own row without acting as the row', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderList();
      expect(moreButton('b')).toHaveAttribute('aria-haspopup', 'menu');
      expect(moreButton('b')).toHaveAttribute('aria-expanded', 'false');

      await user.click(moreButton('b'));

      expect(menuItemNames()).toEqual(['Rename b', 'Delete b']);
      expect(moreButton('b')).toHaveAttribute('aria-expanded', 'true');
      expect(moreButton('a')).toHaveAttribute('aria-expanded', 'false');
      expect(onRowClick).not.toHaveBeenCalled();
      expect(onOpenChange).toHaveBeenLastCalledWith(true);

      await user.click(screen.getByRole('menuitem', { name: 'Rename b' }));
      await act(() => vi.runOnlyPendingTimersAsync());

      expect(onRename).toHaveBeenCalledWith('b');
      expect(screen.queryByRole('menu')).toBeNull();
      expect(moreButton('b')).toHaveAttribute('aria-expanded', 'false');
      expect(onOpenChange).toHaveBeenLastCalledWith(false);
      expect(onCloseAutoFocus).toHaveBeenCalledOnce();
    });

    it('moves to another row when that row\'s button is used next', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderList();
      await user.click(moreButton('a'));
      await user.keyboard('{Escape}');
      await act(() => vi.runOnlyPendingTimersAsync());

      await user.click(moreButton('c'));

      expect(menuItemNames()).toEqual(['Rename c', 'Delete c']);
      expect(moreButton('c')).toHaveAttribute('aria-expanded', 'true');
      expect(mounted.menus.size).toBe(1);
    });

    it.each(['{Enter}', ' ', '{ArrowDown}'])('opens from the keyboard with %s, on the first item', async (key) => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderList();
      act(() => moreButton('a').focus());

      await user.keyboard(key);
      await act(() => vi.runOnlyPendingTimersAsync());

      expect(screen.getByRole('menuitem', { name: 'Rename a' })).toHaveFocus();
      expect(onRowClick).not.toHaveBeenCalled();
    });

    it('gets the focus back when the menu is closed with Escape', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderList();
      act(() => moreButton('b').focus());
      await user.keyboard('{Enter}');
      await act(() => vi.runOnlyPendingTimersAsync());

      await user.keyboard('{Escape}');
      await act(() => vi.runOnlyPendingTimersAsync());

      expect(screen.queryByRole('menu')).toBeNull();
      expect(moreButton('b')).toHaveFocus();
    });

    it('leaves the focus to a caller that takes it in the close hook', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      onCloseAutoFocus.mockImplementation((event: Event) => {
        event.preventDefault();
        screen.getByTestId('c').focus();
      });
      renderList();
      await user.click(moreButton('b'));

      await user.click(screen.getByRole('menuitem', { name: 'Rename b' }));
      await act(() => vi.runOnlyPendingTimersAsync());

      expect(screen.getByTestId('c')).toHaveFocus();
    });
  });

  describe('the right-click menu', () => {
    it('shows the items of the row that was right-clicked', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderList();

      fireEvent.contextMenu(screen.getByTestId('c'));

      expect(menuItemNames()).toEqual(['Rename c', 'Delete c']);
      expect(onOpenChange).toHaveBeenLastCalledWith(true);

      await user.click(screen.getByRole('menuitem', { name: 'Rename c' }));
      await act(() => vi.runOnlyPendingTimersAsync());

      expect(onRename).toHaveBeenCalledWith('c');
      expect(onCloseAutoFocus).toHaveBeenCalled();
      expect(onRowClick).not.toHaveBeenCalled();
    });

    it('follows a second right-click on another row while it is open', () => {
      renderList();

      fireEvent.contextMenu(screen.getByTestId('a'));
      fireEvent.contextMenu(screen.getByTestId('b'));

      expect(screen.getAllByRole('menu')).toHaveLength(1);
      expect(menuItemNames()).toEqual(['Rename b', 'Delete b']);
    });

    it('does not open for a right-click between the rows', () => {
      renderList();
      const list = screen.getByTestId('a').parentElement as HTMLElement;
      // A row was right-clicked before, so the menu has a row to show if it opened.
      fireEvent.contextMenu(screen.getByTestId('a'));
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });

      const notCancelled = fireEvent.contextMenu(list);

      expect(screen.queryByRole('menu')).toBeNull();
      expect(notCancelled).toBe(false);
    });

    it('returns the focus to the focused row when it is closed with Escape', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderList();
      act(() => screen.getByTestId('b').focus());
      fireEvent.contextMenu(screen.getByTestId('b'));

      await user.keyboard('{Escape}');
      await act(() => vi.runOnlyPendingTimersAsync());

      expect(screen.getByTestId('b')).toHaveFocus();
    });
  });
});
