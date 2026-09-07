// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import SourceSubNav from './SourceSubNav';

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
});
