// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { useTeamStore } from '@/stores/teamStore';
import { usePreviewStore } from '@/stores/previewStore';
import type { Conversation, SubagentDefinition } from '@/types';
import TeamTab from './TeamTab';

const defs: Record<string, Partial<SubagentDefinition>> = {
  'r-lead': { name: 'zz数据分析师', description: 'lead', avatar: '📊' },
  'r-a': { name: 'zz取数员', description: 'a', avatar: '🔢' },
  'r-b': { name: 'zz撰写员', description: 'b' },
};
vi.mock('@/core/team/roleIdentity', () => ({
  resolveRoleId: (roleId: string) => (defs[roleId] as SubagentDefinition) ?? null,
}));

describe('TeamTab', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    useTeamStore.setState({ teams: [{ id: 't1', name: 'zz数据小队', leaderRoleId: 'r-lead', memberRoleIds: ['r-lead', 'r-a', 'r-b'], createdAt: 1 }], tasks: [] });
    const conversation: Conversation = {
      id: 'c1', title: '出周报', teamId: 't1', createdAt: 1, updatedAt: 2, status: 'idle',
      messages: [{
        id: 'a1', role: 'assistant', content: '', timestamp: 5,
        executionSteps: [{ id: 'd1', toolCallId: 'tc-d', type: 'delegate', label: '委派', status: 'completed', toolName: 'delegate_to_agent', agentName: 'zz取数员',
          childSteps: [{ id: 'c1', type: 'tool', label: 'read', status: 'completed', toolName: 'read_file' }] }],
      }],
    };
    useChatStore.setState({ activeConversationId: 'c1', conversations: { c1: conversation }, agentStates: new Map() });
    usePreviewStore.getState().closeAllTabs();
  });
  afterEach(() => { cleanup(); useTeamStore.setState({ teams: [], tasks: [] }); });

  it('lists the leader and members with hand-off status, and opens the member tab from a hand-off', () => {
    render(<TeamTab conversationId="c1" />);
    expect(screen.getByText('zz数据小队')).toBeInTheDocument();
    expect(screen.getByText('zz数据分析师')).toBeInTheDocument();
    const rows = screen.getAllByTestId('team-member-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('zz取数员');
    expect(rows[0]).toHaveTextContent('派活 1 次');
    expect(rows[1]).toHaveTextContent('zz撰写员');
    expect(rows[1]).toHaveTextContent('还没派过活');

    fireEvent.click(screen.getByRole('button', { name: /查看第 1 次/ }));
    const tabs = usePreviewStore.getState().tabs;
    expect(tabs.some((tab) => tab.kind === 'subagent' && tab.title === 'zz取数员' && tab.identity.batchToolCallId === 'tc-d')).toBe(true);
  });

  it('explains when the conversation has no team', () => {
    useChatStore.setState((s) => ({ conversations: { c1: { ...s.conversations.c1, teamId: undefined } } }));
    render(<TeamTab conversationId="c1" />);
    expect(screen.getByText('这个对话没有指定团队。')).toBeInTheDocument();
  });
});
