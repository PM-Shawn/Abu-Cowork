// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AVATAR_TINT_MAP } from '@/core/team/avatarPresets';
import AgentAvatar, { agentAvatarValue } from './AgentAvatar';

const classes = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/);

describe('AgentAvatar', () => {
  afterEach(cleanup);

  // Ruling 2026-09-13: the built-in and marketplace presets carry their own
  // icon references, so an avatar renders wherever it came from. One rule for
  // every source; only an expert without an avatar gets the robot mark.
  it("renders a builtin preset's icon reference", () => {
    expect(agentAvatarValue({ avatar: 'icon:code/blue', filePath: '__builtin__' })).toBe('icon:code/blue');
    render(<AgentAvatar agent={{ name: '高级开发工程师', avatar: 'icon:code/blue', filePath: '__builtin__' }} />);
    expect(screen.getByTestId('agent-avatar')).toHaveAttribute('data-avatar-kind', 'icon');
    expect(screen.getByTestId('agent-avatar').querySelector('svg')).not.toBeNull();
    expect(screen.getByTestId('agent-avatar').textContent).not.toContain('icon:');
  });

  it('still shows the default mark for a builtin expert with no avatar', () => {
    expect(agentAvatarValue({ filePath: '__builtin__' })).toBeNull();
    render(<AgentAvatar agent={{ name: '产品经理', filePath: '__builtin__' }} />);
    expect(screen.getByTestId('agent-avatar')).toHaveAttribute('data-avatar-kind', 'default');
  });

  it('no longer suppresses an emoji just because the agent is builtin', () => {
    render(<AgentAvatar agent={{ name: '数据分析师', avatar: '📊', filePath: '__builtin__' }} />);
    expect(screen.getByTestId('agent-avatar')).toHaveAttribute('data-avatar-kind', 'emoji');
    expect(screen.getByTestId('agent-avatar')).toHaveTextContent('📊');
  });

  it("shows the user's own emoji for their agents, default when unset", () => {
    expect(agentAvatarValue({ avatar: '🔢', filePath: '/Users/me/.abu/agents/a.md' })).toBe('🔢');
    render(<AgentAvatar agent={{ name: 'zz取数员', avatar: '🔢', filePath: '/Users/me/.abu/agents/a.md' }} />);
    expect(screen.getByTestId('agent-avatar')).toHaveAttribute('data-avatar-kind', 'emoji');
    expect(screen.getByTestId('agent-avatar')).toHaveTextContent('🔢');
    cleanup();
    render(<AgentAvatar agent={{ name: 'zz撰写员', filePath: '/Users/me/.abu/agents/b.md' }} />);
    expect(screen.getByTestId('agent-avatar')).toHaveAttribute('data-avatar-kind', 'default');
  });

  it('renders the mascot image for abu', () => {
    render(<AgentAvatar agent={{ name: 'abu' }} />);
    expect(screen.getByAltText('Abu')).toBeInTheDocument();
  });

  // Ruling 2026-09-14: on the expert card and the detail header the avatar
  // fills the grey slot (40px / 56px) instead of sitting in it as a smaller
  // tinted box. The slots themselves stay — skills and plugins still use them.
  it('fills the 40px card slot at size="xl"', () => {
    render(<AgentAvatar agent={{ name: 'coder', avatar: 'icon:code/blue' }} size="xl" />);
    const box = screen.getByTestId('agent-avatar');
    expect(classes(box)).toContain('size-10');
    expect(classes(box)).toContain('rounded-control');
    expect(box.querySelector('svg')?.getAttribute('width')).toBe('16');
  });

  it('fills the 56px detail slot at size="2xl", matching its radius', () => {
    render(<AgentAvatar agent={{ name: 'coder', avatar: 'icon:code/blue' }} size="2xl" />);
    const box = screen.getByTestId('agent-avatar');
    expect(classes(box)).toContain('size-14');
    expect(box.querySelector('svg')?.getAttribute('width')).toBe('20');
    // The detail slot has panel corners and does not clip: an avatar with
    // control corners would leave grey corners showing through.
    expect(classes(box)).toContain('rounded-panel');
  });

  it('stays a circle at size="2xl" when round', () => {
    render(<AgentAvatar agent={{ name: 'coder', avatar: 'icon:code/blue' }} size="2xl" round />);
    expect(classes(screen.getByTestId('agent-avatar'))).toContain('rounded-full');
    expect(classes(screen.getByTestId('agent-avatar'))).not.toContain('rounded-panel');
  });

  it.each([
    ['xs', 'size-4', '14'],
    ['sm', 'size-5', '14'],
    ['md', 'size-7', '16'],
    ['lg', 'size-8', '16'],
  ] as const)('draws size %s as a %s box with a %spx design-system icon', (size, box, px) => {
    render(<AgentAvatar agent={{ name: 'coder', avatar: 'icon:code/blue' }} size={size} />);
    const avatar = screen.getByTestId('agent-avatar');
    expect(classes(avatar)).toContain(box);
    const glyph = avatar.querySelector('svg')!;
    expect(glyph.getAttribute('width')).toBe(px);
    expect(glyph.getAttribute('height')).toBe(px);
    expect(glyph.getAttribute('stroke-width')).toBe('1.5');
  });

  it('paints the tint of a preset as the identity colour, over the neutral fill', () => {
    render(<AgentAvatar agent={{ name: 'coder', avatar: 'icon:code/blue' }} />);
    const avatar = screen.getByTestId('agent-avatar');
    expect(avatar.style.backgroundColor).toBe(AVATAR_TINT_MAP.blue.bg);
    expect(avatar.style.color).toBe(AVATAR_TINT_MAP.blue.fg);
    expect(classes(avatar)).toContain('bg-fill');
    // The glyph takes the tint's own foreground.
    expect(avatar.querySelector('svg')?.getAttribute('class') ?? '').not.toContain('text-label-tertiary');
  });

  it('draws the default mark grey on the neutral fill, with no inline colour', () => {
    render(<AgentAvatar agent={{ name: 'coder' }} />);
    const avatar = screen.getByTestId('agent-avatar');
    expect(avatar.getAttribute('style')).toBeNull();
    expect(classes(avatar)).toContain('bg-fill');
    expect(avatar.querySelector('svg')?.getAttribute('class')).toContain('text-label-tertiary');
    expect(avatar).toHaveAttribute('aria-hidden', 'true');
  });

  it('gives a legacy emoji the type size of its slot', () => {
    render(<AgentAvatar agent={{ name: 'coder', avatar: '📊' }} size="xl" />);
    expect(classes(screen.getByText('📊'))).toContain('text-title');
    cleanup();
    render(<AgentAvatar agent={{ name: 'coder', avatar: '📊' }} size="2xl" />);
    expect(classes(screen.getByText('📊'))).toContain('text-title-lg');
    cleanup();
    render(<AgentAvatar agent={{ name: 'coder', avatar: '📊' }} size="sm" />);
    expect(classes(screen.getByText('📊'))).toContain('text-ui-sm');
  });

  it('adds no floating layer of its own: an avatar is a span with a glyph in it', () => {
    // Avatars sit in every row of the message list, the sidebar and the team panel.
    const { container } = render(<AgentAvatar agent={{ name: 'coder', avatar: 'icon:code/blue' }} />);
    const avatar = screen.getByTestId('agent-avatar');
    expect(container.children).toHaveLength(1);
    expect(container.firstElementChild).toBe(avatar);
    expect(avatar.tagName).toBe('SPAN');
    expect([...avatar.children].map((child) => child.tagName.toLowerCase())).toEqual(['svg']);
    expect(avatar).not.toHaveAttribute('data-state');
  });

  it.each([
    ['icon:code/purple', 'icon'],
    ['icon:code/missing', 'default'],
    ['icon:constructor/blue', 'default'],
  ])('renders a user avatar %s as %s', (avatar, kind) => {
    render(<AgentAvatar agent={{ name: 'coder', avatar, filePath: '/agents/coder/AGENT.md' }} />);
    expect(screen.getByTestId('agent-avatar')).toHaveAttribute('data-avatar-kind', kind);
    expect(screen.getByTestId('agent-avatar').textContent).not.toContain('icon:');
  });
});
