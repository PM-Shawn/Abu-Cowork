// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { usePermissionStore } from '@/stores/permissionStore';
import { useTeamConfirmationStore } from '@/stores/teamConfirmationStore';
import type { Conversation } from '@/types';
import TeamConfirmationsStrip from './TeamConfirmationsStrip';

const runAgentLoopDispatched = vi.fn((..._args: unknown[]) => Promise.resolve({ reason: 'completed' }));
vi.mock('@/core/agent/agentLoopRunner', () => ({ runAgentLoopDispatched: (...args: unknown[]) => runAgentLoopDispatched(...args) }));
const enqueueUserInput = vi.fn((..._args: unknown[]) => undefined);
vi.mock('@/core/agent/userInputQueue', () => ({ enqueueUserInput: (...args: unknown[]) => enqueueUserInput(...args) }));

function conversation(status: Conversation['status']): Conversation {
  return { id: 'c1', title: 'x', teamId: 't1', createdAt: 1, updatedAt: 2, status, messages: [] };
}

describe('TeamConfirmationsStrip', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    useTeamConfirmationStore.setState({ pending: {}, approvedOnce: {} });
    usePermissionStore.setState({ persistedGrants: {}, sessionGrants: {}, pendingRequest: null });
    useChatStore.setState({ activeConversationId: 'c1', conversations: { c1: conversation('idle') }, agentStates: new Map() });
    vi.clearAllMocks();
  });
  afterEach(() => cleanup());

  it('renders nothing without pending confirmations', () => {
    const { container } = render(<TeamConfirmationsStrip conversationId="c1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('approving a command stores a one-shot approval and asks the idle leader to re-run that step', async () => {
    useTeamConfirmationStore.getState().add({ conversationId: 'c1', kind: 'command', detail: 'npm publish', member: 'zz发布员', reason: '发布' });
    render(<TeamConfirmationsStrip conversationId="c1" />);
    expect(screen.getByTestId('team-confirmations-strip')).toHaveTextContent('zz发布员');
    fireEvent.click(screen.getByRole('button', { name: '允许并补跑: npm publish' }));
    expect(useTeamConfirmationStore.getState().consumeApproval('c1', 'command:npm publish')).toBe(true);
    expect(runAgentLoopDispatched).toHaveBeenCalledTimes(1);
    expect(String(runAgentLoopDispatched.mock.calls[0][1])).toContain('zz发布员');
    expect(String(runAgentLoopDispatched.mock.calls[0][1])).toContain('npm publish');
    expect(screen.queryByTestId('team-confirmations-strip')).toBeNull();
  });

  it('approving file access grants the path for the session; rejecting queues the follow-up while the leader runs', () => {
    useChatStore.setState({ conversations: { c1: conversation('running') } });
    useTeamConfirmationStore.getState().add({ conversationId: 'c1', kind: 'file', detail: '/tmp/report', path: '/tmp/report', capability: 'write', member: 'zz撰写员' });
    useTeamConfirmationStore.getState().add({ conversationId: 'c1', kind: 'command', detail: 'rm -rf build', member: 'zz取数员' });
    render(<TeamConfirmationsStrip conversationId="c1" />);
    fireEvent.click(screen.getByRole('button', { name: '允许并补跑: /tmp/report' }));
    expect(usePermissionStore.getState().hasPermission('/tmp/report', 'write')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '拒绝: rm -rf build' }));
    expect(enqueueUserInput).toHaveBeenCalledTimes(2);
    expect(String(enqueueUserInput.mock.calls[1][1])).toContain('拒绝');
    expect(runAgentLoopDispatched).not.toHaveBeenCalled();
    expect(screen.queryByTestId('team-confirmations-strip')).toBeNull();
  });
});
