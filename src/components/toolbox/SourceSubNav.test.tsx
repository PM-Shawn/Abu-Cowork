// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppIcons } from '@/components/ds/icons';
import SourceSubNav from './SourceSubNav';
import TopTabNav from './TopTabNav';

/** The fill a button paints when it is NOT under the pointer: its one `bg-` class without a variant. */
function restingBackground(el: HTMLElement): string {
  const match = el.className.split(/\s+/).find((c) => c.startsWith('bg-'));
  return match ?? '';
}

describe('SourceSubNav', () => {
  it('renders two tabs, marks the active one, and reports a switch', () => {
    const onChange = vi.fn();
    render(<SourceSubNav value="market" onChange={onChange} marketLabel="市场" mineLabel="我的" />);
    const market = screen.getByRole('tab', { name: '市场' });
    const mine = screen.getByRole('tab', { name: '我的' });
    expect(market).toHaveAttribute('aria-selected', 'true');
    expect(mine).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByTestId('extensions-source-mine')).toBe(mine);
    fireEvent.click(mine);
    expect(onChange).toHaveBeenCalledWith('mine');
  });

  it('keeps the tablist name, each tab id and the panel both tabs control', () => {
    render(<SourceSubNav value="mine" onChange={vi.fn()} marketLabel="市场" mineLabel="我的" testIdPrefix="team-source" panelId="team-panel" />);
    expect(screen.getByRole('tablist', { name: '市场 / 我的' })).toBeInTheDocument();
    const market = screen.getByTestId('team-source-market');
    const mine = screen.getByTestId('team-source-mine');
    expect(market.id).toBe('team-source-market');
    expect(mine.id).toBe('team-source-mine');
    expect(market).toHaveAttribute('aria-controls', 'team-panel');
    expect(mine).toHaveAttribute('aria-controls', 'team-panel');
    expect(mine).toHaveAttribute('aria-selected', 'true');
    expect(market.tagName).toBe('BUTTON');
    expect(market).toHaveAttribute('type', 'button');
  });

  it('paints the selected source with the same pill the tab row above it uses', () => {
    // Two stacked rows of the same nav must not disagree on what "selected"
    // looks like, so this pins the relationship as well as the token.
    render(<SourceSubNav value="market" onChange={vi.fn()} marketLabel="市场" mineLabel="我的" />);
    render(
      <TopTabNav
        items={[{ id: 'agents', label: '专家', icon: AppIcons.agent }, { id: 'teams', label: '专家团', icon: AppIcons.agent }]}
        activeId="agents"
        onSelect={vi.fn()}
      />,
    );
    const sub = restingBackground(screen.getByRole('tab', { name: '市场' }));
    const top = restingBackground(screen.getByRole('button', { name: '专家' }));
    expect(sub).toBe('bg-fill-selected');
    expect(sub).toBe(top);
    expect(screen.getByRole('tab', { name: '市场' }).className).not.toContain('clay');
  });

  it('does not paint the selected source with the hover background', () => {
    // An unselected tab under the pointer must not look selected.
    render(<SourceSubNav value="market" onChange={vi.fn()} marketLabel="市场" mineLabel="我的" />);
    expect(restingBackground(screen.getByRole('tab', { name: '市场' }))).not.toBe('bg-fill-hover');
    expect(restingBackground(screen.getByRole('tab', { name: '我的' }))).toBe('');
    expect(screen.getByRole('tab', { name: '我的' }).className.split(/\s+/)).toContain('hover:bg-fill-hover');
  });
});
