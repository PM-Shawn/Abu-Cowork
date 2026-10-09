// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AVATAR_TINT_MAP } from '@/core/team/avatarPresets';
import TeamAvatar from './TeamAvatar';

const classes = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/);

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
    expect(classes(box)).toContain('size-10');
    expect(classes(box)).toContain('rounded-control');
    expect(box.querySelector('svg')?.getAttribute('width')).toBe('16');
  });

  it('fills the 56px detail slot at size="2xl", matching its radius', () => {
    render(<TeamAvatar avatar="icon:code/purple" size="2xl" />);
    const box = screen.getByTestId('team-avatar');
    expect(classes(box)).toContain('size-14');
    expect(box.querySelector('svg')?.getAttribute('width')).toBe('20');
    expect(classes(box)).toContain('rounded-panel');
  });

  it('stays a circle at size="2xl" when round', () => {
    render(<TeamAvatar avatar="icon:code/purple" size="2xl" round />);
    expect(classes(screen.getByTestId('team-avatar'))).toContain('rounded-full');
    expect(classes(screen.getByTestId('team-avatar'))).not.toContain('rounded-panel');
  });

  it('paints the tint of a preset as the identity colour and the group mark grey', () => {
    const { unmount } = render(<TeamAvatar avatar="icon:code/purple" />);
    const tinted = screen.getByTestId('team-avatar');
    expect(tinted.style.backgroundColor).toBe(AVATAR_TINT_MAP.purple.bg);
    expect(tinted.style.color).toBe(AVATAR_TINT_MAP.purple.fg);
    expect(tinted.querySelector('svg')?.getAttribute('stroke-width')).toBe('1.5');
    unmount();
    render(<TeamAvatar />);
    const plain = screen.getByTestId('team-avatar');
    expect(plain.getAttribute('style')).toBeNull();
    expect(classes(plain)).toContain('bg-fill');
    expect(plain.querySelector('svg')?.getAttribute('class')).toContain('text-label-tertiary');
  });

  it('lets the caller size the box and adds no floating layer of its own', () => {
    // The team welcome asks for an 80px circle; avatars also sit in long lists.
    const { container } = render(<TeamAvatar avatar="icon:code/purple" size="lg" round className="mx-auto" />);
    const avatar = screen.getByTestId('team-avatar');
    expect(classes(avatar)).toContain('mx-auto');
    expect(container.firstElementChild).toBe(avatar);
    expect([...avatar.children].map((child) => child.tagName.toLowerCase())).toEqual(['svg']);
  });
});
