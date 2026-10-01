// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { cleanup, render as renderBare, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import { initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { useTeamStore } from '@/stores/teamStore';
import type { Conversation, Message, SubagentDefinition } from '@/types';
import MessageGroup from './MessageGroup';

// The action row's icon buttons carry ds tooltips, which need the provider the app mounts at its root.
const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });

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
    teams: [{ id: 't1', name: 'zz数据小队', leaderRoleId: 'r-lead', memberRoleIds: ['r-lead'], createdAt: 1 }]
  });
  return { conversation, assistant };
}

describe('MessageGroup in a team-pinned conversation', () => {
  beforeEach(() => { initLanguage('zh-CN'); });
  afterEach(() => { cleanup(); useTeamStore.setState({ teams: []}); });

  it('shows the leader avatar and a "leader · team" caption', () => {
    const { conversation, assistant } = seed('t1');
    render(<MessageGroup conversationId={conversation.id} messages={[assistant]} isLastGroup />);
    // A user agent with an avatar shows its emoji; the mocked leader has no filePath so it counts as the user's own.
    expect(screen.getByTestId('assistant-row-avatar-leader')).toHaveTextContent('📊');
    expect(screen.getByTestId('assistant-row-avatar-leader')).toHaveAttribute('aria-label', 'zz数据分析师');
    expect(screen.getByTestId('team-leader-caption')).toHaveTextContent('zz数据分析师 · zz数据小队');
    expect(screen.getByTestId('team-leader-caption')).toHaveClass('text-ui');
    expect(screen.getByTestId('team-leader-caption')).toHaveClass('text-label-secondary');
  });

  it('keeps Abu for an ordinary conversation', () => {
    const { conversation, assistant } = seed();
    render(<MessageGroup conversationId={conversation.id} messages={[assistant]} isLastGroup />);
    expect(screen.queryByTestId('assistant-row-avatar-leader')).toBeNull();
    expect(screen.queryByTestId('team-leader-caption')).toBeNull();
    expect(screen.getByAltText('Abu')).toBeInTheDocument();
  });
});
