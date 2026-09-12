// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import ChatView from './ChatView';
import { agentRegistry } from '@/core/agent/registry';
import { useChatStore } from '@/stores/chatStore';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
import { useSettingsStore } from '@/stores/settingsStore';
import type { SubagentDefinition } from '@/types';

vi.mock('@/core/agent/agentLoopRunner', () => ({ runAgentLoopDispatched: vi.fn() }));
vi.mock('./ScenarioGuide', () => ({ default: () => null }));

const ICON_AVATAR = 'icon:code/blue';

function givenPendingAgent(avatar?: string): void {
  const agent = {
    name: 'frontend-engineer',
    description: '写页面',
    filePath: '/Users/tester/.abu/agents/frontend-engineer/AGENT.md',
    systemPrompt: 'p',
    avatar,
  } as SubagentDefinition;
  vi.spyOn(agentRegistry, 'getAgent').mockReturnValue(agent);
  useChatStore.setState({ pendingAgentName: agent.name });
}

describe('ChatView welcome page avatar', () => {
  beforeEach(() => {
    useChatStore.setState(useChatStore.getInitialState(), true);
    useSettingsStore.setState(useSettingsStore.getInitialState(), true);
    useEnterpriseStore.setState({ mode: { kind: 'personal' }, initialized: true });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  // Abu writes `icon:<icon>/<tint>` itself now, and the user's own experts
  // already carry it: this screen used to print the value as text.
  it('renders a built-in icon reference as that icon, never as its raw value', () => {
    givenPendingAgent(ICON_AVATAR);

    render(<ChatView />);

    const avatar = screen.getByTestId('welcome-avatar');
    expect(avatar).toHaveAttribute('data-avatar-kind', 'icon');
    expect(avatar.querySelector('svg')).not.toBeNull();
    expect(avatar.textContent).toBe('');
    expect(document.body.textContent).not.toContain(ICON_AVATAR);
    expect(document.body.textContent).not.toContain('icon:');
  });

  it('keeps showing a builtin expert emoji', () => {
    givenPendingAgent('🍮');

    render(<ChatView />);

    const avatar = screen.getByTestId('welcome-avatar');
    expect(avatar).toHaveAttribute('data-avatar-kind', 'emoji');
    expect(avatar).toHaveTextContent('🍮');
  });

  it('falls back to the robot mark when the expert has no avatar', () => {
    givenPendingAgent(undefined);

    render(<ChatView />);

    const avatar = screen.getByTestId('welcome-avatar');
    expect(avatar).toHaveAttribute('data-avatar-kind', 'default');
    expect(avatar).toHaveTextContent('🤖');
  });
});
