// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppIcons } from '@/components/ds/icons';
import TopTabNav from './TopTabNav';

const items = [
  { id: 'members', label: '专家', icon: AppIcons.agent },
  { id: 'teams', label: '专家团', icon: AppIcons.team },
];

describe('TopTabNav', () => {
  it('fills only the tab in view, with the selected fill and not the hover fill', () => {
    // A selected tab that borrowed the hover fill could not be told from a tab under the pointer.
    render(<TopTabNav items={items} activeId="members" onSelect={vi.fn()} />);
    const active = screen.getByRole('button', { name: '专家' });
    const inactive = screen.getByRole('button', { name: '专家团' });
    expect(active.className.split(/\s+/)).toContain('bg-fill-selected');
    expect(active.className).not.toContain('clay');
    expect(inactive.className.split(/\s+/)).not.toContain('bg-fill-selected');
    expect(inactive.className).not.toContain('clay');
    expect(inactive.className.split(/\s+/)).toContain('hover:bg-fill-hover');
  });

  it('keeps the buttons, their order, the row test id and reports a press', () => {
    const onSelect = vi.fn();
    render(<TopTabNav items={items} activeId="members" onSelect={onSelect} right={<span>Right side</span>} />);
    const row = screen.getByTestId('top-tab-nav');
    expect(row.tagName).toBe('NAV');
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['专家', '专家团']);
    expect(row).toHaveTextContent('Right side');
    fireEvent.click(screen.getByRole('button', { name: '专家团' }));
    expect(onSelect).toHaveBeenCalledWith('teams');
  });

  it('draws each icon through the design-system icon and keeps a badge inside its tab', () => {
    render(
      <TopTabNav
        items={[{ ...items[0], badge: <span data-testid="badge">3</span> }, items[1]]}
        activeId="teams"
        onSelect={vi.fn()}
      />,
    );
    const first = screen.getByTestId('badge').closest('button')!;
    expect(first).toHaveTextContent('专家');
    const glyph = first.querySelector('svg')!;
    expect(glyph.getAttribute('width')).toBe('16');
    expect(glyph.getAttribute('stroke-width')).toBe('1.5');
  });

  it('clears the floating window controls below the title band or beside them', () => {
    const { rerender } = render(<TopTabNav items={items} activeId="members" onSelect={vi.fn()} belowChrome />);
    expect(screen.getByTestId('top-tab-nav').className.split(/\s+/)).toContain('pt-12');
    rerender(<TopTabNav items={items} activeId="members" onSelect={vi.fn()} sidebarCollapsed />);
    expect(screen.getByTestId('top-tab-nav').className.split(/\s+/)).toContain('pl-[184px]');
    rerender(<TopTabNav items={items} activeId="members" onSelect={vi.fn()} />);
    expect(screen.getByTestId('top-tab-nav').className.split(/\s+/)).toContain('pl-4');
  });
});
