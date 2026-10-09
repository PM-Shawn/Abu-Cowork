// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps, HTMLAttributes } from 'react';
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

// `more`: the row's button as a ds IconButton, as a plain element, or as one marked working.
// `press`: whether the rows hand their pointer presses to the list.
function List({ rows, more = 'ds', press = true }: { rows: string[]; more?: 'ds' | 'native' | 'working'; press?: boolean }) {
  return (
    <RowMenus
      className="space-y-1"
      moreLabel="More actions"
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
          onPointerDown={press ? (event) => menus.onRowPointerDown(event, rowId) : undefined}
        >
          {rowId}
          {more === 'native'
            // No ds control: nothing but the list's own handlers stands between a key and the menu.
            ? <span role="button" tabIndex={0} aria-label={`More for ${rowId}`} {...(menus.moreButtonProps(rowId) as HTMLAttributes<HTMLSpanElement>)} />
            : <IconButton icon={AppIcons.more} label={`More for ${rowId}`} size="sm" {...menus.moreButtonProps(rowId)} aria-disabled={more === 'working' || undefined} />}
        </div>
      ))}
    </RowMenus>
  );
}

function renderList(rows = ['a', 'b', 'c'], more: 'ds' | 'native' | 'working' = 'ds') {
  return render(<List rows={rows} more={more} />, { wrapper: DesignSystemProvider });
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

    it('names its menu for a screen reader', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderList();

      await user.click(moreButton('b'));

      expect(screen.getByRole('menu')).toHaveAccessibleName('More actions');
    });

    // An agent or the menu itself can remove the row while its menu is open.
    it('hands the focus to the first row left when its own row has gone by the time the menu closes', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const view = renderList();
      act(() => moreButton('b').focus());
      await user.keyboard('{Enter}');
      await act(() => vi.runOnlyPendingTimersAsync());
      view.rerender(<List rows={['a', 'c']} />);

      await user.keyboard('{Escape}');
      await act(() => vi.runOnlyPendingTimersAsync());

      expect(screen.queryByRole('menu')).toBeNull();
      expect(screen.getByTestId('a')).toHaveFocus();
    });

    it('does not leave the focus on a hidden element when no row is left', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const view = renderList(['a']);
      act(() => moreButton('a').focus());
      await user.keyboard('{Enter}');
      await act(() => vi.runOnlyPendingTimersAsync());
      view.rerender(<List rows={[]} />);

      await user.keyboard('{Escape}');
      await act(() => vi.runOnlyPendingTimersAsync());

      expect(screen.queryByRole('menu')).toBeNull();
      expect(document.activeElement?.closest('[aria-hidden="true"]') ?? null).toBeNull();
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

    // A screen reader activates the button with a click alone; `element.click()` makes the same
    // event (`detail` 0, no pointer down before it, no key).
    describe('under a click that no pointer and no key made', () => {
      it.each(['ds', 'native'] as const)('opens the items of its own row once, without acting as the row (%s button)', (more) => {
        renderList(['a', 'b', 'c'], more);

        act(() => moreButton('b').click());

        expect(menuItemNames()).toEqual(['Rename b', 'Delete b']);
        expect(moreButton('b')).toHaveAttribute('aria-expanded', 'true');
        expect(onRowClick).not.toHaveBeenCalled();
        expect(onOpenChange.mock.calls).toEqual([[true]]);

        act(() => moreButton('b').click());

        expect(screen.getAllByRole('menu')).toHaveLength(1);
        expect(onOpenChange.mock.calls).toEqual([[true]]);
        expect(onRowClick).not.toHaveBeenCalled();
      });

      it('opens once for a pointer press, whose own click opens nothing more', async () => {
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        renderList();

        await user.click(moreButton('b'));

        expect(screen.getAllByRole('menu')).toHaveLength(1);
        expect(onOpenChange.mock.calls).toEqual([[true]]);
      });

      it('leaves the click of a pointer to the pointer-down: a click that counts presses opens nothing by itself', () => {
        renderList();

        fireEvent.click(moreButton('b'), { detail: 1 });

        expect(screen.queryByRole('menu')).toBeNull();
        expect(onOpenChange).not.toHaveBeenCalled();
        expect(onRowClick).not.toHaveBeenCalled();
      });

      it('opens again after the menu was closed, also when the pointer press before it ended elsewhere', async () => {
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        renderList();
        // The pointer goes down on the button and the menu opens; the click that ends the press
        // lands on the page, because the open menu takes the pointer from everything else.
        fireEvent.pointerDown(moreButton('a'), { button: 0, pointerType: 'mouse' });
        expect(menuItemNames()).toEqual(['Rename a', 'Delete a']);
        await user.keyboard('{Escape}');
        await act(() => vi.runOnlyPendingTimersAsync());
        expect(screen.queryByRole('menu')).toBeNull();

        act(() => moreButton('c').click());

        expect(menuItemNames()).toEqual(['Rename c', 'Delete c']);
        expect(moreButton('c')).toHaveAttribute('aria-expanded', 'true');
        expect(moreButton('a')).toHaveAttribute('aria-expanded', 'false');
      });

      it('gives the focus back to the button when that menu is closed with Escape', async () => {
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        renderList();
        act(() => moreButton('b').focus());
        act(() => moreButton('b').click());
        await act(() => vi.runOnlyPendingTimersAsync());
        expect(menuItemNames()).toEqual(['Rename b', 'Delete b']);

        await user.keyboard('{Escape}');
        await act(() => vi.runOnlyPendingTimersAsync());

        expect(screen.queryByRole('menu')).toBeNull();
        expect(moreButton('b')).toHaveFocus();
      });

      // A list marks the button of a row whose own action is running (`aria-disabled`).
      it('opens nothing on a button that is marked as working: not on a click, a pointer press or an opening key', () => {
        renderList(['a', 'b', 'c'], 'working');

        act(() => moreButton('b').click());
        fireEvent.pointerDown(moreButton('b'), { button: 0, pointerType: 'mouse' });
        fireEvent.click(moreButton('b'), { detail: 1 });
        for (const [key, code] of [['Enter', 'Enter'], [' ', 'Space'], ['ArrowDown', 'ArrowDown']]) {
          // Prevented, so the browser makes no click from the key either.
          expect(fireEvent.keyDown(moreButton('b'), { key, code })).toBe(false);
        }

        expect(screen.queryByRole('menu')).toBeNull();
        expect(onOpenChange).not.toHaveBeenCalled();
        expect(onRowClick).not.toHaveBeenCalled();
      });
    });

    // The focus is handed to this button after a row's action; a key that is still down then
    // repeats on it.
    describe('a key that is held', () => {
      const KEYS = [['Enter', 'Enter'], [' ', 'Space'], ['ArrowDown', 'ArrowDown']] as const;

      it.each(['ds', 'native'] as const)('opens nothing on its repeats, and lets no click follow them (%s button)', (more) => {
        renderList(['a', 'b', 'c'], more);
        act(() => moreButton('b').focus());

        for (const [key, code] of KEYS) {
          // fireEvent returns false once the default was prevented: the browser then makes no click.
          expect(fireEvent.keyDown(moreButton('b'), { key, code, repeat: true })).toBe(false);
        }

        expect(screen.queryByRole('menu')).toBeNull();
        expect(onOpenChange).not.toHaveBeenCalled();
        expect(onRowClick).not.toHaveBeenCalled();
      });

      it.each(KEYS)('opens on the next press of %j once the key was released', async (key, code) => {
        renderList(['a', 'b', 'c'], 'native');
        act(() => moreButton('b').focus());
        fireEvent.keyDown(moreButton('b'), { key, code, repeat: true });
        fireEvent.keyUp(moreButton('b'), { key, code });

        expect(fireEvent.keyDown(moreButton('b'), { key, code })).toBe(false);
        await act(() => vi.runOnlyPendingTimersAsync());

        expect(menuItemNames()).toEqual(['Rename b', 'Delete b']);
        expect(onOpenChange.mock.calls).toEqual([[true]]);
      });

      it('leaves every other key alone', () => {
        renderList(['a', 'b', 'c'], 'native');
        expect(fireEvent.keyDown(moreButton('b'), { key: 'Tab', code: 'Tab', repeat: true })).toBe(true);
        expect(fireEvent.keyDown(moreButton('b'), { key: 'ArrowUp', code: 'ArrowUp', repeat: true })).toBe(true);
        expect(screen.queryByRole('menu')).toBeNull();
      });
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

  // A touch or a pen that stays down opens the right-click menu after LONG_PRESS_MS, with no
  // right-click event.
  describe('a long press', () => {
    const LONG_PRESS_MS = 700;

    async function rightClickThenClose(rowId: string) {
      fireEvent.contextMenu(screen.getByTestId(rowId));
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
      await act(() => vi.runOnlyPendingTimersAsync());
      expect(screen.queryByRole('menu')).toBeNull();
    }

    function hold(target: HTMLElement, pointerType: string) {
      fireEvent.pointerDown(target, { button: 0, pointerType });
      act(() => { vi.advanceTimersByTime(LONG_PRESS_MS); });
    }

    it.each(['touch', 'pen'])('opens the items of the pressed row after another row was right-clicked (%s)', async (pointerType) => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderList();
      await rightClickThenClose('a');

      hold(screen.getByTestId('b'), pointerType);

      expect(menuItemNames()).toEqual(['Rename b', 'Delete b']);
      expect(onOpenChange).toHaveBeenLastCalledWith(true);

      await user.click(screen.getByRole('menuitem', { name: 'Rename b' }));
      await act(() => vi.runOnlyPendingTimersAsync());

      expect(onRename.mock.calls).toEqual([['b']]);
    });

    it('opens the items of the pressed row when no row was right-clicked before', () => {
      renderList();

      hold(screen.getByTestId('c'), 'touch');

      expect(menuItemNames()).toEqual(['Rename c', 'Delete c']);
    });

    it('opens the items of the row whose "more actions" button is marked as working and was pressed', async () => {
      renderList(['a', 'b', 'c'], 'working');
      await rightClickThenClose('a');

      hold(moreButton('b'), 'touch');

      expect(menuItemNames()).toEqual(['Rename b', 'Delete b']);
    });

    it('opens nothing between the rows', async () => {
      renderList();
      const list = screen.getByTestId('a').parentElement as HTMLElement;
      await rightClickThenClose('a');
      onOpenChange.mockClear();

      hold(list, 'touch');

      expect(screen.queryByRole('menu')).toBeNull();
      expect(onOpenChange).not.toHaveBeenCalled();
    });

    it('opens nothing between the rows after a row was pressed and released', async () => {
      renderList();
      const list = screen.getByTestId('a').parentElement as HTMLElement;
      fireEvent.pointerDown(screen.getByTestId('a'), { button: 0, pointerType: 'touch' });
      fireEvent.pointerUp(screen.getByTestId('a'), { button: 0, pointerType: 'touch' });

      hold(list, 'touch');

      expect(screen.queryByRole('menu')).toBeNull();
      expect(onOpenChange).not.toHaveBeenCalled();
    });

    // A list whose rows report right-clicks only has no row for a press.
    it('opens nothing on a row that does not hand its presses to the list', async () => {
      render(<List rows={['a', 'b', 'c']} press={false} />, { wrapper: DesignSystemProvider });
      await rightClickThenClose('a');
      onOpenChange.mockClear();

      hold(screen.getByTestId('b'), 'touch');

      expect(screen.queryByRole('menu')).toBeNull();
      expect(onOpenChange).not.toHaveBeenCalled();

      fireEvent.contextMenu(screen.getByTestId('b'));

      expect(menuItemNames()).toEqual(['Rename b', 'Delete b']);
    });

    it('opens the right-clicked row after a refused long press', async () => {
      renderList();
      const list = screen.getByTestId('a').parentElement as HTMLElement;
      hold(list, 'touch');
      expect(screen.queryByRole('menu')).toBeNull();

      fireEvent.contextMenu(screen.getByTestId('c'));

      expect(menuItemNames()).toEqual(['Rename c', 'Delete c']);
      expect(onOpenChange.mock.calls).toEqual([[true]]);
    });

    it('opens nothing when the press ends before the time is up', () => {
      renderList();
      fireEvent.pointerDown(screen.getByTestId('b'), { button: 0, pointerType: 'touch' });
      act(() => { vi.advanceTimersByTime(LONG_PRESS_MS - 1); });
      fireEvent.pointerUp(screen.getByTestId('b'), { button: 0, pointerType: 'touch' });

      act(() => { vi.advanceTimersByTime(LONG_PRESS_MS); });

      expect(screen.queryByRole('menu')).toBeNull();
      expect(onOpenChange).not.toHaveBeenCalled();
    });

    it('opens nothing for a mouse button that stays down', () => {
      renderList();

      hold(screen.getByTestId('b'), 'mouse');

      expect(screen.queryByRole('menu')).toBeNull();
    });

    it('keeps the items of the open menu while another row is pressed', () => {
      renderList();
      fireEvent.contextMenu(screen.getByTestId('a'));

      fireEvent.pointerDown(screen.getByTestId('b'), { button: 0, pointerType: 'touch' });

      expect(menuItemNames()).toEqual(['Rename a', 'Delete a']);
    });

    it('opens the row of the mouse right-click made while a touch is held on another row', () => {
      renderList();
      fireEvent.pointerDown(screen.getByTestId('b'), { button: 0, pointerType: 'touch' });

      fireEvent.pointerDown(screen.getByTestId('c'), { button: 2, pointerType: 'mouse' });
      fireEvent.contextMenu(screen.getByTestId('c'));
      act(() => { vi.advanceTimersByTime(LONG_PRESS_MS); });

      expect(screen.getAllByRole('menu')).toHaveLength(1);
      expect(menuItemNames()).toEqual(['Rename c', 'Delete c']);
    });
  });
});
