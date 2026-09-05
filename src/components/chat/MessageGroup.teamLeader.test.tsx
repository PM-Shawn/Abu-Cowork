// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { useTeamStore } from '@/stores/teamStore';
import type { Conversation, Message, SubagentDefinition } from '@/types';
import MessageGroup from './MessageGroup';

vi.mock('@/core/team/roleIdentity', () => ({
  resolveRoleId: (roleId: string) =>
    roleId === 'r-lead' ? ({ name: 'zz数据分析师', description: 'lead', avatar: '📊' } as SubagentDefinition) : null,
}));

function seed(teamId?: string) {
  const assistant: Message = { id: 'a1', role: 'assistant', content: '周报已完成。', timestamp: 2_000 };
  const conversation: Conversation = {
    id: 'conv-team', title: '出一版周报', messages: [assistant], createdAt: 1_000, updatedAt: 2_000, status: 'idle',
    ...(teamId ? { teamId } : {}),
  };
  useChatStore.setState({ activeConversationId: conversation.id, conversations: { [conversation.id]: conversation }, agentStates: new Map() });
  useTeamStore.setState({
    teams: [{ id: 't1', name: 'zz数据小队', leaderRoleId: 'r-lead', memberRoleIds: ['r-lead'], createdAt: 1 }],
    tasks: [],
  });
  return { conversation, assistant };
}

describe('MessageGroup in a team-pinned conversation', () => {
  beforeEach(() => { initLanguage('zh-CN'); });
  afterEach(() => { cleanup(); useTeamStore.setState({ teams: [], tasks: [] }); });

  it('shows the leader avatar and a "leader · team" caption', () => {
    const { conversation, assistant } = seed('t1');
    render(<MessageGroup conversationId={conversation.id} messages={[assistant]} isLastGroup />);
    expect(screen.getByTestId('assistant-row-avatar-leader')).toHaveTextContent('📊');
    expect(screen.getByTestId('assistant-row-avatar-leader')).toHaveAttribute('aria-label', 'zz数据分析师');
    expect(screen.getByTestId('team-leader-caption')).toHaveTextContent('zz数据分析师 · zz数据小队');
  });

  it('keeps Abu for an ordinary conversation', () => {
    const { conversation, assistant } = seed();
    render(<MessageGroup conversationId={conversation.id} messages={[assistant]} isLastGroup />);
    expect(screen.queryByTestId('assistant-row-avatar-leader')).toBeNull();
    expect(screen.queryByTestId('team-leader-caption')).toBeNull();
    expect(screen.getByAltText('Abu')).toBeInTheDocument();
  });
});
