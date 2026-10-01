// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initLanguage } from '@/i18n';
import { requestDispatchCancel } from '@/core/agent/dispatchCancel';
import { useChatStore } from '@/stores/chatStore';
import { clearComposerDraft, getComposerDraftKey, readComposerDraft } from '@/stores/composerDraftStore';
import { useTaskExecutionStore } from '@/stores/taskExecutionStore';
import { useTeamStore } from '@/stores/teamStore';
import { usePreviewStore } from '@/stores/previewStore';
import type { Conversation, SubagentDefinition } from '@/types';
import TeamTab, { STALL_MINUTES } from './TeamTab';

vi.mock('@/core/agent/dispatchCancel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/agent/dispatchCancel')>()),
  requestDispatchCancel: vi.fn(),
}));

const NOW = 1_700_000_000_000;

/** Hands a running task to each named member in a live run of conversation c1. */
function startLiveHandOffs(members: string[], startTime = NOW): void {
  const exec = useTaskExecutionStore.getState().createExecutionWithId('c1', 'loop-live', 'exec-live');
  members.forEach((agentName, index) => {
    useTaskExecutionStore.getState().addStep(exec.id, {
      id: `live-${index}`, executionId: exec.id, toolCallId: `tc-live-${index}`, type: 'delegate', label: '委派', status: 'running',
      toolName: 'delegate_to_agent', agentName, childSteps: [], detailBlocks: [], source: 'agent', toolInput: { task: `任务 ${index + 1}` },
      startTime,
    });
  });
}

