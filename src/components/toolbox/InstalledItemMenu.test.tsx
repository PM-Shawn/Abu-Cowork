// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import InstalledItemMenu from './InstalledItemMenu';

describe('InstalledItemMenu', () => {
  it('opens on the trigger, lists actions in order, runs the chosen one', () => {
    const trial = vi.fn(); const uninstall = vi.fn();
    render(<InstalledItemMenu ariaLabel="canva 的操作" testId="plugin-item-menu" actions={[
      { id: 'trial', label: '立即试用', onSelect: trial },
      { id: 'uninstall', label: '卸载', onSelect: uninstall, destructive: true },
    ]} />);
    fireEvent.click(screen.getByRole('button', { name: 'canva 的操作' }));
    const items = screen.getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual(['立即试用', '卸载']);
    fireEvent.click(items[0]);
    expect(trial).toHaveBeenCalledTimes(1);
    expect(uninstall).not.toHaveBeenCalled();
  });

  it('renders a disabled action with its reason and never fires it', () => {
    const uninstall = vi.fn();
    render(<InstalledItemMenu ariaLabel="x" testId="m" actions={[
      { id: 'uninstall', label: '卸载', onSelect: uninstall, disabledReason: '由组织管理，不能在这里卸载' },
    ]} />);
    fireEvent.click(screen.getByRole('button', { name: 'x' }));
    const item = screen.getByRole('menuitem', { name: /卸载/ });
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).toHaveAttribute('title', '由组织管理，不能在这里卸载');
    fireEvent.click(item);
    expect(uninstall).not.toHaveBeenCalled();
  });

  it('closes on Escape and returns focus to the trigger', () => {
    render(<InstalledItemMenu ariaLabel="x" testId="m" actions={[
      { id: 'trial', label: '立即试用', onSelect: vi.fn() },
    ]} />);
    const trigger = screen.getByRole('button', { name: 'x' });
    fireEvent.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('focuses the first enabled item on open and moves with ArrowDown/ArrowUp', () => {
    render(<InstalledItemMenu ariaLabel="x" testId="m" actions={[
      { id: 'trial', label: '立即试用', onSelect: vi.fn() },
      { id: 'manage', label: '管理', onSelect: vi.fn() },
    ]} />);
    fireEvent.click(screen.getByRole('button', { name: 'x' }));
    const items = screen.getAllByRole('menuitem');
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(items[1]).toHaveFocus();
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(document, { key: 'ArrowUp' });
    expect(items[1]).toHaveFocus();
  });

  it('closes on Tab and returns focus to the trigger', () => {
    render(<InstalledItemMenu ariaLabel="x" testId="m" actions={[
      { id: 'trial', label: '立即试用', onSelect: vi.fn() },
    ]} />);
    const trigger = screen.getByRole('button', { name: 'x' });
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('closes the menu after a successful select', () => {
    const trial = vi.fn();
    render(<InstalledItemMenu ariaLabel="x" testId="m" actions={[
      { id: 'trial', label: '立即试用', onSelect: trial },
    ]} />);
    fireEvent.click(screen.getByRole('button', { name: 'x' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '立即试用' }));
    expect(trial).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('does not leak an enabled item click to a clickable ancestor row', () => {
    const rowSpy = vi.fn();
    const trial = vi.fn();
    render(
      <div onClick={rowSpy}>
        <InstalledItemMenu ariaLabel="x" testId="m" actions={[
          { id: 'trial', label: '立即试用', onSelect: trial },
        ]} />
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'x' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '立即试用' }));
    expect(trial).toHaveBeenCalledTimes(1);
    expect(rowSpy).not.toHaveBeenCalled();
  });

  it('does not leak a disabled item click to a clickable ancestor row', () => {
    const rowSpy = vi.fn();
    const uninstall = vi.fn();
    render(
      <div onClick={rowSpy}>
        <InstalledItemMenu ariaLabel="x" testId="m" actions={[
          { id: 'uninstall', label: '卸载', onSelect: uninstall, disabledReason: '由组织管理，不能在这里卸载' },
        ]} />
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'x' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /卸载/ }));
    expect(uninstall).not.toHaveBeenCalled();
    expect(rowSpy).not.toHaveBeenCalled();
  });
});
