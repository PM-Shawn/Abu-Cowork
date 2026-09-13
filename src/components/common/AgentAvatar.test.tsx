// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import AgentAvatar, { agentAvatarValue } from './AgentAvatar';

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
