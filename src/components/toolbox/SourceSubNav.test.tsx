// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Bot } from 'lucide-react';
import SourceSubNav from './SourceSubNav';
import TopTabNav from './TopTabNav';

/** The `bg-[var(--token)]` a button paints when it is NOT being hovered. */
function restingBackground(el: HTMLElement): string {
  const match = el.className.split(/\s+/).find((c) => c.startsWith('bg-[var('));
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

  it('paints the selected source with the same pill the tab row above it uses', () => {
    // Two stacked rows of the same nav must not disagree on what "selected"
    // looks like, so this pins the relationship rather than the literal token.
    render(<SourceSubNav value="market" onChange={vi.fn()} marketLabel="市场" mineLabel="我的" />);
    render(
      <TopTabNav
        items={[{ id: 'agents', label: '专家', icon: Bot }, { id: 'teams', label: '专家团', icon: Bot }]}
        activeId="agents"
        onSelect={vi.fn()}
      />,
    );
    const sub = restingBackground(screen.getByRole('tab', { name: '市场' }));
    const top = restingBackground(screen.getByRole('button', { name: '专家' }));
    expect(sub).not.toBe('');
    expect(sub).toBe(top);
  });

  it('does not paint the selected source with the hover background', () => {
    // It used to be `--abu-bg-hover`, byte-identical to the inactive tab's
    // hover state — an unselected tab under the pointer looked selected.
    render(<SourceSubNav value="market" onChange={vi.fn()} marketLabel="市场" mineLabel="我的" />);
    expect(restingBackground(screen.getByRole('tab', { name: '市场' }))).not.toBe('bg-[var(--abu-bg-hover)]');
  });
});
