// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { useTeamStore } from '@/stores/teamStore';
import { usePreviewStore } from '@/stores/previewStore';
import type { Conversation, SubagentDefinition } from '@/types';
import TeamMemberBar from './TeamMemberBar';

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
});
