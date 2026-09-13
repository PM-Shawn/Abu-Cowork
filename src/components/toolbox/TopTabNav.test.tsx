// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Boxes, UsersRound } from 'lucide-react';
import TopTabNav from './TopTabNav';

describe('TopTabNav', () => {
  it('tints only the active tab, so it does not read like a hover state', () => {
    // The clay tint is the same pill 「开始对话」 uses; an active tab that
    // borrowed the hover treatment was indistinguishable from a hovered one.
    render(
      <TopTabNav
        items={[
          { id: 'members', label: '专家', icon: UsersRound },
          { id: 'teams', label: '专家团', icon: Boxes },
        ]}
        activeId="members"
        onSelect={vi.fn()}
      />,
    );
    const active = screen.getByRole('button', { name: '专家' });
    const inactive = screen.getByRole('button', { name: '专家团' });
    expect(active.className).toContain('abu-clay-bg');
    expect(inactive.className).not.toContain('abu-clay-bg');
  });
});
