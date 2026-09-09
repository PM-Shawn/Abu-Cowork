// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { usePermissionStore } from '@/stores/permissionStore';
import { useTeamConfirmationStore } from '@/stores/teamConfirmationStore';
import type { Conversation } from '@/types';
import { decideTeamConfirmation, waitForTeamConfirmation } from '@/core/agent/teamConfirmations';
import TeamConfirmationsStrip from './TeamConfirmationsStrip';

const runAgentLoopDispatched = vi.fn((..._args: unknown[]) => Promise.resolve({ reason: 'completed' }));
vi.mock('@/core/agent/agentLoopRunner', () => ({ runAgentLoopDispatched: (...args: unknown[]) => runAgentLoopDispatched(...args) }));
const enqueueUserInput = vi.fn((..._args: unknown[]) => undefined);
vi.mock('@/core/agent/userInputQueue', () => ({ enqueueUserInput: (...args: unknown[]) => enqueueUserInput(...args) }));

function conversation(status: Conversation['status']): Conversation {
  return { id: 'c1', title: 'x', teamId: 't1', createdAt: 1, updatedAt: 2, status, messages: [] };
}

const identity = { toolName: 'run_command', parametersDigest: 'p', cwd: '/project', loopId: 'original', callId: 'call', dispatchId: 'leader', dispatchFingerprint: 'leader', requestOrdinal: 1 };

describe('TeamConfirmationsStrip', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    useTeamConfirmationStore.setState({ pending: {}, waiting: {}, permissionActivity: {}, approvedOnce: {}, runRules: {}, retrySelections: {} });
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
    useTeamConfirmationStore.getState().add({ identity, conversationId: 'c1', kind: 'command', detail: 'npm publish', member: 'zz发布员', reason: '发布' });
    render(<TeamConfirmationsStrip conversationId="c1" />);
    expect(screen.getByTestId('team-confirmations-strip')).toHaveTextContent('zz发布员');
    expect(screen.getByTestId('team-confirmations-strip')).toHaveTextContent('/project');
    fireEvent.click(screen.getByRole('button', { name: '重新尝试: npm publish' }));
    expect(useTeamConfirmationStore.getState().approvedOnce).toEqual({});
    expect(Object.keys(useTeamConfirmationStore.getState().retrySelections)).toHaveLength(1);
    expect(screen.queryByText('工作目录:')).toBeNull();
    expect(runAgentLoopDispatched).toHaveBeenCalledTimes(1);
    expect(String(runAgentLoopDispatched.mock.calls[0][1])).toContain('zz发布员');
    expect(String(runAgentLoopDispatched.mock.calls[0][1])).toContain('npm publish');
    expect(screen.queryByTestId('team-confirmations-strip')).toBeNull();
  });

  it('approving file access never grants process-wide permission; the selected retry is queued with its identity', () => {
    useChatStore.setState({ conversations: { c1: conversation('running') } });
    useTeamConfirmationStore.getState().add({ identity, conversationId: 'c1', kind: 'file', detail: '/tmp/report', path: '/tmp/report', capability: 'write', member: 'zz撰写员' });
    useTeamConfirmationStore.getState().add({ identity, conversationId: 'c1', kind: 'command', detail: 'rm -rf build', member: 'zz取数员' });
    render(<TeamConfirmationsStrip conversationId="c1" />);
    fireEvent.click(screen.getByRole('button', { name: '重新尝试: /tmp/report' }));
    expect(usePermissionStore.getState().hasPermission('/tmp/report', 'write')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '忽略: rm -rf build' }));
    expect(enqueueUserInput).toHaveBeenCalledTimes(1);
    expect(runAgentLoopDispatched).not.toHaveBeenCalled();
    expect(screen.queryByTestId('team-confirmations-strip')).toBeNull();
  });
  it('answers the live call without queuing or starting another model turn; details are expandable', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-09T00:00:00Z'));
    const abort = new AbortController();
    const item = { identity, kind: 'command' as const, detail: 'npm publish', member: 'A', reason: 'publish package' };
    decideTeamConfirmation('c1', item);
    const answer = waitForTeamConfirmation('c1', item, abort.signal);
    try {
      render(<TeamConfirmationsStrip conversationId="c1" />);
      expect(screen.getByText('这一步正在等待你批准，允许后会接着执行。')).toBeInTheDocument();
      expect(screen.getByText('publish package')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '查看操作详情' })).toHaveAttribute('aria-expanded', 'false');
      fireEvent.click(screen.getByRole('button', { name: '查看操作详情' }));
      expect(screen.getByText('publish package')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /本次补跑运行内/ })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: '允许此次: npm publish' }));
      await expect(answer).resolves.toBe(true);
      expect(enqueueUserInput).not.toHaveBeenCalled();
      expect(runAgentLoopDispatched).not.toHaveBeenCalled();
      expect(useTeamConfirmationStore.getState().approvedOnce).toEqual({});
      expect(screen.queryByTestId('team-confirmations-strip')).toBeNull();
    } finally { abort.abort(); vi.useRealTimers(); }
  });

  it('shows a revocable rule with run scope and cwd, and disables legacy approvals', () => {
    const item = useTeamConfirmationStore.getState().add({ identity, conversationId: 'c1', kind: 'command', detail: 'npm publish', member: 'A' })!;
    render(<TeamConfirmationsStrip conversationId="c1" />);
    act(() => { useTeamConfirmationStore.getState().selectRetry(item.id, 'run'); });
    act(() => useTeamConfirmationStore.getState().beginRetry('c1', 'retry', item.id));
    expect(screen.getByTestId('team-confirmations-strip')).toHaveTextContent('结束即失效');
    expect(screen.getByTestId('team-confirmations-strip')).toHaveTextContent('/project');
    fireEvent.click(screen.getByRole('button', { name: '撤销规则' }));
    expect(useTeamConfirmationStore.getState().runRules).toEqual({});
    act(() => { useTeamConfirmationStore.getState().add({ conversationId: 'c1', kind: 'command', detail: 'legacy' }); });
    expect(screen.getByRole('button', { name: '重新尝试: legacy' })).toBeDisabled();
  });

});
