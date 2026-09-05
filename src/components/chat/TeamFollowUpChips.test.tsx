// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { useTeamStore } from '@/stores/teamStore';
import { clearAllComposerDrafts, getComposerDraftKey, readComposerDraft } from '@/stores/composerDraftStore';
import type { Conversation, SubagentDefinition } from '@/types';
import TeamFollowUpChips from './TeamFollowUpChips';

vi.mock('@/core/team/roleIdentity', () => ({
  resolveRoleId: (roleId: string) => ({
    'r-lead': { name: 'zz数据分析师', description: 'lead' },
    'r-a': { name: 'zz取数员', description: 'a' },
    'r-b': { name: 'zz撰写员', description: 'b' },
  } as Record<string, Partial<SubagentDefinition>>)[roleId] as SubagentDefinition ?? null,
}));

function seed(status: Conversation['status'] = 'idle') {
  useTeamStore.setState({ teams: [{ id: 't1', name: 'zz数据小队', leaderRoleId: 'r-lead', memberRoleIds: ['r-lead', 'r-a', 'r-b'], createdAt: 1 }], tasks: [] });
  const conversation: Conversation = {
    id: 'c1', title: 'x', teamId: 't1', createdAt: 1, updatedAt: 2, status,
    messages: [
      { id: 'u1', role: 'user', content: '出周报', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: '完成', timestamp: 5,
        plannedSteps: [
          { index: 1, description: '整理数据', status: 'completed', owner: 'zz取数员' },
          { index: 2, description: '成文', status: 'completed', owner: 'zz撰写员' },
        ],
        executionSteps: [{ id: 'd1', toolCallId: 'tc-d', type: 'delegate', label: '委派', status: 'completed', toolName: 'delegate_to_agent', agentName: 'zz取数员' }],
      },
    ],
  };
  useChatStore.setState({ activeConversationId: 'c1', conversations: { c1: conversation }, agentStates: new Map() });
}

describe('TeamFollowUpChips', () => {
  beforeEach(() => { initLanguage('zh-CN'); clearAllComposerDrafts(); });
  afterEach(() => { cleanup(); useTeamStore.setState({ teams: [], tasks: [] }); clearAllComposerDrafts(); });

  it('offers redo-step chips from the last plan and revise chips only for dispatched members; a chip fills the composer', () => {
    seed();
    render(<TeamFollowUpChips conversationId="c1" />);
    const chips = screen.getByTestId('team-follow-up-chips');
    expect(chips).toHaveTextContent('重做第 1 步');
    expect(chips).toHaveTextContent('重做第 2 步');
    expect(chips).toHaveTextContent('让 zz取数员 再改一版');
    expect(chips).not.toHaveTextContent('让 zz撰写员 再改一版');

    fireEvent.click(screen.getByRole('button', { name: '重做第 2 步' }));
    expect(readComposerDraft(getComposerDraftKey('c1')).text).toBe('重做第 2 步：');
  });

  it('stays hidden while the leader is still running', () => {
    seed('running');
    render(<TeamFollowUpChips conversationId="c1" />);
    expect(screen.queryByTestId('team-follow-up-chips')).toBeNull();
  });
});
