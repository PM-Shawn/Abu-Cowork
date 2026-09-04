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
});
