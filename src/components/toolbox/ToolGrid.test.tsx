// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ToolGrid from './ToolGrid';

describe('ToolGrid', () => {
  it('renders its children as given, in order, inside one grid', () => {
    const { container } = render(
      <ToolGrid>
        <div data-testid="first">First card</div>
        <div data-testid="second">Second card</div>
      </ToolGrid>,
    );
    const grid = container.firstElementChild!;
    expect(grid.className).toContain('grid');
    // The column floor the cards are designed for; the private repo renders this grid too.
    expect(grid.className).toContain('minmax(240px,1fr)');
    expect([...grid.children]).toEqual([screen.getByTestId('first'), screen.getByTestId('second')]);
    expect(screen.getByTestId('first')).toHaveTextContent('First card');
  });
});
