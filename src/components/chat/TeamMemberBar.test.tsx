// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { act, cleanup, fireEvent, render as renderBare, screen } from '@testing-library/react';
import type { ComponentProps, ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { useTeamStore } from '@/stores/teamStore';
import { usePreviewStore } from '@/stores/previewStore';
import { DesignSystemProvider } from '@/components/ds/provider';
import type { Conversation, SubagentDefinition } from '@/types';
import TeamMemberBar from './TeamMemberBar';

const iconButtonRenders = vi.hoisted(() => vi.fn());

// Counts renders of the only floating-layer control in the bar (its tooltip).
vi.mock('@/components/ds/button', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ds/button')>();
  return {
    ...actual,
    IconButton: (props: ComponentProps<typeof actual.IconButton>) => {
      iconButtonRenders();
      return actual.IconButton(props);
    },
  };
});

const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });

vi.mock('@/core/team/roleIdentity', () => ({
  resolveRoleId: (roleId: string) => ({
    'r-lead': { name: 'zz数据分析师', description: 'lead', avatar: '📊' },
    'r-a': { name: 'zz取数员', description: 'a' },
  } as Record<string, Partial<SubagentDefinition>>)[roleId] as SubagentDefinition ?? null,
}));

describe('TeamMemberBar', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    useTeamStore.setState({ teams: [{ id: 't1', name: 'zz数据小队', leaderRoleId: 'r-lead', memberRoleIds: ['r-lead', 'r-a'], createdAt: 1 }]});
    const conversation: Conversation = { id: 'c1', title: 'x', teamId: 't1', createdAt: 1, updatedAt: 2, status: 'idle', messages: [] };
    useChatStore.setState({ activeConversationId: 'c1', conversations: { c1: conversation }, agentStates: new Map() });
    usePreviewStore.getState().closeAllTabs();
  });
  afterEach(() => { cleanup(); useTeamStore.setState({ teams: []}); });

  it('shows leader + member chips; the leader chip opens the team tab, an idle member too', () => {
    render(<TeamMemberBar conversationId="c1" />);
    const bar = screen.getByTestId('team-member-bar');
    expect(bar).toHaveTextContent('zz数据分析师');
    expect(bar).toHaveTextContent('队长');
    expect(bar).toHaveTextContent('zz取数员');
    fireEvent.click(screen.getByRole('button', { name: /zz取数员/ }));
    expect(usePreviewStore.getState().tabs.some((tab) => tab.kind === 'team')).toBe(true);
  });

  it('collapses to leader + "{n} members" and expands back', () => {
    render(<TeamMemberBar conversationId="c1" />);
    fireEvent.click(screen.getByRole('button', { name: '收起成员条' }));
    const bar = screen.getByTestId('team-member-bar');
    expect(bar).toHaveAttribute('data-collapsed', 'true');
    expect(bar).toHaveTextContent('zz数据分析师');
    expect(bar).toHaveTextContent('1 位专家');
    expect(bar).not.toHaveTextContent('zz取数员');
    fireEvent.click(screen.getByRole('button', { name: '展开成员条' }));
    expect(screen.getByTestId('team-member-bar')).toHaveTextContent('zz取数员');
  });

  it('names the collapse control once, through its tooltip, and says whether the bar is open', () => {
    render(<TeamMemberBar conversationId="c1" />);
    const toggle = screen.getByRole('button', { name: '收起成员条' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).not.toHaveAttribute('title');
    expect(toggle.querySelector('svg.lucide-chevron-up')).not.toBeNull();
  });

  it('does not re-render the collapse control while the conversation streams', () => {
    render(<TeamMemberBar conversationId="c1" />);
    const settled = iconButtonRenders.mock.calls.length;
    for (const content of ['a', 'ab', 'abc']) {
      act(() => {
        const conversation = useChatStore.getState().conversations.c1;
        useChatStore.setState({
          conversations: {
            c1: { ...conversation, messages: [{ id: 'm1', role: 'assistant', content, timestamp: 3 }] },
          },
        });
      });
    }
    expect(screen.getByTestId('team-member-bar')).toHaveTextContent('zz取数员');
    expect(iconButtonRenders.mock.calls.length).toBe(settled);
  });
});
