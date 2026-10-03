// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import InstalledItemMenu from './InstalledItemMenu';

// The latest props of the menu and its items, to drive the menu the way Radix does when it
// is reopened during its exit animation (happy-dom has no animations).
const menuProps = vi.hoisted(() => ({
  onOpenChange: undefined as ((open: boolean) => void) | undefined,
  onSelect: {} as Record<string, ((event: Event) => void) | undefined>,
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
      if (props.testId) menuProps.onSelect[props.testId] = props.onSelect;
      return actual.MenuItem(props);
    },
  };
});

const renderMenu = (ui: ReactNode) => render(<DesignSystemProvider>{ui}</DesignSystemProvider>);

describe('InstalledItemMenu', () => {
  beforeEach(() => {
    menuProps.onOpenChange = undefined;
    menuProps.onSelect = {};
  });

  it('opens on the trigger, lists actions in order, runs the chosen one', async () => {
    const user = userEvent.setup();
    const trial = vi.fn(); const uninstall = vi.fn();
    renderMenu(<InstalledItemMenu ariaLabel="canva 的操作" testId="plugin-item-menu" actions={[
      { id: 'trial', label: '立即试用', onSelect: trial },
      { id: 'uninstall', label: '卸载', onSelect: uninstall, destructive: true },
    ]} />);
    const trigger = screen.getByRole('button', { name: 'canva 的操作' });
    expect(trigger).toHaveAttribute('data-testid', 'plugin-item-menu');
    await user.click(trigger);
    const items = screen.getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual(['立即试用', '卸载']);
    expect(items.map((i) => i.getAttribute('data-testid'))).toEqual(['plugin-item-menu-trial', 'plugin-item-menu-uninstall']);
    expect(screen.getAllByRole('separator')).toHaveLength(1);
    await user.click(items[0]);
    await waitFor(() => expect(trial).toHaveBeenCalledTimes(1));
    expect(uninstall).not.toHaveBeenCalled();
  });

  it('renders a disabled action with its reason and never fires it', async () => {
    const user = userEvent.setup();
    const uninstall = vi.fn();
    renderMenu(<InstalledItemMenu ariaLabel="x" testId="m" actions={[
      { id: 'uninstall', label: '卸载', onSelect: uninstall, disabledReason: '由组织管理，不能在这里卸载' },
    ]} />);
    await user.click(screen.getByRole('button', { name: 'x' }));
    const item = screen.getByRole('menuitem', { name: /卸载/ });
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).toHaveAttribute('title', '由组织管理，不能在这里卸载');
    await user.click(item);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.getByRole('button', { name: 'x' })).toHaveFocus());
    expect(uninstall).not.toHaveBeenCalled();
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    renderMenu(<InstalledItemMenu ariaLabel="x" testId="m" actions={[
      { id: 'trial', label: '立即试用', onSelect: vi.fn() },
    ]} />);
    const trigger = screen.getByRole('button', { name: 'x' });
    await user.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('opened from the keyboard, focuses the first item and moves with ArrowDown/ArrowUp without running anything', async () => {
    const user = userEvent.setup();
    const trial = vi.fn(); const manage = vi.fn();
    renderMenu(<InstalledItemMenu ariaLabel="x" testId="m" actions={[
      { id: 'trial', label: '立即试用', onSelect: trial },
      { id: 'manage', label: '管理', onSelect: manage },
    ]} />);
    screen.getByRole('button', { name: 'x' }).focus();
    await user.keyboard('{Enter}');
    const items = screen.getAllByRole('menuitem');
    await waitFor(() => expect(items[0]).toHaveFocus());
    await user.keyboard('{ArrowDown}');
    expect(items[1]).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(items[0]).toHaveFocus();
    expect(trial).not.toHaveBeenCalled();
    expect(manage).not.toHaveBeenCalled();
  });

  it('keeps the menu open and the focus inside it on Tab', async () => {
    const user = userEvent.setup();
    renderMenu(<InstalledItemMenu ariaLabel="x" testId="m" actions={[
      { id: 'trial', label: '立即试用', onSelect: vi.fn() },
    ]} />);
    screen.getByRole('button', { name: 'x' }).focus();
    await user.keyboard('{Enter}');
    const item = screen.getByRole('menuitem', { name: '立即试用' });
    await waitFor(() => expect(item).toHaveFocus());
    await user.keyboard('{Tab}');
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(item).toHaveFocus();
  });

  it('runs the chosen action only after the menu has gone', async () => {
    const user = userEvent.setup();
    let menuOpenWhenRun: boolean | null = null;
    const trial = vi.fn(() => { menuOpenWhenRun = document.querySelector('[role="menu"]') !== null; });
    renderMenu(<InstalledItemMenu ariaLabel="x" testId="m" actions={[
      { id: 'trial', label: '立即试用', onSelect: trial },
    ]} />);
    await user.click(screen.getByRole('button', { name: 'x' }));
    await user.click(screen.getByRole('menuitem', { name: '立即试用' }));
    await waitFor(() => expect(trial).toHaveBeenCalledTimes(1));
    expect(menuOpenWhenRun).toBe(false);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('has the focus on the trigger when the chosen action runs, and leaves it there', async () => {
    const user = userEvent.setup();
    let focusedWhenRun: Element | null = null;
    const trial = vi.fn(() => { focusedWhenRun = document.activeElement; });
    renderMenu(<InstalledItemMenu ariaLabel="x" testId="m" actions={[
      { id: 'trial', label: '立即试用', onSelect: trial },
    ]} />);
    const trigger = screen.getByRole('button', { name: 'x' });
    await user.click(trigger);
    await user.click(screen.getByRole('menuitem', { name: '立即试用' }));
    await waitFor(() => expect(trial).toHaveBeenCalledTimes(1));
    expect(focusedWhenRun).toBe(trigger);
    expect(trigger).toHaveFocus();
  });

  // A menu reopened during its exit animation stays mounted: the close hook never ran
  // for the choice made before, and opening again must forget it.
  it('forgets a choice whose close hook never ran when the menu opens again', async () => {
    const user = userEvent.setup();
    const trial = vi.fn();
    renderMenu(<InstalledItemMenu ariaLabel="x" testId="m" actions={[
      { id: 'trial', label: '立即试用', onSelect: trial },
    ]} />);
    const trigger = screen.getByRole('button', { name: 'x' });
    await user.click(trigger);
    act(() => menuProps.onSelect['m-trial']?.(new Event('select')));
    act(() => menuProps.onOpenChange?.(true));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(trial).not.toHaveBeenCalled();
  });

  it('renders the menu outside the row and does not leak an item click to a clickable ancestor row', async () => {
    const user = userEvent.setup();
    const rowSpy = vi.fn();
    const trial = vi.fn();
    renderMenu(
      // A stand-in for a clickable card: a click handler on a plain element.
      <div data-testid="row" onClick={rowSpy}>
        <InstalledItemMenu ariaLabel="x" testId="m" actions={[
          { id: 'trial', label: '立即试用', onSelect: trial },
        ]} />
      </div>,
    );
    await user.click(screen.getByRole('button', { name: 'x' }));
    expect(rowSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId('row')).not.toContainElement(screen.getByRole('menu'));
    await user.click(screen.getByRole('menuitem', { name: '立即试用' }));
    await waitFor(() => expect(trial).toHaveBeenCalledTimes(1));
    expect(rowSpy).not.toHaveBeenCalled();
  });

  it('does not leak a disabled item click to a clickable ancestor row', async () => {
    const user = userEvent.setup();
    const rowSpy = vi.fn();
    const uninstall = vi.fn();
    renderMenu(
      <div onClick={rowSpy}>
        <InstalledItemMenu ariaLabel="x" testId="m" actions={[
          { id: 'uninstall', label: '卸载', onSelect: uninstall, disabledReason: '由组织管理，不能在这里卸载' },
        ]} />
      </div>,
    );
    await user.click(screen.getByRole('button', { name: 'x' }));
    await user.click(screen.getByRole('menuitem', { name: /卸载/ }));
    expect(uninstall).not.toHaveBeenCalled();
    expect(rowSpy).not.toHaveBeenCalled();
  });
});
