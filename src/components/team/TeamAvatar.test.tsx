// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import TeamAvatar from './TeamAvatar';

describe('TeamAvatar', () => {
  it.each([
    [undefined, 'default'],
    ['📊', 'emoji'],
    ['icon:code/purple', 'icon'],
    ['icon:code/missing', 'default'],
    ['icon:constructor/blue', 'default'],
  ])('renders %s as %s', (avatar, kind) => {
    render(<TeamAvatar avatar={avatar} />);
    expect(screen.getByTestId('team-avatar')).toHaveAttribute('data-avatar-kind', kind);
    expect(screen.getByTestId('team-avatar').textContent).not.toContain('icon:');
  });

  // Ruling 2026-09-14: the team avatar fills the card slot (40px) and the
  // detail header slot (56px) rather than sitting in it as a smaller box.
  it('fills the 40px card slot at size="xl"', () => {
    render(<TeamAvatar avatar="icon:code/purple" size="xl" />);
    const box = screen.getByTestId('team-avatar');
    expect(box.className).toContain('h-10 w-10');
    expect(box.querySelector('svg')?.getAttribute('class')).toContain('h-5 w-5');
  });

  it('fills the 56px detail slot at size="2xl", matching its radius', () => {
    render(<TeamAvatar avatar="icon:code/purple" size="2xl" />);
    const box = screen.getByTestId('team-avatar');
    expect(box.className).toContain('h-14 w-14');
    expect(box.querySelector('svg')?.getAttribute('class')).toContain('h-6 w-6');
    expect(box.className).toContain('rounded-2xl');
  });

  it('stays a circle at size="2xl" when round', () => {
    render(<TeamAvatar avatar="icon:code/purple" size="2xl" round />);
    expect(screen.getByTestId('team-avatar').className).toContain('rounded-full');
  });
});
