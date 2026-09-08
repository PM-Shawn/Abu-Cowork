// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import AgentAvatar, { userAgentAvatar } from './AgentAvatar';

describe('AgentAvatar', () => {
  afterEach(cleanup);

  it('shows the default mark for builtin/marketplace presets even when they ship an emoji', () => {
    expect(userAgentAvatar({ avatar: '📊', filePath: '__builtin__' })).toBeNull();
    expect(userAgentAvatar({ avatar: '📊', filePath: '/Applications/Abu.app/Contents/Resources/builtin-agents/analyst/AGENT.md' })).toBeNull();
    render(<AgentAvatar agent={{ name: '数据分析师', avatar: '📊', filePath: '__builtin__' }} />);
    expect(screen.getByTestId('agent-avatar')).toHaveAttribute('data-avatar-kind', 'default');
  });

  it("shows the user's own emoji for their agents, default when unset", () => {
    expect(userAgentAvatar({ avatar: '🔢', filePath: '/Users/me/.abu/agents/a.md' })).toBe('🔢');
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