/** The two places of the tab: the leader card and the member area. */
function placesOf(tab: HTMLElement): { leaderCard: HTMLElement; memberArea: HTMLElement; memberHeading: HTMLElement } {
  const leaderCard = tab.querySelector('header');
  const memberArea = tab.querySelector('section');
  const memberHeading = memberArea?.firstElementChild;
  if (!leaderCard || !memberArea || !(memberHeading instanceof HTMLElement)) throw new Error('The team tab is missing a place');
  return { leaderCard, memberArea, memberHeading };
}

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
    useTeamStore.setState({ teams: [{ id: 't1', name: 'zz数据小队', leaderRoleId: 'r-lead', memberRoleIds: ['r-lead', 'r-a', 'r-b'], createdAt: 1 }]});
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
    vi.mocked(requestDispatchCancel).mockClear();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    useTaskExecutionStore.getState().clearAll();
    clearComposerDraft(getComposerDraftKey('c1'));
    useTeamStore.setState({ teams: []});
  });

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

  it('shows a completed hand-off with zero tool calls as a plain hand-off, without a warning', () => {
    const conversation = useChatStore.getState().conversations.c1;
    const messages = [{
      id: 'a2', role: 'assistant' as const, content: '', timestamp: 6,
      executionSteps: [{ id: 'd2', toolCallId: 'tc-e', type: 'delegate' as const, label: '委派', status: 'completed' as const, toolName: 'delegate_to_agent', agentName: 'zz撰写员', childSteps: [] }],
    }];
    useChatStore.setState({ conversations: { c1: { ...conversation, messages: [...conversation.messages, ...messages] } } });
    render(<TeamTab conversationId="c1" />);
    const writer = screen.getAllByTestId('team-member-row')[1];
    expect(writer).toHaveTextContent('zz撰写员');
    expect(writer).toHaveTextContent('派活 1 次');
    expect(writer).not.toHaveTextContent('未调用工具');
  });

  it('keeps one spinner per place while the leader and two members work', () => {
    startLiveHandOffs(['zz取数员', 'zz撰写员']);
    render(<TeamTab conversationId="c1" />);
    const { leaderCard, memberArea, memberHeading } = placesOf(screen.getByTestId('team-tab'));

    // Member area: the only spinner sits in its title row and says how many are working.
    expect(memberArea.querySelectorAll('[data-ds-spinner]')).toHaveLength(1);
    expect(memberHeading.querySelectorAll('[data-ds-spinner]')).toHaveLength(1);
    expect(memberHeading).toHaveTextContent('专家 · 2');
    const working = within(memberHeading).getByRole('status');
    expect(working).toHaveTextContent('2 运行中');
    expect(within(working).getByText('2 运行中')).toHaveClass('sr-only');

    // Each working member: a still loading mark on its own line and on its running hand-off.
    for (const row of screen.getAllByTestId('team-member-row')) {
      expect(row).toHaveTextContent('运行中');
      expect(row.querySelectorAll('svg.lucide-loader-circle')).toHaveLength(2);
      expect(row.querySelector('.animate-spin')).toBeNull();
    }

    // Leader card: its own spinner, with the sentence in view.
    expect(leaderCard.querySelectorAll('[data-ds-spinner]')).toHaveLength(1);
    const leading = within(leaderCard).getByRole('status');
    expect(leading).toHaveTextContent('运行中');
    expect(within(leading).getByText('运行中')).not.toHaveClass('sr-only');
    expect(leading).toHaveClass('text-ui');
    expect(leading).toHaveClass('text-label-secondary');
    expect(leaderCard).not.toHaveTextContent('等待指令');
  });

  it('shows no spinner when nobody works: the leader waits and a finished hand-off carries a check', () => {
    render(<TeamTab conversationId="c1" />);
    const tab = screen.getByTestId('team-tab');
    const { leaderCard, memberHeading } = placesOf(tab);

    expect(tab.querySelector('[data-ds-spinner]')).toBeNull();
    expect(tab.querySelector('svg.lucide-loader-circle')).toBeNull();
    expect(within(memberHeading).queryByRole('status')).toBeNull();
    expect(leaderCard).toHaveTextContent('等待指令');
    // Same size and tone as the running sentence, so the line stays steady when the state changes.
    const waiting = within(leaderCard).getByText('等待指令');
    expect(waiting).toHaveClass('text-ui');
    expect(waiting).toHaveClass('text-label-secondary');
    expect(waiting).not.toHaveClass('text-caption');
    expect(waiting).not.toHaveClass('text-label-tertiary');
    expect(within(leaderCard).getByText('队长')).toHaveClass('bg-fill');

    const [fetcher, writer] = screen.getAllByTestId('team-member-row');
    expect(fetcher).toHaveTextContent('已完成');
    // Member line and its one finished hand-off.
    expect(fetcher.querySelectorAll('svg.text-success')).toHaveLength(2);
    // A member without work shows a plain dot, no icon.
    expect(within(writer).getByText('待命').querySelector('svg')).toBeNull();
    expect(within(writer).getByText('待命').querySelector('.rounded-full')).not.toBeNull();
  });

  it('stops one running hand-off from its own Stop button', () => {
    startLiveHandOffs(['zz取数员']);
    render(<TeamTab conversationId="c1" />);

    const stop = screen.getByRole('button', { name: '停止 zz取数员 这次的活' });
    expect(stop).toHaveAttribute('title', '停止 zz取数员 这次的活');
    expect(stop).toHaveTextContent('停止');
    expect(stop.querySelector('[data-ds-spinner]')).toBeNull();
    expect(screen.getAllByRole('button', { name: /这次的活/ })).toHaveLength(1);

    expect(requestDispatchCancel).not.toHaveBeenCalled();
    fireEvent.click(stop);
    expect(requestDispatchCancel).toHaveBeenCalledTimes(1);
    expect(requestDispatchCancel).toHaveBeenCalledWith('tc-live-0:0');
  });

  it('calls out a hand-off without a new step for a while, with a warning mark next to the words', () => {
    startLiveHandOffs(['zz取数员'], NOW - (STALL_MINUTES + 1) * 60_000);
    render(<TeamTab conversationId="c1" />);

    const stalled = screen.getByTestId('dispatch-stalled');
    expect(stalled).toHaveTextContent(`${STALL_MINUTES + 1} 分钟没有新动作`);
    expect(stalled.querySelector('svg.text-warning')).not.toBeNull();
    expect(within(stalled).getByText(`${STALL_MINUTES + 1} 分钟没有新动作`)).toHaveClass('text-warning');
    // The hint is part of the hand-off row, whose name stays the same.
    expect(screen.getByRole('button', { name: '查看第 2 次：任务 1' })).toContainElement(stalled);
  });

  it('adds an instruction for one member to the message box', () => {
    render(<TeamTab conversationId="c1" />);

    const buttons = screen.getAllByRole('button', { name: '追加指令' });
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toHaveAttribute('title', '追加指令');
    fireEvent.click(buttons[1]);
    expect(readComposerDraft(getComposerDraftKey('c1')).text).toBe('让 zz撰写员 追加处理：');
  });

  it('says so when the team has no members', () => {
    useTeamStore.setState({ teams: [{ id: 't1', name: 'zz数据小队', leaderRoleId: 'r-lead', memberRoleIds: ['r-lead'], createdAt: 1 }]});
    render(<TeamTab conversationId="c1" />);

    expect(screen.getByText('这个专家团还没有专家。')).toHaveClass('text-label-tertiary');
    expect(screen.queryByTestId('team-member-row')).toBeNull();
  });

  it('explains when the conversation has no team', () => {
    useChatStore.setState((s) => ({ conversations: { c1: { ...s.conversations.c1, teamId: undefined } } }));
    render(<TeamTab conversationId="c1" />);
    expect(screen.getByText('这个对话没有指定专家团。')).toBeInTheDocument();
  });
});
