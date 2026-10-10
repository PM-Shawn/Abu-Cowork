// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import ToolboxCreateMenu from './ToolboxCreateMenu';

// The latest props of the menu and its items, to drive the menu the way Radix does when it
// is reopened during its exit animation (happy-dom has no animations).
const menuProps = vi.hoisted(() => ({
  onOpenChange: undefined as ((open: boolean) => void) | undefined,
  onSelect: [] as Array<((event: Event) => void) | undefined>,
}));

vi.mock('@/components/ds/menu', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ds/menu')>();
  return {
    ...actual,
    Menu: (props: ComponentProps<typeof actual.Menu>) => {
      menuProps.onOpenChange = props.onOpenChange;
      return actual.Menu(props);
    },
    MenuItem: (props: ComponentProps<typeof actual.MenuItem>) => {
      menuProps.onSelect.push(props.onSelect);
      return actual.MenuItem(props);
    },
  };
});

function renderMenu(props: ComponentProps<typeof ToolboxCreateMenu>) {
  return render(<DesignSystemProvider><ToolboxCreateMenu {...props} /></DesignSystemProvider>);
}

describe('ToolboxCreateMenu', () => {
  beforeEach(() => {
    menuProps.onOpenChange = undefined;
    menuProps.onSelect = [];
  });

  it('direct mode: the button runs onClick and opens no menu', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    renderMenu({ onClick, triggerTestId: 'create-trigger', menuTestId: 'create-menu' });
    const button = screen.getByRole('button', { name: 'Add' });
    expect(button).toHaveAttribute('data-testid', 'create-trigger');
    expect(button).not.toHaveAttribute('aria-haspopup');
    await user.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('menu mode: lists create with Abu, create manually and the upload label, in that order', async () => {
    const user = userEvent.setup();
    renderMenu({
      onAICreate: vi.fn(), onManualCreate: vi.fn(), onUploadFile: vi.fn(), uploadLabel: 'Import skill',
      triggerTestId: 'create-trigger', menuTestId: 'create-menu',
    });
    await user.click(screen.getByTestId('create-trigger'));
    const menu = screen.getByTestId('create-menu');
    expect(menu).toHaveAttribute('role', 'menu');
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['Create with Abu', 'Create Manually', 'Import skill']);
  });

  it('items mode: renders each item and keeps a disabled one from running', async () => {
    const user = userEvent.setup();
    const add = vi.fn();
    const create = vi.fn();
    renderMenu({
      items: [
        { label: 'Add marketplace', onSelect: add },
        { label: 'Create plugin', disabled: true, onSelect: create },
      ],
      triggerTestId: 'create-trigger', menuTestId: 'create-menu',
    });
    await user.click(screen.getByTestId('create-trigger'));
    const items = within(screen.getByTestId('create-menu')).getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['Add marketplace', 'Create plugin']);
    expect(items[0]).not.toHaveAttribute('aria-disabled');
    expect(items[1]).toHaveAttribute('aria-disabled', 'true');
    await user.click(items[1]);
    await user.click(items[0]);
    await waitFor(() => expect(add).toHaveBeenCalledTimes(1));
    expect(create).not.toHaveBeenCalled();
  });

  it('menu mode: create manually runs after the menu has gone, with the focus on the button', async () => {
    const user = userEvent.setup();
    let menuOpenWhenRun: boolean | null = null;
    let focusedWhenRun: Element | null = null;
    const onManualCreate = vi.fn(() => {
      menuOpenWhenRun = document.querySelector('[role="menu"]') !== null;
      focusedWhenRun = document.activeElement;
    });
    const onAICreate = vi.fn();
    renderMenu({ onAICreate, onManualCreate, triggerTestId: 'create-trigger', menuTestId: 'create-menu' });
    const trigger = screen.getByTestId('create-trigger');
    await user.click(trigger);
    await user.click(screen.getByRole('menuitem', { name: 'Create Manually' }));
    await waitFor(() => expect(onManualCreate).toHaveBeenCalledTimes(1));
    expect(menuOpenWhenRun).toBe(false);
    expect(focusedWhenRun).toBe(trigger);
    expect(onAICreate).not.toHaveBeenCalled();
  });

  it('moves the highlight with the arrow keys without running anything', async () => {
    const user = userEvent.setup();
    const onAICreate = vi.fn();
    const onManualCreate = vi.fn();
    renderMenu({ onAICreate, onManualCreate, triggerTestId: 'create-trigger' });
    screen.getByTestId('create-trigger').focus();
    await user.keyboard('{Enter}');
    const items = screen.getAllByRole('menuitem');
    await waitFor(() => expect(items[0]).toHaveFocus());
    await user.keyboard('{ArrowDown}');
    expect(items[1]).toHaveFocus();
    expect(onAICreate).not.toHaveBeenCalled();
    expect(onManualCreate).not.toHaveBeenCalled();
  });

  // A menu reopened during its exit animation stays mounted: the close hook never ran
  // for the choice made before, and opening again must forget it.
  it('forgets a choice whose close hook never ran when the menu opens again', async () => {
    const user = userEvent.setup();
    const onManualCreate = vi.fn();
    renderMenu({ onManualCreate, triggerTestId: 'create-trigger' });
    const trigger = screen.getByTestId('create-trigger');
    await user.click(trigger);
    act(() => menuProps.onSelect[menuProps.onSelect.length - 1]?.(new Event('select')));
    act(() => menuProps.onOpenChange?.(true));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(onManualCreate).not.toHaveBeenCalled();
  });
});
