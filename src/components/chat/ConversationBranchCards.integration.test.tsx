// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { getI18n } from '@/i18n';
import SkillProposalCard from './SkillProposalCard';
import SandboxRecoveryCard from './SandboxRecoveryCard';

beforeEach(() => {
  useChatStore.setState({ conversations: { child: { id: 'child', title: 'Branch', createdAt: 1, updatedAt: 2, status: 'idle',
    messages: [{ id: 'inherited', role: 'assistant', content: 'Historical result', timestamp: 2, inheritedFromBranch: true }] } } });
});
afterEach(cleanup);
describe('inherited interactive cards with the real conversation store', () => {
  it('keeps skill proposal text readable and offers no historical accept or reject action', () => {
    const t = getI18n();
    render(<SkillProposalCard conversationId="child" messageId="inherited" toolCallId="call" card={{ type: 'skill-proposal', id: 'draft',
      skillProposal: { skillName: 'Historical skill', description: 'Saved proposal', triggerReason: 'Saved reason',
        draftPath: '/work/draft/SKILL.md', workspacePath: '/work', fullContent: 'Saved instructions' } }} />);
    expect(screen.getByText('Historical skill')).toBeTruthy();
    expect(screen.queryByRole('button', { name: t.toolbox.skillProposalCardAccept })).toBeNull();
    expect(screen.queryByRole('button', { name: t.toolbox.skillProposalCardReject })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t.toolbox.skillProposalCardExpand }));
    expect(screen.getByText('Saved instructions')).toBeTruthy();
  });
  it('shows a historical sandbox explanation without restarting the old task', () => {
    render(<SandboxRecoveryCard conversationId="child" messageId="inherited" toolCallId="call"
      recovery={{ kind: 'app-automation', targetApp: 'Notes' }} />);
    expect(screen.getByText(getI18n().sandbox.appAutomationTitle)).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(useChatStore.getState().conversations.child.status).toBe('idle');
  });
});
